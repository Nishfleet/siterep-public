import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

// The worker entry imports `cloudflare:workers`, which only exists inside the
// Workers runtime. Serve a minimal DurableObject stub for that one specifier so
// the REAL handler in worker/index.js — recordConversation, driven through the
// POST /api/chat route of the exported CiteRepCoordinator — runs here in Node
// with stubbed storage, exactly as the sibling behavioral tests (payment,
// usage, overage) drive their extracted modules. This is a behavior test of
// customer-visible money behavior, not a source-shape check.
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

// Durable Object storage shim: get/put/delete/list over an in-memory Map.
// put() accepts both (key, value) and the object-map form the worker uses.
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
    list: async ({ prefix = "" } = {}) => new Map([...map.entries()].filter(([entryKey]) => entryKey.startsWith(prefix))),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    _map: map,
  };
}

const SOURCE_CONTENT =
  "The Pro plan costs 59 dollars per month and includes 12000 responses each month. The Growth plan costs 29 dollars per month.";

function seedBot(botId, { plan = "Starter", sources = [], count = 0 } = {}) {
  return {
    botId,
    publicKey: "pk_test",
    ownerAccessKey: "ak_test",
    label: botId,
    ownerEmail: "owner@example.com",
    plan,
    lifecycleStatus: "live",
    siteUrl: "https://example.com",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sources,
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
    billing: { provider: "", customerId: "" },
    events: [],
    installs: [],
    allowedOrigins: ["https://example.com"],
    routingProfile: "frugal",
    retrieval: {},
    abuseProtection: {},
    widgetSettings: {},
    responseCount: count,
    responseUsageMonth: "",
    trainingRuns: [],
    crawlJobs: [],
    sourceSync: {},
  };
}

function defaultSources() {
  return [
    {
      id: "s1",
      title: "Pro Plan",
      url: "https://example.com/pro",
      excerpt: "Pro pricing",
      content: SOURCE_CONTENT,
      status: "indexed",
      sourceType: "manual",
      indexedAt: new Date().toISOString(),
    },
  ];
}

// Boot the real coordinator with a seeded store, and POST to the real /api/chat
// route. Every request round-trips through updateStore → Durable Object storage
// writes, so the persisted bot record is the ground truth for the count.
async function bootBot(botId, options = {}) {
  const { CiteRepCoordinator } = await import("../worker/index.js");
  const storage = fakeStorage({
    store: { bots: { [botId]: seedBot(botId, options) } },
  });
  const coordinator = new CiteRepCoordinator({ storage }, { CITEREP_ADMIN_KEY: "test-admin-key" });
  const ask = async (question) => {
    const response = await coordinator.fetch(
      new Request("https://siterep.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-citerep-admin-key": "test-admin-key" },
        body: JSON.stringify({ botId, question }),
      }),
    );
    return await response.json();
  };
  const storedBot = () => storage._map.get(`store:bot:${botId}`) || {};
  return { ask, storedBot };
}

const ANSWERABLE = "How much does the Pro plan cost?";
const UNANSWERABLE = "What is the weather in Tokyo today?";

test("a cited answer increments the monthly response count by exactly one", async () => {
  const { ask, storedBot } = await bootBot("bot-answered", { sources: defaultSources() });

  const result = await ask(ANSWERABLE);
  assert.equal(result.unknown, false, "question backed by a source must be answered");
  assert.equal(result.conversation.refused, false);
  // Customer-visible count in the response payload…
  assert.equal(result.responseCount, 1);
  // …and the persisted record the cap gate reads next time.
  assert.equal(storedBot().responseCount, 1);
});

test("a refusal increments the count by zero — charging for refusals is not allowed", async () => {
  const { ask, storedBot } = await bootBot("bot-refused", { sources: defaultSources() });

  const refused = await ask(UNANSWERABLE);
  assert.equal(refused.unknown, true, "question without a source must be refused");
  assert.equal(refused.conversation.refused, true);
  assert.equal(refused.responseCount, 0, "a refusal must never consume the plan cap");
  assert.equal(storedBot().responseCount, 0);

  // Refusals stay free even when repeated, and an answer that follows still
  // consumes exactly one.
  await ask(UNANSWERABLE);
  await ask(UNANSWERABLE);
  assert.equal(storedBot().responseCount, 0, "repeated refusals must not count");

  const answered = await ask(ANSWERABLE);
  assert.equal(answered.unknown, false);
  assert.equal(storedBot().responseCount, 1);
});

test("counting is cumulative across repeated calls", async () => {
  const { ask, storedBot } = await bootBot("bot-cumulative", { sources: defaultSources() });

  for (let i = 1; i <= 4; i += 1) {
    const result = await ask(ANSWERABLE);
    assert.equal(result.unknown, false);
    assert.equal(result.responseCount, i, `after ${i} answers the count must be ${i}`);
    assert.equal(storedBot().responseCount, i, "persisted count must match after each answer");
  }
});

test("the cap is enforced at the boundary: last allowed response served, past it refused, count never exceeds it", async () => {
  // Starter: 1000 responses + the product's 10% goodwill grace buffer = 1100
  // answered responses before the answering gate locks (see overage.js).
  const { ask, storedBot } = await bootBot("bot-boundary", { sources: defaultSources(), count: 1099 });

  const lastAllowed = await ask(ANSWERABLE);
  assert.equal(lastAllowed.unknown, false, "the last allowed response must be served");
  assert.equal(lastAllowed.responseCount, 1100);
  assert.equal(storedBot().responseCount, 1100);

  const pastCap = await ask(ANSWERABLE);
  assert.equal(pastCap.unknown, true, "the response past the cap must not be served");
  assert.equal(pastCap.conversation.refused, true);
  assert.equal(pastCap.responseCount, 1100, "the refused call must not push the count over the cap");
  assert.equal(pastCap.usage.locked, true);
  assert.equal(storedBot().responseCount, 1100);

  // Still refused and still pinned — the count never exceeds the cap.
  const again = await ask(ANSWERABLE);
  assert.equal(again.unknown, true);
  assert.equal(again.responseCount, 1100);
  assert.equal(storedBot().responseCount, 1100);
});

// The public demo bot (site-rep-demo) is Nish's marketing surface on
// siterep.net, not a customer bot. It must always answer real visitor
// questions — it can never be allowed to hit the response cap and degrade
// into lead-capture mode, or the live demo (and the synthetic monitor that
// pins it) breaks. Regression: 2026-08-25, the demo bot burned through its
// Starter 1000/month cap and started refusing every question.
test("the public demo bot is exempt from the response cap — it always answers", async () => {
  const { CiteRepCoordinator } = await import("../worker/index.js");
  const PUBLIC_DEMO_BOT_ID = "site-rep-demo";
  const demoSources = [
    {
      id: "demo-pricing",
      title: "Pricing",
      url: "https://siterep.net/pricing",
      excerpt: "Starter plan pricing",
      content: "The Starter plan costs 12 dollars per month.",
      status: "indexed",
      sourceType: "manual",
      indexedAt: new Date().toISOString(),
    },
  ];
  // Seed the demo bot already past the Starter cap + grace (1100) — the
  // exact state that locked the live site. It must STILL answer.
  const storage = fakeStorage({
    store: {
      bots: {
        [PUBLIC_DEMO_BOT_ID]: seedBot(PUBLIC_DEMO_BOT_ID, {
          plan: "Starter",
          sources: demoSources,
          count: 5000,
        }),
      },
    },
  });
  const coordinator = new CiteRepCoordinator({ storage }, { CITEREP_ADMIN_KEY: "test-admin-key" });
  const response = await coordinator.fetch(
    new Request("https://siterep.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-citerep-admin-key": "test-admin-key" },
      body: JSON.stringify({ botId: PUBLIC_DEMO_BOT_ID, question: "How much does the Starter plan cost?" }),
    }),
  );
  const result = await response.json();
  assert.equal(result.unknown, false, "the public demo bot must answer even past the cap");
  assert.equal(result.conversation?.refused, false, "the public demo bot must never refuse for usage_locked");
  assert.equal(result.usage?.locked, false, "the public demo bot usage meter must read unlocked");
});
