import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
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

const { CiteRepCoordinator } = await import("../worker/index.js");
const { eraseLeadFromBot, eraseLeadFromStoreSnapshot, leadDeletionTargets } = await import("../worker/lead-deletion.js");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const NOW = new Date().toISOString();
const OWNER_KEY = "own_leaddeletionownerkey000000000000";
const EDITOR_TOKEN = "sr_sess_editortoken000000000000000000000000";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const JANE = "jane@visitor.test";
const OMAR = "omar@visitor.test";

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
  for (const [name, value] of Object.entries(seed)) map.set(name, { value, expiration: Math.floor(Date.now() / 1000) + 86400 });
  return {
    get: async (name) => map.get(name)?.value ?? null,
    put: async (name, value, options = {}) => {
      const expiration = options.expiration ?? (options.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined);
      map.set(name, { value, expiration });
    },
    delete: async (name) => map.delete(name),
    list: async ({ prefix = "" } = {}) => ({
      keys: [...map.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, entry]) => ({ name, expiration: entry.expiration })),
      list_complete: true,
    }),
    _map: map,
  };
}

// D1-shaped adapter over node:sqlite so the real SQL runs.
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

// The worker caches "ledger schema ready" per isolate, so every test shares
// one database (as production does) and starts from empty tables.
let ledger = null;
function sharedLedger() {
  if (!DatabaseSync) return null;
  ledger ||= fakeD1();
  for (const table of ["siterep_leads", "siterep_conversations", "siterep_privacy_audit"]) {
    try {
      ledger._db.exec(`DELETE FROM ${table}`);
    } catch {
      // Table not created yet: the first request creates it.
    }
  }
  return ledger;
}

function seededBot() {
  const janeConversation = { id: 101, question: "Do you ship to Leeds?", answer: "Yes.", sessionId: "sess_jane", visitor: { email: JANE, name: "Jane" }, createdAt: NOW, updatedAt: NOW };
  const janeEarlier = { id: 100, question: "What does it cost?", answer: "From $9.", sessionId: "sess_jane", createdAt: NOW, updatedAt: NOW };
  const omarConversation = { id: 200, question: "Can I book a demo?", answer: "Yes.", sessionId: "sess_omar", visitor: { email: OMAR }, createdAt: NOW, updatedAt: NOW };
  return {
    botId: "deletebot",
    publicKey: "pk_test",
    ownerAccessKeyHash: sha256(OWNER_KEY),
    label: "deletebot",
    ownerEmail: "owner@deletebot.test",
    plan: "Pro",
    lifecycleStatus: "live",
    siteUrl: "https://example.com",
    createdAt: NOW,
    updatedAt: NOW,
    sources: [],
    leads: [
      { id: 11, email: JANE, name: "Jane", need: "Wholesale order", conversationId: 101, status: "new", createdAt: NOW, updatedAt: NOW },
      { id: 22, email: OMAR, name: "Omar", need: "Demo", conversationId: 200, status: "new", createdAt: NOW, updatedAt: NOW },
    ],
    conversations: [janeConversation, janeEarlier, omarConversation],
    unknowns: [
      { id: 100, question: "What does it cost?", count: 1 },
      { id: 200, question: "Can I book a demo?", count: 1 },
    ],
    escalations: [
      { id: 1, question: "Do you ship to Leeds?", conversationId: 101, count: 1, status: "open" },
      { id: 2, question: "Popular question", conversationId: 100, count: 4, status: "open" },
    ],
    tickets: [
      { id: "ticket_jane", type: "lead_followup", leadId: 11, conversationId: 101, visitorEmail: JANE, dedupeKey: `lead:${JANE}`, status: "open" },
      { id: "ticket_omar", type: "lead_followup", leadId: 22, conversationId: 200, visitorEmail: OMAR, dedupeKey: `lead:${OMAR}`, status: "open" },
    ],
    notifications: [
      { id: "note_jane", type: "sales_lead", detail: `Jane (${JANE}) asked: "Wholesale order"`, dedupeKey: `lead:${JANE}`, meta: { leadId: 11 }, deliveryStatus: "pending" },
      { id: "note_due", type: "lead_followup_due", detail: `${JANE} — "Wholesale order" · ${OMAR} — "Demo"`, dedupeKey: "lead-followup:x", meta: { overdueCount: 2 }, deliveryStatus: "sent" },
      { id: "note_omar", type: "sales_lead", detail: `Omar (${OMAR}) asked: "Demo"`, dedupeKey: `lead:${OMAR}`, meta: { leadId: 22 }, deliveryStatus: "pending" },
    ],
    actionQueue: [
      { id: "act_jane", eventType: "lead.captured", status: "queued", payload: { leadId: 11, email: JANE, conversationId: 101 } },
      { id: "act_omar", eventType: "lead.captured", status: "queued", payload: { leadId: 22, email: OMAR, conversationId: 200 } },
    ],
    events: [
      { id: 1, type: "lead", title: "Lead captured", detail: `${JANE} · hot intent`, meta: { leadId: 11 } },
      { id: 2, type: "lead", title: "Lead captured", detail: `${OMAR} · warm intent`, meta: { leadId: 22 } },
    ],
    installs: [],
    allowedOrigins: ["https://example.com"],
    privacyRequests: [],
  };
}

test("erasing a lead removes the visitor's records and keeps everyone else's", () => {
  const bot = seededBot();
  const targets = leadDeletionTargets(bot, { leadId: 11 });
  const counts = eraseLeadFromBot(bot, targets);

  assert.deepEqual(bot.leads.map((lead) => lead.email), [OMAR]);
  assert.deepEqual(bot.conversations.map((item) => item.id), [200], "the linked conversation and same-session transcript are gone");
  assert.deepEqual(bot.tickets.map((item) => item.id), ["ticket_omar"]);
  assert.deepEqual(bot.actionQueue.map((item) => item.id), ["act_omar"]);
  assert.deepEqual(bot.events.map((item) => item.id), [2]);
  assert.deepEqual(bot.unknowns.map((item) => item.id), [200]);
  assert.deepEqual(bot.escalations.map((item) => [item.id, item.conversationId]), [[2, null]], "shared escalations stay but lose the link");
  assert.deepEqual(bot.notifications.map((item) => item.id), ["note_due", "note_omar"]);
  assert.equal(bot.notifications[0].detail, `${OMAR} — "Demo"`, "multi-lead summaries drop only the deleted visitor");
  assert.doesNotMatch(JSON.stringify(bot), /jane@visitor\.test|Wholesale order/);
  assert.equal(counts.leads, 1);
  assert.equal(counts.conversations, 2);
});

test("store snapshots are scrubbed with the same rules and untouched when nothing matches", () => {
  const snapshot = JSON.stringify({ bots: { deletebot: seededBot() } });
  const targets = leadDeletionTargets(seededBot(), { email: JANE });
  const scrubbed = eraseLeadFromStoreSnapshot(snapshot, "deletebot", targets);
  assert.ok(scrubbed);
  assert.doesNotMatch(scrubbed, /jane@visitor\.test/);
  assert.match(scrubbed, /omar@visitor\.test/);
  assert.equal(eraseLeadFromStoreSnapshot(scrubbed, "deletebot", targets), null);
});

function harness() {
  const bot = seededBot();
  const editorSession = {
    role: "customer",
    botId: "deletebot",
    teamRole: "editor",
    credentialMode: "owner_key",
    permissions: ["bot:read", "bot:write", "export:read"],
    createdAt: NOW,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const storage = fakeStorage({ store: { bots: { deletebot: bot }, authSessions: { [sha256(EDITOR_TOKEN)]: editorSession } } });
  const backupKey = `store:backup:${NOW.slice(0, 10)}`;
  const kv = fakeKv({
    store: JSON.stringify({ bots: { deletebot: seededBot() } }),
    [backupKey]: JSON.stringify({ bots: { deletebot: seededBot() } }),
  });
  const d1 = sharedLedger();
  const env = { CITEREP_ADMIN_KEY: "test-admin-key", CITEREP_STORE: kv, ...(d1 ? { SITEREP_PAYMENTS_DB: d1 } : {}) };
  const coordinator = new CiteRepCoordinator({ storage }, env);
  const botRecord = () => storage._map.get("store:bot:deletebot");
  const post = (path, body, headers = { "x-citerep-owner-key": OWNER_KEY }) =>
    coordinator.fetch(
      new Request(`https://siterep.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50", ...headers },
        body: JSON.stringify({ botId: "deletebot", ...body }),
      }),
    );
  const get = (path) =>
    coordinator.fetch(new Request(`https://siterep.test${path}`, { headers: { "x-citerep-owner-key": OWNER_KEY, "cf-connecting-ip": "203.0.113.50" } }));
  return { coordinator, storage, kv, d1, backupKey, botRecord, post, get };
}

async function seedLedger(h) {
  if (!h.d1) return;
  // Touch an owner route once so the ledger schema exists, then add rows the
  // store no longer holds (an older capture of the same visitor).
  await h.get("/api/leads?botId=deletebot");
  const insertLead = h.d1._db.prepare(
    "INSERT INTO siterep_leads (bot_id, lead_id, email, name, status, score, heat, conversation_id, lead_json, created_at, updated_at) VALUES (?, ?, ?, ?, '', 0, '', ?, ?, ?, ?)",
  );
  insertLead.run("deletebot", "9", JANE, "Jane", "90", JSON.stringify({ id: 9, email: JANE, conversationId: 90, createdAt: NOW }), NOW, NOW);
  const insertConversation = h.d1._db.prepare(
    "INSERT INTO siterep_conversations (bot_id, conversation_id, question, answer, visitor_email, conversation_json, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?)",
  );
  insertConversation.run("deletebot", "90", "Old question", JANE, JSON.stringify({ id: 90, sessionId: "sess_old", visitor: { email: JANE } }), NOW, NOW);
  insertConversation.run("deletebot", "91", "Same old session", "", JSON.stringify({ id: 91, sessionId: "sess_old" }), NOW, NOW);
}

test("an owner deletes a lead and every Site Rep copy of it, with a PII-free audit entry", async () => {
  const h = harness();
  await seedLedger(h);

  const response = await h.post("/api/leads/delete", { leadId: 11 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deletion.ok, true);
  assert.equal(body.deletion.counts.leads, 1);
  assert.doesNotMatch(JSON.stringify(body), /jane@visitor\.test|Wholesale order/);

  const stored = h.botRecord();
  assert.deepEqual(stored.leads.map((lead) => lead.email), [OMAR]);
  assert.doesNotMatch(JSON.stringify(stored), /jane@visitor\.test|Wholesale order|sess_jane/);
  const audit = stored.events.find((event) => event.title === "Lead data deleted");
  assert.ok(audit, "the activity log records that a deletion happened");
  assert.doesNotMatch(JSON.stringify(audit), /jane|@visitor/);

  for (const [name, entry] of h.kv._map) {
    assert.doesNotMatch(entry.value, /jane@visitor\.test/, `${name} must be scrubbed`);
    assert.match(entry.value, /omar@visitor\.test/, `${name} keeps other visitors`);
    assert.ok(entry.expiration > Date.now() / 1000, `${name} keeps an expiry`);
  }

  if (h.d1) {
    const leftovers = h.d1._db
      .prepare("SELECT conversation_id FROM siterep_conversations WHERE bot_id = 'deletebot' AND conversation_id IN ('90', '91', '100', '101')")
      .all();
    assert.deepEqual(leftovers, [], "ledger-only conversations from the same visitor are deleted");
    assert.deepEqual(h.d1._db.prepare("SELECT lead_id FROM siterep_leads WHERE email = ?").all(JANE), []);
    const auditRows = h.d1._db.prepare("SELECT action, actor, details_json FROM siterep_privacy_audit").all();
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].action, "lead_data_deleted");
    assert.equal(auditRows[0].actor, "owner_key");
    assert.doesNotMatch(auditRows[0].details_json, /jane|@visitor|Wholesale/);

    const leads = await (await h.get("/api/leads?botId=deletebot")).json();
    assert.deepEqual(leads.map((lead) => lead.email), [OMAR], "the ledger merge does not bring the lead back");
    const csv = await (await h.get("/api/export/leads.csv?botId=deletebot")).text();
    assert.doesNotMatch(csv, /jane@visitor\.test/);
  }

  assert.equal((await h.post("/api/leads/delete", { leadId: 11 })).status, 404, "a second delete finds nothing");
});

test("editors cannot delete leads", async () => {
  const h = harness();
  const response = await h.post("/api/leads/delete", { leadId: 11 }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  assert.equal(response.status, 401);
  const stored = h.botRecord();
  assert.ok(stored, "the session lookup loaded the store");
  assert.match(JSON.stringify(stored.leads), /jane@visitor\.test/);
});

test("an open lead deletion request completes through the same deletion path", async () => {
  const h = harness();
  const queued = await h.post(
    "/api/privacy/deletion-request",
    { scope: "lead", leadId: 11, note: "Visitor asked to be forgotten." },
    { authorization: `Bearer ${EDITOR_TOKEN}` },
  );
  assert.equal(queued.status, 200);
  const request = (await queued.json()).privacyRequests[0];
  assert.equal(request.status, "requested", "an editor's request waits for an owner");
  assert.equal(request.targetLeadId, "11");
  assert.match(JSON.stringify(h.botRecord().leads), /jane@visitor\.test/);

  const completed = await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: request.id });
  assert.equal(completed.status, 200);
  const stored = h.botRecord();
  const done = stored.privacyRequests.find((item) => item.id === request.id);
  assert.equal(done.status, "completed");
  assert.equal(done.targetLeadId, undefined, "the completed request no longer names the visitor");
  assert.ok(done.completedAt);
  assert.equal(stored.tickets.find((ticket) => ticket.id === done.ticketId)?.status, "resolved");
  assert.doesNotMatch(JSON.stringify(stored.leads), /jane@visitor\.test/);

  assert.equal((await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: request.id })).status, 409);
});

test("an owner's lead deletion request runs immediately; account requests stay in review", async () => {
  const h = harness();
  const response = await h.post("/api/privacy/deletion-request", { scope: "visitor", visitorEmail: JANE });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.privacyRequests[0].status, "completed");
  assert.doesNotMatch(JSON.stringify(h.botRecord().leads), /jane@visitor\.test/);

  const account = await h.post("/api/privacy/deletion-request", { scope: "account", note: "Close my account." });
  const accountRequest = (await account.json()).privacyRequests[0];
  assert.equal(accountRequest.scope, "account");
  assert.equal(accountRequest.status, "requested");
  assert.equal((await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: accountRequest.id })).status, 409);
});

test("the dashboard and public trust copy describe self-serve deletion, not ticket-only erasure", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /"\/api\/leads\/delete"/);
  assert.match(app, /"\/api\/privacy\/deletion-request\/complete"/);
  assert.doesNotMatch(worker, /is not instant erasure/);
  assert.match(worker, /Customers can delete a visitor's lead from the dashboard lead inbox/);
  assert.doesNotMatch(worker, /retention period|automatically purge/i);
});
