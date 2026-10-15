import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
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

const { CiteRepCoordinator } = await import("../worker/index.js");

const NOW = new Date().toISOString();
const ADMIN_KEY = "test-admin-key";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

function makeBot(botId, keyFields) {
  return {
    botId,
    publicKey: "pk_test",
    ...keyFields,
    label: botId,
    ownerEmail: `owner@${botId}.test`,
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
    events: [],
    installs: [],
    allowedOrigins: ["https://example.com"],
  };
}

function coordinatorWith(bots) {
  const storage = fakeStorage({ store: { bots } });
  const coordinator = new CiteRepCoordinator({ storage }, { CITEREP_ADMIN_KEY: ADMIN_KEY, CITEREP_STORE: null });
  const botRecord = (botId) => storage._map.get(`store:bot:${botId}`);
  return { coordinator, botRecord };
}

function login(coordinator, botId, accessKey, ip) {
  return coordinator.fetch(
    new Request("https://siterep.test/api/customer/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ botId, accessKey }),
    }),
  );
}

function adminGet(coordinator, adminKey, ip) {
  return coordinator.fetch(
    new Request("https://siterep.test/api/bots/hashbot", {
      headers: { "x-citerep-admin-key": adminKey, "cf-connecting-ip": ip },
    }),
  );
}

test("a legacy plaintext owner key still signs in and is replaced by its hash", async () => {
  const key = "own_legacyplaintextkey0000000000000";
  const bot = makeBot("legacybot", { ownerAccessKey: key });
  bot.notifications = [{ id: "note_1", type: "workspace_access", detail: `Dashboard access key: ${key}`, deliveryStatus: "sent", dedupeKey: "a" }];
  const { coordinator, botRecord } = coordinatorWith({ legacybot: bot });

  const first = await login(coordinator, "legacybot", key, "203.0.113.10");
  assert.equal(first.status, 200);
  const stored = botRecord("legacybot");
  assert.equal(stored.ownerAccessKey, undefined);
  assert.equal(stored.ownerAccessKeyHash, sha256(key));
  assert.ok(!JSON.stringify(stored).includes(key), "plaintext key must not remain anywhere in the stored bot");
  const body = await first.json();
  assert.ok(!JSON.stringify(body).includes(sha256(key)), "the hash is never returned");

  assert.equal((await login(coordinator, "legacybot", key, "203.0.113.10")).status, 200);
  assert.equal((await login(coordinator, "legacybot", "own_wrong", "203.0.113.10")).status, 401);
});

test("a hashed owner key signs in and is never regenerated", async () => {
  const key = "own_hashedonlykey000000000000000000";
  const { coordinator, botRecord } = coordinatorWith({ hashbot: makeBot("hashbot", { ownerAccessKeyHash: sha256(key) }) });

  assert.equal((await login(coordinator, "hashbot", key, "203.0.113.20")).status, 200);
  assert.equal((await login(coordinator, "hashbot", sha256(key), "203.0.113.20")).status, 401);
  assert.equal((await adminGet(coordinator, ADMIN_KEY, "203.0.113.20")).status, 200);
  const stored = botRecord("hashbot");
  assert.equal(stored.ownerAccessKey, undefined);
  assert.equal(stored.ownerAccessKeyHash, sha256(key));
  assert.equal((await login(coordinator, "hashbot", key, "203.0.113.20")).status, 200);
});

test("admin key use is logged and repeated wrong admin keys are rate limited per IP", async () => {
  const { coordinator } = coordinatorWith({ hashbot: makeBot("hashbot", { ownerAccessKeyHash: sha256("own_x") }) });
  const lines = [];
  const originalInfo = console.info;
  console.info = (line) => lines.push(String(line));
  try {
    assert.equal((await adminGet(coordinator, ADMIN_KEY, "198.51.100.1")).status, 200);
    const allowed = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "admin_access" && entry.outcome === "allowed");
    assert.ok(allowed, "accepted admin key use writes an audit line");
    assert.equal(allowed.botId, "hashbot");
    assert.ok(!lines.join("\n").includes(ADMIN_KEY), "audit lines never contain the key");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.notEqual((await adminGet(coordinator, "wrong-key", "198.51.100.2")).status, 200);
    }
    assert.notEqual((await adminGet(coordinator, ADMIN_KEY, "198.51.100.2")).status, 200, "limited IP is refused even with the right key");
    assert.equal((await adminGet(coordinator, ADMIN_KEY, "198.51.100.3")).status, 200, "other IPs are unaffected");
  } finally {
    console.info = originalInfo;
  }
});
