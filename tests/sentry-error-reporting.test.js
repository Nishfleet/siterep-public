import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

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
const { ROUTE_SEGMENTS } = await import("../worker/sentry-route-segments.js");
const {
  redactPath,
  safeMessage,
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
  assert.equal("tracesSampleRate" in options, false);
  assert.deepEqual(options.tracePropagationTargets, []);
  assert.equal(typeof options.beforeSend, "function");
  assert.equal(typeof options.beforeBreadcrumb, "function");
  assert.equal(options.beforeSendTransaction({ type: "transaction", transaction: "GET /bots/acme?email=a@b.co" }), null);
  assert.equal(options.environment, "development");
  assert.equal(sentryOptions({ SENTRY_DSN: TEST_DSN, SITEREP_RELEASE_DEPLOYED_AT: "2026-10-15T00:00:00Z" }).environment, "production");
  assert.equal(sentryOptions({ SENTRY_DSN: TEST_DSN, SENTRY_ENVIRONMENT: "staging" }).environment, "staging");
  const kept = options.integrations([{ name: "Console" }, { name: "HttpServer" }, { name: "Dedupe" }, { name: "LinkedErrors" }]);
  assert.deepEqual(kept.map((integration) => integration.name), ["Dedupe", "LinkedErrors"]);
});

test("the Worker export is withSentry with the options callback, and the compat flag the SDK needs is set", async () => {
  const source = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(source, /export default withSentry\(sentryOptions, workerHandler\);/);
  assert.doesNotMatch(source, /withOptionalSentry/);
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"compatibility_flags":\s*\[[^\]]*"nodejs_(als|compat)"/);
});

test("with no DSN the Worker serves requests and sends nothing, even when a request fails", async () => {
  assert.equal(typeof worker.fetch, "function");
  assert.equal(typeof worker.scheduled, "function");

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
    const state = { failed: false };
    const env = {
      ...(mode === "a DSN" ? { SENTRY_DSN: TEST_DSN } : {}),
      CITEREP_ADMIN_KEY: "test-admin-key",
      SITEREP_PAYMENTS_DB: slowFailingPaymentsDb(state),
    };
    const ctx = fakeCtx();
    const sent = await withCapturedTraffic(async () => {
      await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env, ctx);
      assert.equal(state.failed, true, "the failing task must have run before scheduled() resolved");
      await ctx.settle();
    });
    if (mode === "a DSN") {
      const events = errorEventsIn(sent);
      assert.ok(events.length >= 1, "the failing cron task must reach Sentry");
      assert.ok(events.some((entry) => /"value":"\[message withheld\]"/.test(entry.body) && entry.body.includes('"stacktrace"')));
    } else {
      assert.deepEqual(sent, []);
    }
  });
}

test("with a DSN, a fetch error is reported scrubbed and the visitor still gets a 500", async () => {
  const leakyEmail = "visitor.lead@example.com";
  const ctx = fakeCtx();
  let response;
  const sent = await withCapturedTraffic(async () => {
    const env = failingAssetsEnv({ SENTRY_DSN: TEST_DSN }, () => {
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
  assert.match(payload, /"type":"Error","value":"\[message withheld\]"/);
  assert.match(payload, /"stacktrace"/);
  assert.doesNotMatch(payload, /asset failure/);
  assert.doesNotMatch(payload, /visitor\.lead@example\.com/);
  assert.doesNotMatch(payload, /Jane Visitor|555 0134/);
  assert.doesNotMatch(payload, /"category":"console"/);
  assert.doesNotMatch(payload, /session=secret/);
  assert.doesNotMatch(payload, /\?email=/);
});

test("beforeSend keeps exception type and stack and drops request data, user, extra, contexts, and breadcrumb text", () => {
  const stacktrace = { frames: [{ filename: "worker/index.js", function: "fetch", lineno: 1200 }] };
  const event = {
    event_id: "0123456789abcdef0123456789abcdef",
    message: "Lead from Jane Visitor, phone (415) 555-0134",
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
    tags: { note: "call (415) 555-0134 or jane@example.com" },
    exception: {
      values: [
        { type: "Error", value: "Payment was not found.", stacktrace },
        { type: "TypeError", value: "bad lead Jane Visitor wants a refund", stacktrace, mechanism: { type: "generic", handled: true, data: { x: 1 } } },
      ],
    },
  };
  const scrubbed = scrubSentryEvent(event);

  assert.equal(scrubbed.event_id, event.event_id);
  assert.equal(scrubbed.user, undefined);
  assert.equal(scrubbed.extra, undefined);
  assert.deepEqual(scrubbed.request, { method: "POST", url: "https://siterep.net/api/v1/bots/:id/leads" });
  assert.equal(scrubbed.transaction, "GET /api/bots/:id");
  assert.equal(scrubbed.message, "[message withheld]");
  assert.deepEqual(scrubbed.tags, { note: "call [number] or [email]" });
  assert.deepEqual(scrubbed.contexts, {
    runtime: { name: "cloudflare", version: undefined },
    cloud_resource: { "cloud.provider": "cloudflare" },
    trace: { trace_id: "t1", span_id: "s1" },
  });
  assert.deepEqual(scrubbed.breadcrumbs, [
    { category: "fetch", type: "http", data: { method: "POST", status_code: 500 } },
    { category: "custom" },
  ]);
  assert.deepEqual(scrubbed.exception.values, [
    { type: "Error", value: "Payment was not found.", stacktrace },
    { type: "TypeError", value: "[message withheld]", stacktrace, mechanism: { type: "generic", handled: true } },
  ]);
  assert.doesNotMatch(JSON.stringify(scrubbed), /jane@example\.com|Jane|secret|acme-dental|token=|555|example\.net/);
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

test("request paths keep only literal route segments; slugs, ids and tokens become :id", () => {
  const cases = [
    ["/api/bots/acme-dental", "/api/bots/:id"],
    ["/api/bots/status", "/api/bots/status"],
    ["/api/v1/bots/acme-dental/conversations", "/api/v1/bots/:id/conversations"],
    ["/api/widget/acme-dental", "/api/widget/:id"],
    ["/api/public/acme-dental/chat", "/api/public/:id/chat"],
    ["/api/export/acme-dental/leads.csv", "/api/export/:id/leads.csv"],
    ["/api/mcp/acme-dental", "/api/mcp/:id"],
    ["/acme-dental", "/:id"],
    ["/api/export/leads.csv", "/api/export/leads.csv"],
    ["/api/notifications/unsubscribe", "/api/notifications/unsubscribe"],
    ["/api/x/unsub_0123456789abcdef0123456789abcdef", "/api/:id/:id"],
    ["/assets/index-B1x2Yz.js", "/assets/:id"],
    ["/u/jane%40example.com", "/:id/:id"],
    ["/", "/"],
  ];
  for (const [input, expected] of cases) assert.equal(redactPath(input), expected, input);
});

test("the path allowlist is exactly the literal segments of the route strings in worker/index.js", async () => {
  const source = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const fromRouter = new Set();
  for (const match of source.matchAll(/["`](\/[A-Za-z0-9._~\/-]*)["`?]/g)) {
    for (const segment of match[1].split("/")) if (segment) fromRouter.add(segment);
  }
  const missing = [...fromRouter].filter((segment) => !ROUTE_SEGMENTS.has(segment));
  const extra = [...ROUTE_SEGMENTS].filter((segment) => !fromRouter.has(segment));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, "update worker/sentry-route-segments.js to match the router");
});

test("exception messages go out only in a known safe shape", () => {
  const kept = [
    "Payment ledger is not configured yet.",
    "Dodo checkout returned 502.",
    "Dodo product is not configured for Starter.",
    "Razorpay is missing keys, currency, or RAZORPAY_AGENCY_AMOUNT_SUBUNITS.",
    "Network connection lost.",
    "D1_ERROR: UNIQUE constraint failed: payment_links.reference_id: SQLITE_CONSTRAINT",
    "D1_ERROR: no such table: dodo_checkout_sessions",
  ];
  for (const message of kept) assert.equal(safeMessage(message), message, message);
  const reshaped = [
    ["Cannot read properties of undefined (reading 'botId')", "Cannot read properties of undefined (reading '[key]')"],
    ["Cannot set properties of null (setting 'Jane Visitor')", "Cannot set properties of null (setting '[key]')"],
    ["Cannot read properties of undefined (reading 'it's Jane')", "Cannot read properties of undefined (reading '[key]')"],
    ["store.bots.map is not a function", "[expression] is not a function"],
    ["handlers[Jane Visitor] is not a function", "[expression] is not a function"],
    ["Jane is not defined", "[expression] is not defined"],
  ];
  for (const [message, expected] of reshaped) assert.equal(safeMessage(message), expected, message);
  const withheld = [
    "lead from Jane Visitor",
    "Dodo checkout returned Jane Visitor.",
    `Unexpected token 'J', "Jane Visitor" is not valid JSON`,
    "Cannot create property 'x' on string 'Jane Visitor'",
    "D1_TYPE_ERROR: Type 'object' not supported for value 'Jane'",
    "Payment was not found. Jane",
    "Dodo product is not configured for Jane.",
    "Razorpay is missing keys, currency, or JANE_VISITOR.",
  ];
  for (const message of withheld) assert.equal(safeMessage(message), "[message withheld]", message);
});

test("stack frames keep their locations intact and lose any source lines", () => {
  const frame = {
    filename: "/assets/index-20261015123456.js",
    module: "index-20261015123456",
    abs_path: "https://siterep.net/assets/index-20261015123456.js",
    function: "fetch",
    lineno: 12345678,
    context_line: "const lead = 'Jane Visitor';",
    pre_context: ["// call (415) 555-0134"],
    post_context: ["return lead;"],
    vars: { lead: "Jane Visitor" },
  };
  const scrubbed = scrubSentryEvent({ exception: { values: [{ type: "Error", value: "fetch failed", stacktrace: { frames: [frame] } }] } });
  assert.deepEqual(scrubbed.exception.values[0].stacktrace.frames[0], {
    filename: frame.filename,
    module: frame.module,
    abs_path: frame.abs_path,
    function: "fetch",
    lineno: 12345678,
  });
});
