import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

// The worker bundle imports "cloudflare:workers"; Node has no Workers runtime, so this shim must be registered before the worker module loads.
registerHooks({
  load(url, context, nextLoad) {
    if (url === "cloudflare:workers") {
      return {
        format: "module",
        source: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: worker } = await import("../worker/index.js");
const {
  createEventCap,
  MAX_EVENTS_PER_WINDOW,
  redactPath,
  resetSentryEventCap,
  scrubBreadcrumb,
  scrubSentryEvent,
  sentryEnabled,
  sentryOptions,
} = await import("../worker/sentry.js");

const TEST_DSN = "https://publickey@sentry.invalid/42";

function fakeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    settle: () => Promise.allSettled(pending),
  };
}

// Records every outbound fetch the Worker makes, answering Sentry envelope
// posts locally so nothing touches the network.
async function withCapturedTraffic(run) {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init.body == null ? "" : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
    sent.push({ url, body });
    if (url.includes("sentry.invalid")) return new Response("{}", { status: 200 });
    return originalFetch(input, init);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent;
}

const errorEventsIn = (sent) => sent.filter((entry) => entry.url.includes("sentry.invalid") && entry.body.includes('"type":"event"'));

function failingAssetsEnv(extra = {}, makeError = () => new Error("asset failure")) {
  return {
    ...extra,
    ASSETS: {
      fetch: async () => {
        throw makeError();
      },
    },
  };
}

// A payments DB whose calls fail only after a real timer tick, so a cron
// handler that does not await its work returns before the failure happens.
function slowFailingPaymentsDb(state) {
  const fail = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.failed = true;
    throw new Error("payments db unavailable");
  };
  const statement = () => ({ bind: () => statement(), all: fail, run: fail, first: fail, raw: fail });
  return { prepare: statement, batch: fail, exec: fail };
}

test("SENTRY_DSN gates error reporting: unset or blank means off", () => {
  assert.equal(sentryEnabled({}), false);
  assert.equal(sentryEnabled(undefined), false);
  assert.equal(sentryEnabled({ SENTRY_DSN: "" }), false);
  assert.equal(sentryEnabled({ SENTRY_DSN: "   " }), false);
  assert.equal(sentryEnabled({ SENTRY_DSN: TEST_DSN }), true);
});

test("Sentry options use the SDK off switch and keep PII, tracing, and console breadcrumbs off", () => {
  assert.equal(sentryOptions({}).enabled, false);
  assert.equal(sentryOptions({ SENTRY_DSN: "  " }).enabled, false);
  const options = sentryOptions({ SENTRY_DSN: TEST_DSN });
  assert.equal(options.enabled, true);
  assert.equal(options.dsn, TEST_DSN);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, 0);
  assert.deepEqual(options.tracePropagationTargets, []);
  assert.equal(typeof options.beforeSend, "function");
  assert.equal(typeof options.beforeBreadcrumb, "function");
  const kept = options.integrations([{ name: "Console" }, { name: "HttpServer" }, { name: "Dedupe" }, { name: "LinkedErrors" }]);
  assert.deepEqual(kept.map((integration) => integration.name), ["Dedupe", "LinkedErrors"]);
});

test("the Worker export is withSentry with the options callback, and the compat flag the SDK needs is set", async () => {
  const source = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(source, /export default withSentry\(sentryOptions, workerHandler\);/);
  assert.doesNotMatch(source, /withOptionalSentry/);
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  // @sentry/cloudflare needs AsyncLocalStorage for its per-request scopes.
  assert.match(config, /"compatibility_flags":\s*\[[^\]]*"nodejs_(als|compat)"/);
});

test("with no DSN the Worker serves requests and sends nothing, even when a request fails", async () => {
  assert.equal(typeof worker.fetch, "function");
  assert.equal(typeof worker.scheduled, "function");
  resetSentryEventCap();

  let health;
  let failed;
  const ctx = fakeCtx();
  const sent = await withCapturedTraffic(async () => {
    health = await worker.fetch(new Request("https://siterep.net/api/health/live"), {}, ctx);
    failed = await worker.fetch(new Request("https://siterep.net/"), failingAssetsEnv(), ctx);
    await ctx.settle();
  });

  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.ok, true);
  assert.equal(body.runtime, "cloudflare-worker");
  assert.equal(failed.status, 500);
  assert.deepEqual(sent, [], "no outbound request of any kind with no DSN");
});

for (const mode of ["no DSN", "a DSN"]) {
  test(`with ${mode}, cron work is awaited by the scheduled handler itself`, async () => {
    resetSentryEventCap();
    const state = { failed: false };
    const env = {
      ...(mode === "a DSN" ? { SENTRY_DSN: TEST_DSN } : {}),
      CITEREP_ADMIN_KEY: "test-admin-key",
      SITEREP_PAYMENTS_DB: slowFailingPaymentsDb(state),
    };
    const ctx = fakeCtx();
    const sent = await withCapturedTraffic(async () => {
      await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env, ctx);
      // Checked before ctx.waitUntil work settles: the cron run is already done.
      assert.equal(state.failed, true, "the failing task must have run before scheduled() resolved");
      await ctx.settle();
    });
    if (mode === "a DSN") {
      const events = errorEventsIn(sent);
      assert.ok(events.length >= 1, "the failing cron task must reach Sentry");
      assert.ok(events.some((entry) => entry.body.includes("payments db unavailable")));
    } else {
      assert.deepEqual(sent, []);
    }
  });
}

test("with a DSN, a fetch error is reported scrubbed and the visitor still gets a 500", async () => {
  resetSentryEventCap();
  const leakyEmail = "visitor.lead@example.com";
  const ctx = fakeCtx();
  let response;
  const sent = await withCapturedTraffic(async () => {
    const env = failingAssetsEnv({ SENTRY_DSN: TEST_DSN }, () => {
      // An existing log line that prints a lead must not become a breadcrumb.
      console.warn(`lead from Jane Visitor, call +1 415 555 0134, ${leakyEmail}`);
      return new Error(`asset failure for ${leakyEmail} at +1 415 555 0134`);
    });
    response = await worker.fetch(
      new Request(`https://siterep.net/?email=${leakyEmail}`, { headers: { cookie: "session=secret" } }),
      env,
      ctx,
    );
    await ctx.settle();
  });

  assert.equal(response.status, 500);
  const events = errorEventsIn(sent);
  assert.equal(events.length, 1, "exactly one error event must be sent");
  const payload = events[0].body;
  assert.match(payload, /asset failure for \[email\] at \[number\]/);
  assert.match(payload, /"stacktrace"/);
  assert.doesNotMatch(payload, /visitor\.lead@example\.com/);
  assert.doesNotMatch(payload, /Jane Visitor|555 0134/);
  assert.doesNotMatch(payload, /"category":"console"/);
  assert.doesNotMatch(payload, /session=secret/);
  assert.doesNotMatch(payload, /\?email=/);
});

test("with a DSN, a 500 storm sends at most the per-isolate cap of events", async () => {
  resetSentryEventCap();
  const ctx = fakeCtx();
  const storm = MAX_EVENTS_PER_WINDOW + 10;
  const statuses = [];
  const sent = await withCapturedTraffic(async () => {
    for (let i = 0; i < storm; i += 1) {
      const env = failingAssetsEnv({ SENTRY_DSN: TEST_DSN }, () => new Error(`storm failure ${i}`));
      statuses.push((await worker.fetch(new Request("https://siterep.net/"), env, ctx)).status);
    }
    await ctx.settle();
  });
  assert.deepEqual(new Set(statuses), new Set([500]), "every request still gets its 500");
  assert.equal(errorEventsIn(sent).length, MAX_EVENTS_PER_WINDOW);
  resetSentryEventCap();
});

test("the event cap allows a fixed number per window and opens again in the next window", () => {
  let now = 1_000;
  const cap = createEventCap({ max: 3, windowMs: 60_000, now: () => now });
  assert.deepEqual([cap.allow(), cap.allow(), cap.allow(), cap.allow()], [true, true, true, false]);
  now += 59_999;
  assert.equal(cap.allow(), false);
  now += 1;
  assert.deepEqual([cap.allow(), cap.allow(), cap.allow(), cap.allow()], [true, true, true, false]);
});

test("beforeSend keeps exception type and stack and drops request data, user, extra, contexts, and breadcrumb text", () => {
  const stacktrace = { frames: [{ filename: "worker/index.js", function: "fetch", lineno: 1200 }] };
  const event = {
    event_id: "0123456789abcdef0123456789abcdef",
    message: "Lead from jane@example.com, phone (415) 555-0134",
    transaction: "GET /api/bots/acme-dental",
    user: { email: "jane@example.com", ip_address: "203.0.113.9" },
    request: {
      method: "POST",
      url: "https://siterep.net/api/v1/bots/acme-dental/leads?email=jane@example.com",
      data: '{"email":"jane@example.com","name":"Jane"}',
      cookies: { session: "secret" },
      headers: { cookie: "session=secret", "x-citerep-admin-key": "k" },
      query_string: "email=jane@example.com",
    },
    breadcrumbs: [
      { category: "console", level: "warning", message: "lead Jane Visitor" },
      { category: "fetch", type: "http", message: "POST to jane@example.com", data: { method: "POST", url: "https://api.example.net/v1/x?token=abc", status_code: 500, body: "Jane" } },
      { category: "custom", message: "visitor asked about Jane's appointment" },
    ],
    extra: { nested: { contact: "Jane Visitor" } },
    contexts: {
      runtime: { name: "cloudflare" },
      cloud_resource: { "cloud.provider": "cloudflare" },
      culture: { timezone: "America/Los_Angeles" },
      trace: { trace_id: "t1", span_id: "s1", data: { "url.full": "https://siterep.net/?email=jane@example.com" } },
      lead: { name: "Jane Visitor" },
    },
    exception: { values: [{ type: "TypeError", value: "bad lead jane@example.com", stacktrace, mechanism: { type: "generic", handled: true, data: { x: 1 } } }] },
  };
  const scrubbed = scrubSentryEvent(event);

  assert.equal(scrubbed.event_id, event.event_id);
  assert.equal(scrubbed.user, undefined);
  assert.equal(scrubbed.extra, undefined);
  assert.deepEqual(scrubbed.request, { method: "POST", url: "https://siterep.net/api/v1/bots/:botId/leads" });
  assert.equal(scrubbed.transaction, "GET /api/bots/:botId");
  assert.equal(scrubbed.message, "Lead from [email], phone [number]");
  assert.deepEqual(scrubbed.contexts, {
    runtime: { name: "cloudflare", version: undefined },
    cloud_resource: { "cloud.provider": "cloudflare" },
    trace: { trace_id: "t1", span_id: "s1" },
  });
  assert.deepEqual(scrubbed.breadcrumbs, [
    { category: "fetch", type: "http", data: { method: "POST", status_code: 500, url: "https://api.example.net" } },
    { category: "custom" },
  ]);
  assert.deepEqual(scrubbed.exception.values[0], {
    type: "TypeError",
    value: "bad lead [email]",
    stacktrace,
    mechanism: { type: "generic", handled: true },
  });
  assert.doesNotMatch(JSON.stringify(scrubbed), /jane@example\.com|Jane|secret|acme-dental|token=|555/);
});

test("beforeBreadcrumb drops console breadcrumbs and message text", () => {
  assert.equal(scrubBreadcrumb({ category: "console", message: "lead Jane" }), null);
  assert.deepEqual(scrubBreadcrumb({ category: "app", level: "info", message: "Jane asked a question" }), { category: "app", level: "info" });
});

test("values past the scrub depth limit are dropped, not returned raw", () => {
  let deep = { email: "deep@example.com" };
  for (let i = 0; i < 20; i += 1) deep = { child: deep };
  const scrubbed = scrubSentryEvent({ tags: { deep } });
  assert.doesNotMatch(JSON.stringify(scrubbed), /deep@example\.com/);
  assert.match(JSON.stringify(scrubbed), /\[depth limit\]/);
});

test("request paths redact bot ids, developer API ids, and id- or token-shaped segments", () => {
  const cases = [
    ["/api/bots/acme-dental", "/api/bots/:botId"],
    ["/api/bots/status", "/api/bots/status"],
    ["/api/bots/create", "/api/bots/create"],
    ["/api/v1/bots/acme-dental", "/api/v1/bots/:botId"],
    ["/api/v1/bots/acme-dental/conversations", "/api/v1/bots/:botId/conversations"],
    ["/api/v1/bots/acme-dental/whatever", "/api/v1/bots/:botId/:id"],
    ["/api/export/leads.csv", "/api/export/leads.csv"],
    ["/api/notifications/unsubscribe", "/api/notifications/unsubscribe"],
    ["/assets/index-B1x2Yz.js", "/assets/index-B1x2Yz.js"],
    ["/api/x/unsub_0123456789abcdef0123456789abcdef", "/api/x/:id"],
    ["/api/x/sr_live_abcdef0123", "/api/x/:id"],
    ["/r/3f2b6c1e-8a4d-4e7b-9c0d-1a2b3c4d5e6f", "/r/:id"],
    ["/order/12345678", "/order/:id"],
    ["/u/jane%40example.com", "/u/:id"],
    ["/", "/"],
  ];
  for (const [input, expected] of cases) assert.equal(redactPath(input), expected, input);
});
