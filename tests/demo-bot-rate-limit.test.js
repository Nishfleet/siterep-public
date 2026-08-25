import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";

// Same cloudflare:workers stub + in-memory DO storage harness as the sibling
// response-cap-counting test: the REAL CiteRepCoordinator fetch handler runs
// here in Node, so the /api/public/chat/prepare rate-limit gate is exercised
// against the actual code path a visitor hits.
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

const DEMO_BOT_ID = "site-rep-demo";
const DEMO_PUBLIC_KEY = "sr_demo_source_backed_widget_key";
const DEMO_ORIGIN = "https://siterep.net";

function seedDemoBot() {
  return {
    botId: DEMO_BOT_ID,
    publicKey: DEMO_PUBLIC_KEY,
    ownerAccessKey: "ak_test",
    label: "Site Rep public demo",
    ownerEmail: "hello@siterep.net",
    plan: "Starter",
    lifecycleStatus: "live",
    siteUrl: DEMO_ORIGIN,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sources: [
      {
        id: "install-src",
        title: "Install the Site Rep widget",
        url: `${DEMO_ORIGIN}/docs/install`,
        excerpt: "Install the Site Rep widget on your website.",
        content: "You can install the Site Rep widget on your website by adding the widget script to your site. See the install guide.",
        status: "indexed",
        sourceType: "manual",
        indexedAt: new Date().toISOString(),
      },
    ],
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
    allowedOrigins: [DEMO_ORIGIN],
    routingProfile: "strict",
    retrieval: {},
    abuseProtection: {},
    widgetSettings: {},
    responseCount: 0,
    responseUsageMonth: "",
    trainingRuns: [],
    crawlJobs: [],
    sourceSync: {},
  };
}

function seedCustomerBot(botId) {
  return { ...seedDemoBot(), botId, publicKey: `pk_${botId}`, allowedOrigins: ["https://customer.example"] };
}

// Boot the real coordinator with a seeded store. Each `prepare` call is a real
// POST /api/public/chat/prepare round-trip through validatePublicRequest →
// enforcePublicChatRateLimit → prepareComposedAnswer, exactly as a widget
// visitor would. The connecting IP is set via cf-connecting-ip so the per-IP
// scope is deterministic and isolated per test.
async function boot(botId, seedBot) {
  const { CiteRepCoordinator } = await import("../worker/index.js");
  const storage = fakeStorage({ store: { bots: { [botId]: seedBot } } });
  const coordinator = new CiteRepCoordinator({ storage }, { CITEREP_ADMIN_KEY: "test-admin-key" });
  const prepare = async (ip, question = "How do I install the Site Rep widget on my website?") => {
    const response = await coordinator.fetch(
      new Request("https://siterep.test/api/public/chat/prepare", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: DEMO_ORIGIN,
          referer: `${DEMO_ORIGIN}/`,
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify({ botId, publicKey: seedBot.publicKey, question, sessionId: `s-${ip}-${Date.now()}` }),
      }),
    );
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { prepare };
}

test("demo bot: 20 questions/min per IP allowed, the 21st is rate limited (429)", async () => {
  const { prepare } = await boot(DEMO_BOT_ID, seedDemoBot());
  const ip = "10.1.0.1";
  for (let i = 0; i < 20; i += 1) {
    const { status } = await prepare(ip);
    assert.notEqual(status, 429, `question ${i + 1} within the 20/min demo cap must not be rate limited`);
  }
  const blocked = await prepare(ip);
  assert.equal(blocked.status, 429, "the 21st question in the same minute must be rate limited");
  assert.match(String(blocked.body?.error || ""), /too many questions/i);
});

test("demo bot: a second visitor IP is not blocked by the first IP's burst", async () => {
  const { prepare } = await boot(DEMO_BOT_ID, seedDemoBot());
  for (let i = 0; i < 20; i += 1) {
    const { status } = await prepare("10.2.0.1");
    assert.notEqual(status, 429, `visitor A question ${i + 1} must not be rate limited`);
  }
  const blocked = await prepare("10.2.0.1");
  assert.equal(blocked.status, 429, "visitor A's 21st must be rate limited");
  // A different IP has its own bucket — still allowed.
  const other = await prepare("10.2.0.2");
  assert.notEqual(other.status, 429, "visitor B on a different IP must not inherit A's rate limit");
});

test("customer bots keep the standard 45/min cap, not the tighter 20/min demo cap", async () => {
  const botId = "customer-bot-45";
  const { prepare } = await boot(botId, seedCustomerBot(botId));
  const ip = "10.3.0.1";
  for (let i = 0; i < 21; i += 1) {
    const { status } = await prepare(ip);
    assert.notEqual(status, 429, `customer question ${i + 1} must not be rate limited under the demo's tighter 20/min cap`);
  }
  // The standard cap is 45/min — the 46th is rate limited.
  for (let i = 21; i < 45; i += 1) {
    const { status } = await prepare(ip);
    assert.notEqual(status, 429, `customer question ${i + 1} within the 45/min cap must not be rate limited`);
  }
  const blocked = await prepare(ip);
  assert.equal(blocked.status, 429, "the 46th customer question in the same minute must be rate limited");
});

test("the per-visitor IP scope reads cf-connecting-ip via .get (not the broken bracket access)", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const scope = worker.slice(worker.indexOf("function publicRateLimitScope"), worker.indexOf("function rateLimitBucketKey"));
  assert.match(scope, /requestHeaderValue\(request, "cf-connecting-ip"\)/, "scope must read the IP via requestHeaderValue (.get), not bracket access");
  assert.doesNotMatch(scope, /headers\?\.\["cf-connecting-ip"\]/, "the broken bracket access that collapsed all visitors into one noip bucket must be gone");
});

test("demo bot daily cap of 200/day per IP is wired into the rate-limit gate", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(worker, /PUBLIC_DEMO_CHAT_DAILY_RATE_LIMIT_MAX = 200/);
  assert.match(worker, /PUBLIC_DEMO_CHAT_RATE_LIMIT_MAX = 20/);
  const fn = worker.slice(worker.indexOf("async function enforcePublicChatRateLimit"), worker.indexOf("function pruneMemoryRateLimitBuckets"));
  assert.match(fn, /isPublicDemoBotId\(botId\)/, "the demo bot branch must apply the tighter caps");
  assert.match(fn, /"chat-daily"/, "the demo bot branch must check the daily bucket");
  assert.match(fn, /PUBLIC_DEMO_CHAT_DAILY_RATE_LIMIT_MAX/);
  assert.match(fn, /catch \(error\)/, "the gate must fail open so a guard glitch never locks out a real visitor");
});

test("prune horizon uses the longest window, so the 24h daily bucket is not clobbered after 60s", async () => {
  // Regression: pruneMemoryRateLimitBuckets used to filter by the 60s chat
  // window. A daily bucket entry written at T=0 would be deleted at T=61s on
  // the next prune tick, breaking the 200/day cap silently. The fix pins the
  // prune horizon to PUBLIC_RATE_LIMIT_MAX_WINDOW_MS (24h).
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(
    worker,
    /PUBLIC_RATE_LIMIT_MAX_WINDOW_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    "the longest-used window (24h) must be defined as the prune horizon",
  );
  const prune = worker.slice(worker.indexOf("function pruneMemoryRateLimitBuckets"), worker.indexOf("function publicRateLimitScope"));
  assert.match(
    prune,
    /PUBLIC_RATE_LIMIT_MAX_WINDOW_MS/,
    "pruneMemoryRateLimitBuckets must use the max window as its horizon, not the 60s chat window",
  );
  assert.doesNotMatch(
    prune,
    /PUBLIC_RATE_LIMIT_WINDOW_MS/,
    "pruneMemoryRateLimitBuckets must no longer filter by the 60s chat window — that was the bug",
  );
});

test("demo bot: per-minute cap fires after 20 even on a fresh IP, and the daily branch is consulted first", async () => {
  // Functional proof: a 21st request from a brand-new IP gets 429. Combined
  // with the prune-horizon regression test above, the daily branch cannot be
  // silently bypassed by an aggressive in-memory prune.
  const { prepare } = await boot(DEMO_BOT_ID, seedDemoBot());
  const ip = `10.99.${Math.floor(Math.random() * 255)}.1`;
  for (let i = 0; i < 20; i += 1) {
    const { status } = await prepare(ip);
    assert.notEqual(status, 429, `question ${i + 1} must not be rate limited`);
  }
  const blocked = await prepare(ip);
  assert.equal(blocked.status, 429);
});

test("canary pin header skips the paid model compose call and ships the extractive answer", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const fn = worker.slice(worker.indexOf("async function handleComposedPublicChat"), worker.indexOf("function scheduleCustomerAccessNotificationFlush"));
  assert.match(fn, /x-siterep-canary/, "the compose path must read the canary pin header");
  assert.match(fn, /canaryPin && !isExactDemoPricingAnswer/, "when pinned, the compose (model) call must be skipped");
});

test("synthetic monitor sends the canary pin header when SITEREP_CANARY_PIN=1", async () => {
  const monitor = await readFile(new URL("../scripts/siterep-live-synthetic.mjs", import.meta.url), "utf8");
  assert.match(monitor, /SITEREP_CANARY_PIN/, "the monitor must read SITEREP_CANARY_PIN");
  assert.match(monitor, /"x-siterep-canary": "pin"/, "the monitor must set the pin header when enabled");
});
