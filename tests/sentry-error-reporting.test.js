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
const { scrubSentryEvent, sentryEnabled, sentryOptions, withOptionalSentry } = await import("../worker/sentry.js");

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

// Captures what the Sentry transport would send, without any network.
async function withCapturedSentryTraffic(run) {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("sentry.invalid")) {
      sent.push({ url, body: typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body) });
      return new Response("{}", { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent;
}

test("SENTRY_DSN gates error reporting: unset or blank means off", () => {
  assert.equal(sentryEnabled({}), false);
  assert.equal(sentryEnabled(undefined), false);
  assert.equal(sentryEnabled({ SENTRY_DSN: "" }), false);
  assert.equal(sentryEnabled({ SENTRY_DSN: "   " }), false);
  assert.equal(sentryEnabled({ SENTRY_DSN: TEST_DSN }), true);
});

test("Sentry options keep PII off and tracing at zero", () => {
  const options = sentryOptions({ SENTRY_DSN: TEST_DSN });
  assert.equal(options.dsn, TEST_DSN);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(typeof options.beforeSend, "function");
});

test("with no DSN the wrapper is a no-op: original handlers get the exact env and ctx", async () => {
  const calls = [];
  const handler = {
    async fetch(request, env, ctx) {
      calls.push({ name: "fetch", request, env, ctx });
      return new Response("plain");
    },
    async scheduled(event, env, ctx) {
      calls.push({ name: "scheduled", event, env, ctx });
    },
    async queue(batch, env, ctx) {
      calls.push({ name: "queue", batch, env, ctx });
    },
  };
  const wrapped = withOptionalSentry(handler);
  const env = { SOME_BINDING: {} };
  const ctx = fakeCtx();
  const request = new Request("https://siterep.test/");

  const response = await wrapped.fetch(request, env, ctx);
  await wrapped.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await wrapped.queue({ messages: [] }, env, ctx);

  assert.equal(await response.text(), "plain");
  assert.deepEqual(calls.map((call) => call.name), ["fetch", "scheduled", "queue"]);
  for (const call of calls) {
    assert.equal(call.env, env, `${call.name} must receive the original env object`);
    assert.equal(call.ctx, ctx, `${call.name} must receive the original ctx object`);
  }
  assert.equal(calls[0].request, request);
});

test("the Worker export still exposes fetch and scheduled and serves requests with no DSN", async () => {
  assert.equal(typeof worker.fetch, "function");
  assert.equal(typeof worker.scheduled, "function");

  const ctx = fakeCtx();
  const response = await worker.fetch(new Request("https://siterep.net/api/health/live"), {}, ctx);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.runtime, "cloudflare-worker");

  // No bindings: every cron task skips or fails softly, and the handler still
  // hands its work to waitUntil exactly as before.
  await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, {}, ctx);
  assert.ok(ctx.pending.length >= 1, "scheduled work must still run through ctx.waitUntil");
  await ctx.settle();
});

test("the Worker export is wrapped with the Sentry SDK and the compat flag it needs is set", async () => {
  const source = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(source, /export default withOptionalSentry\(workerHandler/);
  const sentrySource = await readFile(new URL("../worker/sentry.js", import.meta.url), "utf8");
  assert.match(sentrySource, /from "@sentry\/cloudflare"/);
  assert.match(sentrySource, /withSentry\(sentryOptions/);
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"compatibility_flags":\s*\[[^\]]*"nodejs_(als|compat)"/);
});

test("with a DSN, a fetch error caught by the Worker is reported and the visitor still gets a 500", async () => {
  const leakyEmail = "visitor.lead@example.com";
  const env = {
    SENTRY_DSN: TEST_DSN,
    ASSETS: {
      fetch: async () => {
        throw new Error(`asset failure for ${leakyEmail}`);
      },
    },
  };
  const ctx = fakeCtx();
  let response;
  const sent = await withCapturedSentryTraffic(async () => {
    response = await worker.fetch(
      new Request(`https://siterep.net/?email=${leakyEmail}`, { headers: { cookie: "session=secret" } }),
      env,
      ctx,
    );
    await ctx.settle();
  });

  assert.equal(response.status, 500);
  const errorEnvelopes = sent.filter((entry) => entry.body.includes('"type":"event"'));
  assert.equal(errorEnvelopes.length, 1, "exactly one error event must be sent");
  const payload = errorEnvelopes[0].body;
  assert.match(payload, /asset failure for \[email\]/);
  assert.doesNotMatch(payload, /visitor\.lead@example\.com/);
  assert.doesNotMatch(payload, /session=secret/);
  assert.doesNotMatch(payload, /\?email=/);
});

test("with a DSN, a failing cron task is reported before the invocation ends", async () => {
  // recoverStuckPaidActivations touches the payments DB; a binding that throws
  // makes that task fail while the rest of the cron run carries on.
  const env = {
    SENTRY_DSN: TEST_DSN,
    CITEREP_ADMIN_KEY: "test-admin-key",
    SITEREP_PAYMENTS_DB: {
      prepare() {
        throw new Error("payments db unavailable");
      },
      batch() {
        throw new Error("payments db unavailable");
      },
      exec() {
        throw new Error("payments db unavailable");
      },
    },
  };
  const ctx = fakeCtx();
  const sent = await withCapturedSentryTraffic(async () => {
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env, ctx);
    await ctx.settle();
  });
  const errorEnvelopes = sent.filter((entry) => entry.body.includes('"type":"event"'));
  assert.ok(errorEnvelopes.length >= 1, "the failing cron task must reach Sentry");
  assert.ok(errorEnvelopes.some((entry) => entry.body.includes("payments db unavailable")));
});

test("beforeSend strips request bodies, cookies, headers, query strings, users, and emails", () => {
  const event = {
    message: "Lead from jane@example.com failed",
    user: { email: "jane@example.com", ip_address: "203.0.113.9" },
    request: {
      method: "POST",
      url: "https://siterep.net/api/public/lead?email=jane@example.com",
      data: '{"email":"jane@example.com","name":"Jane"}',
      cookies: { session: "secret" },
      headers: { cookie: "session=secret", "x-citerep-admin-key": "k" },
      query_string: "email=jane@example.com",
    },
    breadcrumbs: [{ category: "fetch", message: "POST to jane@example.com", data: { body: "jane@example.com" } }],
    extra: { nested: { contact: "Reach me at jane@example.com" } },
    exception: { values: [{ type: "Error", value: "bad lead jane@example.com" }] },
  };
  const scrubbed = scrubSentryEvent(event);

  assert.equal(scrubbed.user, undefined);
  assert.deepEqual(scrubbed.request, { method: "POST", url: "https://siterep.net/api/public/lead" });
  assert.equal(scrubbed.breadcrumbs[0].data, undefined);
  assert.equal(scrubbed.message, "Lead from [email] failed");
  assert.equal(scrubbed.exception.values[0].value, "bad lead [email]");
  assert.equal(scrubbed.extra.nested.contact, "Reach me at [email]");
  assert.doesNotMatch(JSON.stringify(scrubbed), /jane@example\.com|secret/);
});
