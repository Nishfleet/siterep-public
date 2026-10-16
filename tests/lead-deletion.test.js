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
const OWNER_TOKEN = "sr_sess_ownertoken0000000000000000000000000";
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

// Workers KV shape: list() is sorted by key and reports each key's
// expiration only when it has one. Keys named in noExpiry are seeded the way
// the KV-only store writes its main copy: with no expiration at all.
function fakeKv(seed = {}, { noExpiry = [] } = {}) {
  const map = new Map();
  for (const [name, value] of Object.entries(seed)) {
    map.set(name, { value, expiration: noExpiry.includes(name) ? undefined : Math.floor(Date.now() / 1000) + 86400 });
  }
  return {
    get: async (name) => map.get(name)?.value ?? null,
    put: async (name, value, options = {}) => {
      const expiration = options.expiration ?? (options.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined);
      map.set(name, { value, expiration });
    },
    delete: async (name) => map.delete(name),
    list: async ({ prefix = "", limit = 1000 } = {}) => ({
      keys: [...map.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, limit)
        .map(([name, entry]) => ({ name, ...(entry.expiration ? { expiration: entry.expiration } : {}) })),
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
  assert.equal(scrubbed.unreadable, false);
  assert.ok(scrubbed.json);
  assert.doesNotMatch(scrubbed.json, /jane@visitor\.test/);
  assert.match(scrubbed.json, /omar@visitor\.test/);
  assert.deepEqual(eraseLeadFromStoreSnapshot(scrubbed.json, "deletebot", targets), { json: null, unreadable: false });
  assert.deepEqual(eraseLeadFromStoreSnapshot(JSON.stringify({ bots: { otherbot: {} } }), "deletebot", targets), { json: null, unreadable: false });
  for (const odd of ["not json", JSON.stringify({ "bot:deletebot": seededBot() }), JSON.stringify([1, 2])]) {
    assert.deepEqual(eraseLeadFromStoreSnapshot(odd, "deletebot", targets), { json: null, unreadable: true }, "an unexpected shape is reported, not skipped");
  }
});

test("a browser session shared with another lead is never followed", () => {
  const bot = seededBot();
  // Omar typed in the same tab session Jane used, and left his own lead.
  bot.conversations.push({ id: 300, question: "Is there a discount?", answer: "No.", sessionId: "sess_jane", visitor: { email: OMAR }, createdAt: NOW });
  bot.conversations.push({ id: 301, question: "Opening hours?", answer: "9-5.", sessionId: "sess_jane", createdAt: NOW });
  bot.leads.push({ id: 33, email: "kim@visitor.test", conversationId: 301, status: "new", createdAt: NOW });
  const targets = leadDeletionTargets(bot, { leadId: 11 });
  assert.ok(targets.blockedSessions.has("sess_jane"));
  const counts = eraseLeadFromBot(bot, targets);

  assert.equal(counts.leads, 1, "only Jane's lead goes");
  assert.deepEqual(bot.leads.map((lead) => lead.id).sort(), [22, 33]);
  assert.deepEqual(bot.conversations.map((item) => item.id).sort(), [100, 200, 300, 301], "the shared session's other questions stay");
  assert.ok(bot.tickets.some((ticket) => ticket.id === "ticket_omar"));
});

test("unknown entries match the visitor by question, not by a colliding id", () => {
  const bot = seededBot();
  bot.unknowns = [
    // A QA-run gap whose timestamp id happens to equal Jane's conversation id.
    { id: 100, question: "Do you offer refunds?", count: 1 },
    // Jane asked first; two other visitors asked the same thing since.
    { id: 101, question: "Do you ship to Leeds?", count: 3 },
  ];
  bot.conversations.push({ id: 400, question: "do you ship to leeds", answer: "Yes.", sessionId: "sess_other", createdAt: NOW });
  const counts = eraseLeadFromBot(bot, leadDeletionTargets(bot, { leadId: 11 }));

  assert.equal(counts.unknowns, 0);
  assert.equal(counts.unknownsUnlinked, 1);
  assert.deepEqual(bot.unknowns[0], { id: 100, question: "Do you offer refunds?", count: 1 });
  assert.match(String(bot.unknowns[1].id), /^unknown_/, "the shared gap no longer points at Jane's conversation");
  assert.deepEqual({ ...bot.unknowns[1], id: "x" }, { id: "x", question: "do you ship to leeds", count: 2 });
  assert.doesNotMatch(JSON.stringify(bot.escalations), /Leeds\?/, "a shared escalation keeps no wording of the deleted visitor");
});

test("a malformed email is never a target, typed or stored", async () => {
  const bot = seededBot();
  bot.leads.push({ id: 44, email: "a", conversationId: null, status: "new", createdAt: NOW });
  const targets = leadDeletionTargets(bot, { leadId: 44 });
  assert.deepEqual([...targets.emails], [], "a stored non-address never becomes a text match");
  const counts = eraseLeadFromBot(bot, targets);
  assert.equal(counts.leads, 1);
  assert.equal(bot.events.length, 2, "events mentioning the word 'a' stay");

  const h = harness();
  const response = await h.post("/api/leads/delete", { email: "a" });
  assert.equal(response.status, 400);
  assert.deepEqual(h.botRecord().leads.map((lead) => lead.email).sort(), [JANE, OMAR]);
});

test("erasing the same copy twice changes nothing the second time", () => {
  const bot = seededBot();
  bot.unknowns = [{ id: 101, question: "Do you ship to Leeds?", count: 3 }];
  bot.conversations.push({ id: 400, question: "do you ship to leeds", answer: "Yes.", sessionId: "sess_other", createdAt: NOW });
  const snapshot = JSON.stringify({ bots: { deletebot: bot } });
  const targets = leadDeletionTargets(seededBot(), { leadId: 11 });
  const once = eraseLeadFromStoreSnapshot(snapshot, "deletebot", targets);
  assert.ok(once.json);
  assert.equal(JSON.parse(once.json).bots.deletebot.unknowns[0].count, 2);
  assert.deepEqual(eraseLeadFromStoreSnapshot(once.json, "deletebot", targets), { json: null, unreadable: false }, "the rescrub and the check find nothing left");
  const live = JSON.parse(once.json).bots.deletebot;
  const again = eraseLeadFromBot(live, targets);
  assert.equal(again.unknownsUnlinked, 0);
  assert.equal(live.unknowns[0].count, 2, "other visitors' count is not counted down again");
});

test("a queued webhook about another lead keeps its delivery and loses only the mention", () => {
  const bot = seededBot();
  bot.actionQueue.push({
    id: "act_note",
    eventType: "team_notification.created",
    status: "queued",
    payload: { conversationId: null, leadId: null, ticketId: null, sourceId: null, email: "", title: `Follow up ${JANE} · ${OMAR}` },
    payloadSummary: { conversationId: null, leadId: null, ticketId: null, sourceId: null, email: "", title: `Follow up ${JANE} · ${OMAR}` },
  });
  bot.actionQueue.push({
    id: "act_mixed",
    eventType: "team_notification.created",
    status: "queued",
    payload: { conversationId: 200, email: OMAR, title: `Compare with ${JANE.toUpperCase()}` },
  });
  const counts = eraseLeadFromBot(bot, leadDeletionTargets(bot, { leadId: 11 }));

  assert.deepEqual(bot.actionQueue.map((item) => item.id), ["act_omar", "act_note", "act_mixed"]);
  assert.equal(counts.actions, 1);
  assert.equal(counts.actionsScrubbed, 2);
  assert.equal(bot.actionQueue[1].payload.title, OMAR);
  assert.equal(bot.actionQueue[2].payload.email, OMAR);
  assert.equal(bot.actionQueue[2].payload.title, "Compare with [deleted]");
  assert.doesNotMatch(JSON.stringify(bot.actionQueue), /jane@visitor\.test/i);
});

function boundaryBot(deletedEmail, otherEmail) {
  return {
    botId: "deletebot",
    leads: [
      { id: 1, email: deletedEmail, need: "Quote", conversationId: 10 },
      { id: 2, email: otherEmail, need: "Demo", conversationId: 20 },
    ],
    conversations: [
      { id: 10, question: "Quote please", visitor: { email: deletedEmail } },
      { id: 20, question: "Demo please", visitor: { email: otherEmail } },
    ],
    notifications: [{ id: "note_other", type: "sales_lead", title: "Sales lead captured", detail: `Lead (${otherEmail}) asked: "Demo"`, deliveryStatus: "pending" }],
    events: [{ id: 2, type: "lead", title: "Lead captured", detail: `${otherEmail} · warm intent` }],
    actionQueue: [{ id: "act_other", status: "queued", payload: { conversationId: null, leadId: null, email: "", title: `New lead ${otherEmail}` } }],
  };
}

for (const [deleted, other] of [
  ["jo@x.com", "bojo@x.com"],
  ["jo@x.co", "jo@x.co.uk"],
  ["jo@x.com", "jo@x.com.au"],
]) {
  test(`deleting ${deleted} leaves ${other} alone`, () => {
    const bot = boundaryBot(deleted, other);
    const counts = eraseLeadFromBot(bot, leadDeletionTargets(bot, { email: deleted.toUpperCase() }));
    assert.equal(counts.leads, 1);
    assert.deepEqual(bot.leads.map((lead) => lead.email), [other]);
    assert.deepEqual(bot.notifications.map((item) => item.id), ["note_other"], "the other lead's alert still goes out");
    assert.deepEqual(bot.events.map((item) => item.id), [2]);
    assert.equal(bot.actionQueue[0].payload.title, `New lead ${other}`, "the other lead's webhook is not masked");
    assert.equal(counts.actionsScrubbed, 0);

    // The whole address is still found case-insensitively, at a sentence end too.
    const mixed = boundaryBot(deleted, other);
    mixed.actionQueue[0].payload.title = `Compare ${other} with ${deleted.toUpperCase()}.`;
    eraseLeadFromBot(mixed, leadDeletionTargets(mixed, { email: deleted }));
    assert.equal(mixed.actionQueue[0].payload.title, `Compare ${other} with [deleted].`);
  });
}

function harness({ kvNoExpiry = [], extraBots = {} } = {}) {
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
  const ownerSession = { ...editorSession, teamRole: "owner", permissions: ["bot:read", "bot:write", "bot:admin", "export:read"] };
  const storage = fakeStorage({
    store: {
      bots: { deletebot: bot, ...extraBots },
      authSessions: { [sha256(EDITOR_TOKEN)]: editorSession, [sha256(OWNER_TOKEN)]: ownerSession },
    },
  });
  const backupKey = `store:backup:${NOW.slice(0, 10)}`;
  const kv = fakeKv(
    {
      store: JSON.stringify({ bots: { deletebot: seededBot() } }),
      [backupKey]: JSON.stringify({ bots: { deletebot: seededBot() } }),
    },
    { noExpiry: kvNoExpiry },
  );
  const d1 = sharedLedger();
  const env = { CITEREP_ADMIN_KEY: "test-admin-key", CITEREP_STORE: kv, ...(d1 ? { SITEREP_PAYMENTS_DB: d1 } : {}) };
  const coordinator = new CiteRepCoordinator({ storage }, env);
  const botRecord = (botId = "deletebot") => storage._map.get(`store:bot:${botId}`);
  const rawPost = (path, body, headers = { "x-citerep-owner-key": OWNER_KEY }) =>
    coordinator.fetch(
      new Request(`https://siterep.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const post = (path, body, headers) => rawPost(path, { botId: "deletebot", ...body }, headers);
  const get = (path) =>
    coordinator.fetch(new Request(`https://siterep.test${path}`, { headers: { "x-citerep-owner-key": OWNER_KEY, "cf-connecting-ip": "203.0.113.50" } }));
  return { coordinator, storage, kv, d1, backupKey, botRecord, post, rawPost, get };
}

async function seedLedger(h) {
  if (!h.d1) return;
  // Touch an owner route once so the ledger schema exists, then add rows the
  // store no longer holds (an older capture of the same visitor).
  await h.get("/api/leads?botId=deletebot");
  const insertLead = h.d1._db.prepare(
    "INSERT INTO siterep_leads (bot_id, lead_id, email, name, status, score, heat, conversation_id, lead_json, created_at, updated_at) VALUES (?, ?, ?, ?, '', 0, '', ?, ?, ?, ?)",
  );
  // Mixed case, as rows written before the ledger lowercased addresses can be.
  insertLead.run("deletebot", "9", "Jane@Visitor.TEST", "Jane", "90", JSON.stringify({ id: 9, email: JANE, conversationId: 90, createdAt: NOW }), NOW, NOW);
  const insertConversation = h.d1._db.prepare(
    "INSERT INTO siterep_conversations (bot_id, conversation_id, question, answer, visitor_email, conversation_json, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?)",
  );
  insertConversation.run("deletebot", "90", "Old question", "JANE@visitor.test", JSON.stringify({ id: 90, sessionId: "sess_old", visitor: { email: JANE } }), NOW, NOW);
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
    assert.deepEqual(h.d1._db.prepare("SELECT lead_id FROM siterep_leads WHERE lower(email) = ?").all(JANE), [], "mixed-case ledger rows go too");
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

test("a lead id whose records disagree on the email never pulls in a second person", () => {
  const bot = seededBot();
  // A second store record under Jane's lead id, with someone else's email.
  bot.leads.push({ id: 11, email: "kim@visitor.test", conversationId: 400, status: "new", createdAt: NOW });
  const targets = leadDeletionTargets(bot, { leadId: 11 });
  assert.equal(targets.ambiguous, true);
  assert.deepEqual([...targets.emails], [JANE], "Kim's email is never added");
});

test("a deletion is refused when the ledger names another email for one of the visitor's lead ids", { skip: !DatabaseSync }, async () => {
  const h = harness();
  await seedLedger(h);
  h.d1._db
    .prepare(
      "INSERT OR REPLACE INTO siterep_leads (bot_id, lead_id, email, name, status, score, heat, conversation_id, lead_json, created_at, updated_at) VALUES (?, ?, ?, '', '', 0, '', ?, ?, ?, ?)",
    )
    .run("deletebot", "11", "kim@visitor.test", "400", JSON.stringify({ id: 11, email: "kim@visitor.test" }), NOW, NOW);

  const response = await h.post("/api/leads/delete", { leadId: 11 });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /more than one email, so nothing was deleted/);
  assert.deepEqual(h.botRecord().leads.map((lead) => lead.email).sort(), [JANE, OMAR], "nobody was erased");
  const kim = h.d1._db.prepare("SELECT count(*) AS n FROM siterep_leads WHERE bot_id = 'deletebot' AND email = 'kim@visitor.test'").get();
  assert.equal(kim.n, 1, "the other person's ledger row stays");

  const byEmail = await h.post("/api/leads/delete", { email: JANE });
  assert.equal(byEmail.status, 409, "the email path reaches lead 11 too, so it is refused the same way");
  assert.deepEqual(h.botRecord().leads.map((lead) => lead.email).sort(), [JANE, OMAR]);
  assert.equal(h.d1._db.prepare("SELECT count(*) AS n FROM siterep_leads WHERE bot_id = 'deletebot' AND email = 'kim@visitor.test'").get().n, 1);
});

test("a session the ledger shows another visitor in is skipped and reported", { skip: !DatabaseSync }, async () => {
  const h = harness();
  await seedLedger(h);
  // Only the ledger knows a third visitor also typed in Jane's old session.
  h.d1._db
    .prepare(
      "INSERT INTO siterep_conversations (bot_id, conversation_id, question, answer, visitor_email, conversation_json, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?)",
    )
    .run("deletebot", "93", "Kim's question", "kim@visitor.test", JSON.stringify({ id: 93, sessionId: "sess_old", visitor: { email: "kim@visitor.test" } }), NOW, NOW);

  const response = await h.post("/api/leads/delete", { leadId: 11 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deletion.counts.sharedSessionsSkipped, 1);
  assert.match(body.deletion.warnings.join(" "), /shared with another lead/);
  const left = h.d1._db.prepare("SELECT conversation_id FROM siterep_conversations WHERE bot_id = 'deletebot' AND conversation_id IN ('90', '91', '93', '100', '101') ORDER BY conversation_id").all();
  assert.deepEqual(left.map((row) => row.conversation_id), ["91", "93"], "Jane's own rows go; the shared session's others stay");
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
  assert.equal(done.targetLeadId, "11", "the completed request still shows which lead it covered");
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

test("the live KV store key is written only by the store's own writer, from the erased store", async () => {
  // The KV copy is older than the live store: it still holds a bot the live
  // store no longer has. A scrub that rewrote this copy would put that stale
  // state back (and in KV-only mode would overwrite chats that landed since).
  const h = harness();
  await h.kv.put("store", JSON.stringify({ bots: { deletebot: seededBot(), stalebot: { botId: "stalebot" } } }), { expirationTtl: 3600 });
  // The once-a-minute mirror limit is in force; the deletion must still refresh it.
  h.coordinator.lastKvMirrorAt = Date.now();
  const put = h.kv.put;
  const storeWrites = [];
  h.kv.put = async (name, value, options = {}) => {
    if (name === "store") storeWrites.push({ value, options });
    await put(name, value, options);
  };
  const response = await h.post("/api/leads/delete", { leadId: 11 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deletion.complete, true);
  assert.ok(storeWrites.length >= 1, "the deletion refreshes the mirror");
  for (const write of storeWrites) {
    assert.doesNotMatch(write.value, /stalebot/, "the key is never rewritten from the old KV copy");
    assert.equal(write.options.expirationTtl, 60 * 60 * 24 * 30, "only the mirror path writes it");
  }
  const main = h.kv._map.get("store").value;
  assert.doesNotMatch(main, /jane@visitor\.test/);
  assert.match(main, /omar@visitor\.test/);
  const backup = h.kv._map.get(h.backupKey);
  assert.doesNotMatch(backup.value, /jane@visitor\.test/);
  assert.ok(backup.expiration > Date.now() / 1000, "backups keep the expiry they had");
});

test("a backup written while the deletion runs is scrubbed by the second pass", async () => {
  const h = harness();
  const put = h.kv.put;
  let injected = false;
  h.kv.put = async (name, value, options) => {
    await put(name, value, options);
    // A daily backup lands right after the first scrub, from the store as it
    // was before the live erase.
    if (!injected && name === h.backupKey) {
      injected = true;
      await put("store:backup:2099-01-01", JSON.stringify({ bots: { deletebot: seededBot() } }), { expirationTtl: 3600 });
    }
  };
  const response = await h.post("/api/leads/delete", { leadId: 11 });
  assert.equal(response.status, 200);
  assert.ok(injected);
  for (const [name, entry] of h.kv._map) {
    assert.doesNotMatch(entry.value, /jane@visitor\.test/, `${name} must be scrubbed`);
  }
});

test("a recovery snapshot in an unexpected shape is reported and logged, not passed off as success", async () => {
  const h = harness();
  await h.kv.put("store:backup:2026-01-01", JSON.stringify({ "bot:deletebot": seededBot() }), { expirationTtl: 3600 });
  const warn = console.warn;
  const logged = [];
  console.warn = (line) => logged.push(String(line));
  let body;
  try {
    const response = await h.post("/api/leads/delete", { leadId: 11 });
    assert.equal(response.status, 200);
    body = await response.json();
  } finally {
    console.warn = warn;
  }
  assert.equal(body.deletion.complete, false);
  assert.equal(body.deletion.counts.snapshotsUnreadable, 1);
  assert.match(body.deletion.warnings.join(" "), /could not be checked/);
  assert.ok(logged.some((line) => line.includes("lead_deletion_snapshot_unreadable") && line.includes("store:backup:2026-01-01")));
  assert.doesNotMatch(JSON.stringify(h.botRecord().leads), /jane@visitor\.test/, "live data is still deleted");
});

test("deletion routes act only on the bot the caller is authorized for", async () => {
  const OTHER_KEY = "own_otherbotownerkey00000000000000000";
  const h = harness({ extraBots: { otherbot: { ...seededBot(), botId: "otherbot", label: "otherbot", ownerAccessKeyHash: sha256(OTHER_KEY) } } });

  for (const headers of [{ "x-citerep-owner-key": OWNER_KEY }, { authorization: `Bearer ${OWNER_TOKEN}` }]) {
    assert.equal((await h.rawPost("/api/leads/delete", { botId: "otherbot", leadId: 11 }, headers)).status, 401);
    assert.equal((await h.rawPost("/api/privacy/deletion-request", { botId: "otherbot", scope: "lead", leadId: 11 }, headers)).status, 401);
    assert.equal((await h.rawPost("/api/privacy/deletion-request/complete", { botId: "otherbot", privacyRequestId: "x" }, headers)).status, 401);
  }
  assert.match(JSON.stringify(h.botRecord("otherbot").leads), /jane@visitor\.test/, "another workspace's lead is untouched");

  // A bot id in the query is the one authorization checked, so it is the one the handler acts on.
  const response = await h.rawPost("/api/leads/delete?botId=deletebot", { leadId: 11 }, { authorization: `Bearer ${OWNER_TOKEN}` });
  assert.equal(response.status, 200);
  assert.doesNotMatch(JSON.stringify(h.botRecord().leads), /jane@visitor\.test/);
  assert.match(JSON.stringify(h.botRecord("otherbot").leads), /jane@visitor\.test/);
});

test("an email that matches nothing is a 404 and leaves no audit trail", async () => {
  const h = harness();
  await seedLedger(h);
  const response = await h.post("/api/leads/delete", { email: "nobody@visitor.test" });
  assert.equal(response.status, 404);
  assert.ok(!(h.botRecord()?.events || []).some((event) => event.title === "Lead data deleted"));
  if (h.d1) assert.equal(h.d1._db.prepare("SELECT COUNT(*) AS n FROM siterep_privacy_audit").get().n, 0);

  const byEmail = await h.post("/api/leads/delete", { email: OMAR });
  assert.equal(byEmail.status, 200, "an email that does match still deletes");
  assert.doesNotMatch(JSON.stringify(h.botRecord().leads), /omar@visitor\.test/);
});

test("completing a request with a lead id that matches nothing leaves the request open", async () => {
  const h = harness();
  // A request that names no lead, completed with a lead id that does not exist.
  const queued = await h.post("/api/privacy/deletion-request", { scope: "lead" }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  const request = (await queued.json()).privacyRequests[0];
  assert.equal(request.targetLeadId, undefined);
  const response = await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: request.id, leadId: "999" });
  assert.equal(response.status, 404);
  const stored = h.botRecord();
  assert.equal(stored.privacyRequests.find((item) => item.id === request.id).status, "requested");
  assert.match(JSON.stringify(stored.leads), /jane@visitor\.test/);
});

test("completing a request that names a lead never deletes a different one", async () => {
  const h = harness();
  const queued = await h.post("/api/privacy/deletion-request", { scope: "lead", leadId: 11 }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  const request = (await queued.json()).privacyRequests[0];
  const response = await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: request.id, leadId: 22 });
  assert.equal(response.status, 409);
  const stored = h.botRecord();
  assert.equal(stored.privacyRequests.find((item) => item.id === request.id).status, "requested");
  assert.match(JSON.stringify(stored.leads), /omar@visitor\.test/, "the body's lead is untouched");
  assert.match(JSON.stringify(stored.leads), /jane@visitor\.test/);

  // A request that names no lead takes the one the owner chooses, and keeps it on the record.
  const open = await h.post("/api/privacy/deletion-request", { scope: "lead", note: "Visitor asked by phone." }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  const unnamed = (await open.json()).privacyRequests.find((item) => !item.targetLeadId && item.scope === "lead");
  const chosen = await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: unnamed.id, leadId: 22 });
  assert.equal(chosen.status, 200);
  const done = h.botRecord().privacyRequests.find((item) => item.id === unnamed.id);
  assert.equal(done.status, "completed");
  assert.equal(done.targetLeadId, "22");
  assert.doesNotMatch(JSON.stringify(h.botRecord().leads), /omar@visitor\.test/);
});

test("an owner's deletion request that matches nothing is a 404 with nothing recorded", async () => {
  const h = harness();
  await seedLedger(h);
  const before = (h.botRecord()?.privacyRequests || []).length;
  const response = await h.post("/api/privacy/deletion-request", { scope: "visitor", visitorEmail: "nobody@visitor.test" });
  assert.equal(response.status, 404);
  const stored = h.botRecord();
  assert.equal((stored?.privacyRequests || []).length, before, "no request is created");
  assert.ok(!(stored?.events || []).some((event) => event.title === "Lead data deleted"));
  if (h.d1) assert.equal(h.d1._db.prepare("SELECT COUNT(*) AS n FROM siterep_privacy_audit").get().n, 0);
});

test("a lead id and an email together are refused, so one person never stands in for another", async () => {
  const h = harness();
  const editor = { authorization: `Bearer ${EDITOR_TOKEN}` };
  // Lead 22 is Omar; the email is Jane's.
  const cases = [
    ["/api/leads/delete", { leadId: 22, email: JANE }, undefined],
    ["/api/privacy/deletion-request", { scope: "lead", leadId: 22, visitorEmail: JANE }, undefined],
    ["/api/privacy/deletion-request", { scope: "lead", leadId: 22, visitorEmail: JANE }, editor],
  ];
  for (const [path, body, headers] of cases) {
    const response = await h.post(path, body, headers);
    assert.equal(response.status, 400, `${path} ${headers ? "editor" : "owner"}`);
    assert.match((await response.json()).error, /not both/);
  }
  const open = await h.post("/api/privacy/deletion-request", { scope: "lead" }, editor);
  const request = (await open.json()).privacyRequests[0];
  const complete = await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: request.id, leadId: 22, visitorEmail: JANE });
  assert.equal(complete.status, 400);

  const stored = h.botRecord();
  assert.deepEqual(stored.leads.map((lead) => lead.email).sort(), [JANE, OMAR], "nobody was erased");
  assert.ok(!(stored.privacyRequests || []).some((item) => item.targetEmail || item.targetLeadId), "no mismatched request was stored");
  assert.equal(stored.privacyRequests.find((item) => item.id === request.id).status, "requested");
});

test("deletion routes reject a blank or padded bot id instead of creating a bot", async () => {
  const h = harness();
  const admin = { "x-citerep-admin-key": "test-admin-key" };
  for (const path of ["/api/privacy/deletion-request", "/api/privacy/deletion-request/complete", "/api/leads/delete"]) {
    for (const botId of ["   ", " deletebot"]) {
      const response = await h.rawPost(path, { botId, scope: "account", leadId: 11, privacyRequestId: "x" }, admin);
      assert.equal(response.status, 400, `${path} with ${JSON.stringify(botId)}`);
    }
  }
  const missing = await h.rawPost("/api/privacy/deletion-request", { botId: "ghostbot", scope: "account" }, admin);
  assert.equal(missing.status, 404, "a deletion request never creates a workspace");
  assert.equal(h.botRecord("ghostbot"), undefined);
  assert.equal(h.botRecord("   "), undefined);
});

// The store record and every KV copy (mirror and backups) of it.
function assertNoTraceOf(h, pattern, label) {
  assert.doesNotMatch(JSON.stringify(h.botRecord()), pattern, `${label}: live store`);
  for (const [name, entry] of h.kv._map) assert.doesNotMatch(entry.value, pattern, `${label}: KV ${name}`);
}

test("no request path leaves the deleted visitor's email in the store or its KV copies", async () => {
  const JANE_RE = /jane@visitor\.test/i;

  // Owner path: the request is created and completed in one step.
  const owner = harness();
  const ownerResponse = await owner.post("/api/privacy/deletion-request", { scope: "visitor", visitorEmail: JANE, note: `Erase ${JANE} please.` });
  assert.equal(ownerResponse.status, 200);
  const ownerBody = await ownerResponse.json();
  assert.doesNotMatch(JSON.stringify(ownerBody), JANE_RE);
  assert.doesNotMatch(JSON.stringify(ownerBody), /privacySalt/, "the salt never leaves the store");
  const backupExport = await (await owner.get("/api/export/bot.json?botId=deletebot")).text();
  assert.doesNotMatch(backupExport, /privacySalt/, "the bot backup export leaves the salt out");
  assert.match(owner.botRecord().privacySalt, /^[0-9a-f]{32}$/);
  assertNoTraceOf(owner, JANE_RE, "owner path");
  const ownerDone = owner.botRecord().privacyRequests[0];
  assert.equal(ownerDone.status, "completed");
  assert.equal(ownerDone.targetEmail, undefined);
  assert.match(ownerDone.targetEmailHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ownerDone.note, "Erase [deleted] please.");

  // Queue path: an editor logs a request naming the email, the owner completes it.
  const queued = harness();
  const logged = await queued.post("/api/privacy/deletion-request", { scope: "visitor", visitorEmail: JANE, requesterEmail: JANE }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  const request = (await logged.json()).privacyRequests[0];
  assert.equal(request.targetEmail, JANE, "an open request still names who it is about");
  assert.equal((await queued.post("/api/privacy/deletion-request/complete", { privacyRequestId: request.id })).status, 200);
  assertNoTraceOf(queued, JANE_RE, "queue path");
  const queuedDone = queued.botRecord().privacyRequests.find((item) => item.id === request.id);
  assert.equal(queuedDone.status, "completed");
  assert.match(queuedDone.targetEmailHash, /^sha256:/);
  assert.equal(queuedDone.requesterEmail, "", "a requester address that is the visitor's goes too");

  // An unnamed request completed for a chosen email records only the hash.
  const chosen = harness();
  const open = await chosen.post("/api/privacy/deletion-request", { scope: "visitor" }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  const unnamed = (await open.json()).privacyRequests[0];
  assert.equal((await chosen.post("/api/privacy/deletion-request/complete", { privacyRequestId: unnamed.id, visitorEmail: JANE })).status, 200);
  assertNoTraceOf(chosen, JANE_RE, "chosen target");
  assert.match(chosen.botRecord().privacyRequests.find((item) => item.id === unnamed.id).targetEmailHash, /^sha256:/);

  // The lead inbox delete hashes an older open request that named the email.
  const inbox = harness();
  await inbox.post("/api/privacy/deletion-request", { scope: "visitor", visitorEmail: JANE }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  assert.equal((await inbox.post("/api/leads/delete", { leadId: 11 })).status, 200);
  assertNoTraceOf(inbox, JANE_RE, "lead inbox delete");
  assert.equal(inbox.botRecord().privacyRequests[0].status, "completed");
});

test("the same email hashes the same way within a bot, so a completed request can be matched later", async () => {
  const h = harness();
  await h.post("/api/privacy/deletion-request", { scope: "visitor", visitorEmail: "nobody-yet@visitor.test" }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  await h.post("/api/privacy/deletion-request", { scope: "visitor", visitorEmail: JANE }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  const [first] = h.botRecord().privacyRequests;
  assert.equal((await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: first.id })).status, 200);
  const salt = h.botRecord().privacySalt;
  assert.match(salt, /^[0-9a-f]{32}$/);
  const expected = `sha256:${createHash("sha256").update(`siterep-privacy-request:${salt}:${JANE}`).digest("hex")}`;
  assert.equal(h.botRecord().privacyRequests.find((item) => item.id === first.id).targetEmailHash, expected);
});

test("a backup that still holds the visitor after the scrub makes the result incomplete", async () => {
  const h = harness();
  const put = h.kv.put;
  // The backup write is lost (as if an older copy landed after it).
  h.kv.put = async (name, value, options) => {
    if (name === h.backupKey) return;
    await put(name, value, options);
  };
  const response = await h.post("/api/leads/delete", { leadId: 11 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deletion.complete, false);
  assert.match(body.deletion.warnings.join(" "), /still held this visitor/);
});

test("two deletions running at once on different bots both stay erased in the shared backup", async () => {
  const OTHER_KEY = "own_otherbotownerkey00000000000000000";
  const otherBot = { ...seededBot(), botId: "otherbot", label: "otherbot", ownerAccessKeyHash: sha256(OTHER_KEY) };
  const h = harness({ extraBots: { otherbot: otherBot } });
  await h.kv.put(h.backupKey, JSON.stringify({ bots: { deletebot: seededBot(), otherbot: { ...seededBot(), botId: "otherbot" } } }), { expirationTtl: 3600 });
  const [first, second] = await Promise.all([
    h.post("/api/leads/delete", { leadId: 11 }),
    h.rawPost("/api/leads/delete", { botId: "otherbot", leadId: 22 }, { "x-citerep-owner-key": OTHER_KEY }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const backup = JSON.parse(h.kv._map.get(h.backupKey).value);
  assert.doesNotMatch(JSON.stringify(backup.bots.deletebot), /jane@visitor\.test/);
  assert.doesNotMatch(JSON.stringify(backup.bots.otherbot), /omar@visitor\.test/);
});

test("a failed deletion logs the error's name and code, never its message", async () => {
  const h = harness();
  h.kv.list = async () => {
    const error = new Error(`D1 rejected bound value ${JANE}`);
    error.code = "SQLITE_ERROR";
    throw error;
  };
  const warn = console.warn;
  const logged = [];
  console.warn = (line) => logged.push(String(line));
  let response;
  try {
    response = await h.post("/api/leads/delete", { leadId: 11 });
  } finally {
    console.warn = warn;
  }
  assert.equal(response.status, 503);
  const line = logged.find((item) => item.includes("lead_deletion_failed"));
  assert.ok(line);
  assert.doesNotMatch(line, /jane|bound value/i);
  assert.match(line, /"errorName":"Error"/);
  assert.match(line, /"errorCode":"SQLITE_ERROR"/);
});

test("the dashboard and public trust copy describe self-serve deletion, not ticket-only erasure", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /"\/api\/leads\/delete"/);
  assert.match(app, /"\/api\/privacy\/deletion-request\/complete"/);
  assert.doesNotMatch(worker, /is not instant erasure/);
  assert.match(worker, /Customers can delete a visitor's lead from the dashboard lead inbox/);
  assert.doesNotMatch(worker, /retention period|automatically purge/i);
  // Recovery copies are named honestly: backups and point-in-time recovery
  // are not claimed to be erased at once.
  const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /including the record ledger and recovery backups|lead data instantly/);
  for (const copy of [worker, llms]) assert.match(copy, /point-in-time recovery copies keep earlier states for up to 30 days/);
  assert.match(worker, /D1 Time Travel/);
});

test("privacy internals stay in the store: public shapes are allowlists and every backup writer runs in the coordinator", async () => {
  const source = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const body = (name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  // The salt and stored email hashes reach no owner-facing response or export.
  for (const name of ["toPublicBot", "buildBotBackup"]) {
    assert.doesNotMatch(body(name), /\.\.\.bot\b|\.\.\.record\b|privacySalt/, `${name} lists its fields`);
  }
  // Daily backups are written by the coordinator Durable Object itself, so the
  // deletion scrub (also run inside it) never interleaves with the backup job.
  const uses = [...source.matchAll(/STORE_BACKUP_KEY_PREFIX/g)].map((match) => match.index);
  assert.equal(uses.length, 3, "defined once, written once, listed once");
  const classStart = source.indexOf("export class CiteRepCoordinator extends DurableObject {");
  const classEnd = source.indexOf("\n}\n", classStart);
  const writer = source.indexOf("async writeDailyStoreBackup() {");
  assert.ok(writer > classStart && writer < classEnd, "the daily backup is a coordinator method");
  assert.ok(uses[1] > writer && uses[1] < classEnd, "the only backup key write is in that method");
});

test("a failed audit write is reported, and the erase, completed request and activity entry still land together", async (t) => {
  const h = harness();
  if (!h.d1) return t.skip("node:sqlite not available");
  await h.post("/api/privacy/deletion-request", { scope: "lead", leadId: 11 }, { authorization: `Bearer ${EDITOR_TOKEN}` });
  const request = h.botRecord().privacyRequests[0];
  const prepare = h.d1.prepare;
  h.d1.prepare = (sql) => {
    if (/INSERT INTO siterep_privacy_audit/.test(sql)) throw new Error("audit table unavailable");
    return prepare.call(h.d1, sql);
  };
  try {
    const response = await h.post("/api/privacy/deletion-request/complete", { privacyRequestId: request.id });
    assert.equal(response.status, 200);
    const { deletion } = await response.json();
    assert.equal(deletion.audited, false);
    assert.ok(deletion.warnings.some((warning) => /audit log entry/.test(warning)));
  } finally {
    h.d1.prepare = prepare;
  }
  const stored = h.botRecord();
  assert.deepEqual(stored.leads.map((lead) => lead.email), [OMAR]);
  assert.equal(stored.privacyRequests.find((item) => item.id === request.id).status, "completed");
  assert.ok(stored.events.some((event) => event.title === "Lead data deleted"));
});
