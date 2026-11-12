import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
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

const { CiteRepCoordinator, default: worker } = await import("../worker/index.js");
const { LEAD_RETENTION_CRON } = await import("../worker/retention.js");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const NOW_MS = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days) => new Date(NOW_MS - days * DAY_MS).toISOString();
const OLD = isoDaysAgo(400);
const RECENT = isoDaysAgo(1);
const OWNER_KEY = "own_retentionownerkey00000000000000";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const OLD_EMAIL = "old@visitor.test";
const RECENT_EMAIL = "recent@visitor.test";
const OWNER_EDITED_EMAIL = "owner-edited@visitor.test";

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

function fakeKv(seed = {}) {
  const map = new Map();
  for (const [name, value] of Object.entries(seed)) map.set(name, { value });
  return {
    get: async (name) => map.get(name)?.value ?? null,
    put: async (name, value) => {
      map.set(name, { value });
    },
    delete: async (name) => map.delete(name),
    list: async ({ prefix = "", limit = 1000 } = {}) => ({
      keys: [...map.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, limit)
        .map(([name]) => ({ name })),
      list_complete: true,
    }),
    _map: map,
  };
}

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  return {
    _db: db,
    prepare(sql) {
      const statement = db.prepare(sql);
      let args = [];
      const api = {
        bind(...values) {
          args = values.map((value) => (value === undefined ? null : value));
          return api;
        },
        async all() {
          return { results: statement.all(...args) };
        },
        async run() {
          const result = statement.run(...args);
          return { meta: { changes: Number(result.changes || 0) } };
        },
        async first() {
          return statement.get(...args) ?? null;
        },
      };
      return api;
    },
  };
}

let ledger = null;
function sharedLedger() {
  if (!DatabaseSync) return null;
  ledger ||= fakeD1();
  const existingTables = new Set(ledger._db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const table of ["siterep_leads", "siterep_conversations", "siterep_privacy_audit"]) {
    if (existingTables.has(table)) ledger._db.exec(`DELETE FROM ${table}`);
  }
  return ledger;
}

function retentionBot({ oldDays = 400 } = {}) {
  const old = isoDaysAgo(oldDays);
  return {
    botId: "retentionbot",
    publicKey: "pk_retention",
    ownerAccessKeyHash: sha256(OWNER_KEY),
    label: "retentionbot",
    ownerEmail: "owner@retention.test",
    plan: "Starter",
    lifecycleStatus: "live",
    siteUrl: "https://retention.test",
    createdAt: old,
    updatedAt: RECENT,
    leadRetentionDays: 365,
    sources: [],
    leads: [
      { id: 1, email: OLD_EMAIL, name: "Old", need: "An old question", conversationId: 101, status: "new", createdAt: old, updatedAt: old, lastSeenAt: old },
      { id: 2, email: RECENT_EMAIL, name: "Recent", need: "A recent question", conversationId: 201, status: "new", createdAt: RECENT, updatedAt: RECENT, lastSeenAt: RECENT },
      { id: 3, email: OWNER_EDITED_EMAIL, name: "Owner edited", need: "An old question", conversationId: 401, status: "contacted", createdAt: old, updatedAt: RECENT, lastSeenAt: old },
    ],
    conversations: [
      { id: 101, question: "Old question", answer: "Old answer", sessionId: "sess_old", visitor: { email: OLD_EMAIL }, createdAt: old, updatedAt: old },
      { id: 102, question: "Old anonymous follow-up", answer: "Old answer", sessionId: "sess_old", createdAt: old, updatedAt: old },
      { id: 301, question: "Old anonymous session", answer: "Old answer", sessionId: "sess_anon_old", createdAt: old, updatedAt: old },
      { id: 201, question: "Recent question", answer: "Recent answer", sessionId: "sess_recent", visitor: { email: RECENT_EMAIL }, createdAt: RECENT, updatedAt: RECENT },
      { id: 401, question: "Owner-reviewed old question", answer: "Old answer", sessionId: "sess_owner_edit", visitor: { email: OWNER_EDITED_EMAIL }, createdAt: old, updatedAt: RECENT },
    ],
    unknowns: [],
    escalations: [],
    tickets: [],
    notifications: [],
    actionQueue: [],
    events: [],
    installs: [],
    allowedOrigins: ["https://retention.test"],
    privacyRequests: [],
  };
}

function harness({ oldDays = 400 } = {}) {
  const bot = retentionBot({ oldDays });
  const storage = fakeStorage({ store: { bots: { retentionbot: bot } } });
  const backupKey = "store:backup:2026-10-15";
  const backup = JSON.stringify({ bots: { retentionbot: retentionBot({ oldDays }) } });
  const kv = fakeKv({
    store: JSON.stringify({ bots: { retentionbot: retentionBot({ oldDays }) } }),
    [backupKey]: backup,
  });
  const d1 = sharedLedger();
  const env = { CITEREP_ADMIN_KEY: "test-admin-key", CITEREP_STORE: kv, ...(d1 ? { SITEREP_PAYMENTS_DB: d1 } : {}) };
  const coordinator = new CiteRepCoordinator({ storage }, env);
  const botRecord = () => storage._map.get("store:bot:retentionbot");
  const post = (path, body) =>
    coordinator.fetch(
      new Request(`https://siterep.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-citerep-owner-key": OWNER_KEY, "cf-connecting-ip": "203.0.113.50" },
        body: JSON.stringify({ botId: "retentionbot", ...body }),
      }),
    );
  const get = (path) =>
    coordinator.fetch(new Request(`https://siterep.test${path}`, { headers: { "x-citerep-owner-key": OWNER_KEY, "cf-connecting-ip": "203.0.113.50" } }));
  const purge = () =>
    coordinator.fetch(
      new Request("https://siterep.test/__internal/scheduled/lead-retention-purge", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
        body: JSON.stringify({ cron: LEAD_RETENTION_CRON }),
      }),
    );
  return { coordinator, storage, kv, d1, backup, backupKey, botRecord, post, get, purge };
}

async function seedLedger(h) {
  if (!h.d1) return;
  await h.get("/api/leads?botId=retentionbot");
  h.d1._db.prepare("DELETE FROM siterep_leads WHERE bot_id = ?").run("retentionbot");
  h.d1._db.prepare("DELETE FROM siterep_conversations WHERE bot_id = ?").run("retentionbot");
  const insertLead = h.d1._db.prepare(
    "INSERT INTO siterep_leads (bot_id, lead_id, email, name, status, score, heat, conversation_id, lead_json, created_at, updated_at) VALUES (?, ?, ?, ?, '', 0, '', ?, ?, ?, ?)",
  );
  const insertConversation = h.d1._db.prepare(
    "INSERT INTO siterep_conversations (bot_id, conversation_id, question, answer, visitor_email, conversation_json, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?)",
  );
  insertLead.run("retentionbot", "1", OLD_EMAIL, "Old", "101", JSON.stringify({ id: 1, email: OLD_EMAIL, conversationId: 101, createdAt: OLD }), OLD, OLD);
  insertLead.run("retentionbot", "2", RECENT_EMAIL, "Recent", "201", JSON.stringify({ id: 2, email: RECENT_EMAIL, conversationId: 201, createdAt: RECENT }), RECENT, RECENT);
  insertLead.run("retentionbot", "3", OWNER_EDITED_EMAIL, "Owner edited", "401", JSON.stringify({ id: 3, email: OWNER_EDITED_EMAIL, conversationId: 401, createdAt: OLD, updatedAt: RECENT }), OLD, RECENT);
  insertLead.run("retentionbot", "9", "ledger-only@visitor.test", "Ledger only", "901", JSON.stringify({ id: 9, email: "ledger-only@visitor.test", conversationId: 901, createdAt: OLD }), OLD, OLD);
  insertConversation.run("retentionbot", "101", "Old question", OLD_EMAIL, JSON.stringify({ id: 101, sessionId: "sess_old", visitor: { email: OLD_EMAIL } }), OLD, OLD);
  insertConversation.run("retentionbot", "102", "Old anonymous follow-up", "", JSON.stringify({ id: 102, sessionId: "sess_old" }), OLD, OLD);
  insertConversation.run("retentionbot", "301", "Old anonymous session", "", JSON.stringify({ id: 301, sessionId: "sess_anon_old" }), OLD, OLD);
  insertConversation.run("retentionbot", "901", "Ledger-only old question", "ledger-only@visitor.test", JSON.stringify({ id: 901, sessionId: "sess_ledger" }), OLD, OLD);
  insertConversation.run("retentionbot", "201", "Recent question", RECENT_EMAIL, JSON.stringify({ id: 201, sessionId: "sess_recent", visitor: { email: RECENT_EMAIL } }), RECENT, RECENT);
  insertConversation.run("retentionbot", "401", "Owner-reviewed old question", OWNER_EDITED_EMAIL, JSON.stringify({ id: 401, sessionId: "sess_owner_edit", visitor: { email: OWNER_EDITED_EMAIL }, createdAt: OLD, updatedAt: RECENT }), OLD, RECENT);
  insertConversation.run("retentionbot", "302", "Recent anonymous question", "", JSON.stringify({ id: 302, sessionId: "sess_anon_recent" }), RECENT, RECENT);
}

test("the daily retention purge deletes expired leads from the store, ledger, mirror, and backups", async () => {
  const h = harness();
  await seedLedger(h);

  const response = await h.purge();
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.ok, true);
  assert.equal(summary.bots, 1);
  assert.ok(summary.leads >= 1);
  assert.ok(summary.conversations >= 2);

  const bot = h.botRecord();
  assert.deepEqual(bot.leads.map((lead) => lead.email), [RECENT_EMAIL], "a recent visitor survives the 12-month default");
  assert.deepEqual(bot.conversations.map((conversation) => conversation.id), [201], "old linked and anonymous conversations are deleted");
  assert.doesNotMatch(JSON.stringify(bot), /old@visitor\.test|Old anonymous session|owner-edited@visitor\.test|Owner-reviewed old question/);

  const backup = JSON.parse(h.kv._map.get(h.backupKey).value);
  assert.doesNotMatch(JSON.stringify(backup), /old@visitor\.test|Old anonymous session/);
  assert.match(JSON.stringify(backup), /recent@visitor\.test/);
  const mirror = JSON.parse(h.kv._map.get("store").value);
  assert.doesNotMatch(JSON.stringify(mirror), /old@visitor\.test/);
  assert.match(JSON.stringify(mirror), /recent@visitor\.test/);

  if (h.d1) {
    const leads = h.d1._db.prepare("SELECT lead_id FROM siterep_leads WHERE bot_id = ? ORDER BY lead_id").all("retentionbot").map((row) => row.lead_id);
    const conversations = h.d1._db.prepare("SELECT conversation_id FROM siterep_conversations WHERE bot_id = ? ORDER BY conversation_id").all("retentionbot").map((row) => row.conversation_id);
    assert.deepEqual(leads, ["2"], "old ledger-only rows are removed and recent rows stay");
    assert.deepEqual(conversations, ["201", "302"], "old ledger-only rows are removed and recent rows stay");
  }
});

test("a workspace can shorten retention and the next daily purge uses it", async () => {
  const h = harness({ oldDays: 31 });
  const saved = await h.post("/api/privacy/retention-settings", { retentionDays: 30 });
  assert.equal(saved.status, 200);
  const savedBot = await saved.json();
  assert.equal(savedBot.leadRetentionDays, 30);
  assert.equal(savedBot.retentionDays, undefined, "no duplicate retention field on the public bot");
  assert.equal(savedBot.retention, undefined, "no duplicate retention object on the public bot");

  const response = await h.purge();
  assert.equal(response.status, 200);
  const bot = h.botRecord();
  assert.equal(bot.leadRetentionDays, 30);
  assert.deepEqual(bot.leads.map((lead) => lead.email), [RECENT_EMAIL]);
});

test("the retention setting accepts the default or a shorter period, never a longer one", async () => {
  const h = harness();
  assert.equal((await h.post("/api/privacy/retention-settings", { retentionDays: 0 })).status, 400);
  assert.equal((await h.post("/api/privacy/retention-settings", { retentionDays: 366 })).status, 400);
  const shortened = await h.post("/api/privacy/retention-settings", { retentionDays: 90 });
  assert.equal(shortened.status, 200);
  assert.equal((await shortened.json()).leadRetentionDays, 90);
  const restored = await h.post("/api/privacy/retention-settings", { retentionDays: 365 });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).leadRetentionDays, 365);
});

function scheduledEnv(h) {
  return {
    CITEREP_ADMIN_KEY: "test-admin-key",
    CITEREP_STORE: h.kv,
    ...(h.d1 ? { SITEREP_PAYMENTS_DB: h.d1 } : {}),
    CITEREP_COORDINATOR: { getByName: () => ({ fetch: (...args) => h.coordinator.fetch(...args) }) },
  };
}

function scheduledCtx() {
  const pending = [];
  return {
    waitUntil: (promise) => pending.push(promise),
    passThroughOnException() {},
    settle: () => Promise.allSettled(pending),
  };
}

test("the retention cron triggers the purge through the scheduled handler, and the trust payload states the policy", async () => {
  const h = harness();
  await worker.scheduled({ cron: LEAD_RETENTION_CRON, scheduledTime: Date.now() }, scheduledEnv(h), scheduledCtx());
  assert.deepEqual(h.botRecord().leads.map((lead) => lead.email), [RECENT_EMAIL], "the retention cron runs the purge");

  const idle = harness();
  await worker.scheduled({ cron: "0 9 * * 1", scheduledTime: Date.now() }, scheduledEnv(idle), scheduledCtx());
  assert.equal(idle.botRecord().leads.length, 3, "a non-retention cron must not purge");

  const trust = await (await worker.fetch(new Request("https://siterep.net/api/public/trust-status"), scheduledEnv(h), scheduledCtx())).json();
  const retentionControl = (trust.confirmedControls || []).find((control) => control.area === "Visitor data retention");
  assert.match(retentionControl?.evidence || "", /deleted automatically 12 months after the visitor's last message/);
  assert.match(retentionControl?.evidence || "", /payment and invoice records are not affected/i);
});
