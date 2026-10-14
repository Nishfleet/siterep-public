import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

// The worker bundle imports "cloudflare:workers"; Node has no Workers runtime, so this shim must be registered before the worker module loads.
registerHooks({
  load(url, context, nextLoad) {
    if (url === "cloudflare:workers") {
      return {
        format: "module",
        source:
          "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { CiteRepCoordinator } = await import("../worker/index.js");

const NOW = new Date().toISOString();
const INGEST_ROUTE = new Request("https://siterep.test/api/internal/notifications/process", {
  method: "POST",
  headers: { "x-citerep-admin-key": "test-admin-key" },
});

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => {
      if (typeof key === "object" && key !== null) {
        for (const [innerKey, innerValue] of Object.entries(key)) map.set(innerKey, innerValue);
      } else {
        map.set(key, value);
      }
    },
    delete: async (key) => map.delete(key),
    list: async ({ prefix = "" } = {}) =>
      new Map([...map.entries()].filter(([entryKey]) => entryKey.startsWith(prefix))),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    _map: map,
  };
}

function baseEnv(overrides = {}) {
  return {
    DODO_SITEREP_API_KEY: "dodo_test_key",
    DODO_SITEREP_ENVIRONMENT: "test",
    SITEREP_OVERAGE_BILLING_ENABLED: "true",
    CITEREP_ADMIN_KEY: "test-admin-key",
    CITEREP_STORE: null,
    ...overrides,
  };
}

function makeBot(botId, { customerId = "cus_test_1", pendingIds = ["ov_1", "ov_2"] } = {}) {
  return {
    botId,
    publicKey: "pk_test",
    ownerAccessKey: "ak_test",
    label: botId,
    ownerEmail: "owner@example.com",
    plan: "Pro",
    lifecycleStatus: "live",
    siteUrl: "https://example.com",
    createdAt: NOW,
    updatedAt: NOW,
    sources: [],
    leads: [],
    conversations: [],
    unknowns: [],
    escalations: [],
    tickets: [],
    notifications: [],
    leadRules: { triggers: {}, webhookUrl: "" },
    integrationSettings: { enabledEvents: [], webhooks: [], nativeTargets: [] },
    actionQueue: [],
    payments: [],
    billing: { provider: "dodo", customerId },
    events: [],
    installs: [],
    allowedOrigins: ["https://example.com"],
    routingProfile: "frugal",
    retrieval: {},
    abuseProtection: {},
    widgetSettings: {},
    responseCount: 12000,
    responseUsageMonth: NOW.slice(0, 7),
    overage: {
      enabled: true,
      maxExtraPerMonth: 10000,
      pending: pendingIds.map((id) => ({ id, conversationId: `conv_${id}`, createdAt: NOW })),
    },
    trainingRuns: [],
    crawlJobs: [],
    sourceSync: {},
  };
}

async function driveFlush({ bots = { bot1: makeBot("bot1") }, env = baseEnv(), fetchImpl }) {
  const storage = fakeStorage({ store: { bots } });
  const coordinator = new CiteRepCoordinator({ storage }, env);
  let fetchCalls = 0;
  const capture = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls += 1;
    const payload = init?.body ? JSON.parse(init.body) : null;
    capture.push(payload);
    return fetchImpl(url, init, payload);
  };
  const response = await coordinator.fetch(INGEST_ROUTE);
  const body = await response.json();
  const pendingById = (botId) => {
    const record = storage._map.get(`store:bot:${botId}`);
    return Array.isArray(record?.overage?.pending)
      ? record.overage.pending.map((event) => event.id)
      : [];
  };
  return { http: response.status, body, fetchCalls, capture, pendingById };
}

test("ingest network failure keeps every queued overage event for retry", async () => {
  const { http, body, fetchCalls, pendingById } = await driveFlush({
    bots: { bot1: makeBot("bot1", { pendingIds: ["ov_1", "ov_2"] }) },
    fetchImpl: async () => {
      throw new Error("Dodo unavailable");
    },
  });

  assert.equal(http, 200);
  assert.deepEqual(body.overage, { skipped: false, sent: 0, failed: 2 });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(pendingById("bot1"), ["ov_1", "ov_2"]);
});

test("ingest HTTP error keeps every queued overage event for retry", async () => {
  const { body, fetchCalls, pendingById } = await driveFlush({
    bots: { bot1: makeBot("bot1", { pendingIds: ["ov_1", "ov_2", "ov_3"] }) },
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });

  assert.deepEqual(body.overage, { skipped: false, sent: 0, failed: 3 });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(pendingById("bot1"), ["ov_1", "ov_2", "ov_3"]);
});

test("successful ingest sends every queued event and removes exactly the delivered ids", async () => {
  const { body, fetchCalls, capture, pendingById } = await driveFlush({
    bots: { bot1: makeBot("bot1", { pendingIds: ["ov_1", "ov_2", "ov_3"] }) },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(body.overage, { skipped: false, sent: 3, failed: 0 });
  const payload = capture[0];
  assert.deepEqual(
    payload.events.map((event) => event.event_id),
    ["ov_1", "ov_2", "ov_3"],
  );
  for (const event of payload.events) {
    assert.equal(event.event_name, "siterep_overage_answer");
    assert.equal(event.customer_id, "cus_test_1");
    assert.equal(event.metadata.bot_id, "bot1");
  }
  assert.deepEqual(pendingById("bot1"), []);
});

test("mixed ingest results remove only the delivered bot's events; failures stay queued", async () => {
  const { body, capture, pendingById } = await driveFlush({
    bots: {
      bot1: makeBot("bot1", { customerId: "cus_ok", pendingIds: ["ov_1", "ov_2"] }),
      bot2: makeBot("bot2", { customerId: "cus_down", pendingIds: ["ov_3", "ov_4"] }),
    },
    fetchImpl: async (_url, _init, payload) => {
      if (payload.events[0].customer_id === "cus_down") throw new Error("Dodo down for bot2");
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });

  assert.deepEqual(body.overage, { skipped: false, sent: 2, failed: 2 });
  assert.deepEqual(pendingById("bot1"), []);
  assert.deepEqual(pendingById("bot2"), ["ov_3", "ov_4"]);
  assert.deepEqual(
    capture.map((payload) => payload.events.map((event) => event.event_id)),
    [
      ["ov_1", "ov_2"],
      ["ov_3", "ov_4"],
    ],
  );
});

test("billing flag off touches no queue and never calls Dodo", async () => {
  const { body, fetchCalls, pendingById } = await driveFlush({
    bots: { bot1: makeBot("bot1") },
    env: baseEnv({ SITEREP_OVERAGE_BILLING_ENABLED: "" }),
    fetchImpl: async () => {
      throw new Error("Dodo must not be called when billing is disabled");
    },
  });

  assert.deepEqual(body.overage, { skipped: true, reason: "billing_disabled" });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(pendingById("bot1"), ["ov_1", "ov_2"]);
});

test("missing Dodo API key touches no queue and never calls Dodo", async () => {
  const { body, fetchCalls, pendingById } = await driveFlush({
    bots: { bot1: makeBot("bot1") },
    env: baseEnv({ DODO_SITEREP_API_KEY: "", DODO_PAYMENTS_API_KEY: "", DODO_API_KEY: "" }),
    fetchImpl: async () => {
      throw new Error("Dodo must not be called without an API key");
    },
  });

  assert.deepEqual(body.overage, { skipped: true, reason: "no_api_key" });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(pendingById("bot1"), ["ov_1", "ov_2"]);
});
