// Self-serve erasure of one visitor's lead data inside a workspace.
//
// A lead is keyed by email, links to the conversation it was captured from,
// and that conversation shares a browser session id with the visitor's other
// questions. Deleting a lead removes all of those, plus every copy the
// workspace keeps of them: follow-up tickets, escalations, owner
// notifications, queued webhook payloads, activity entries, the D1 record
// ledger, and the KV recovery snapshots.

export const LEAD_DELETION_SCOPES = Object.freeze(["lead", "visitor"]);

const LEDGER_ID_CHUNK = 50;

export function normalizeLeadEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function idKey(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function conversationSessionId(conversation) {
  return String(conversation?.sessionId || conversation?.visitor?.sessionId || "").trim();
}

function conversationEmail(conversation) {
  return normalizeLeadEmail(conversation?.visitor?.email);
}

export function emptyLeadDeletionTargets() {
  return { emails: new Set(), leadIds: new Set(), conversationIds: new Set(), sessionIds: new Set() };
}

// Resolves a lead id or email to everything that belongs to that visitor in
// the in-store bot record. Returns null when nothing identifies a visitor.
export function leadDeletionTargets(bot, input = {}, targets = emptyLeadDeletionTargets()) {
  const leadId = idKey(input.leadId);
  const requestedEmail = normalizeLeadEmail(input.email);
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const byId = leadId ? leads.find((lead) => idKey(lead.id) === leadId) : null;
  const email = normalizeLeadEmail(byId?.email) || requestedEmail;
  if (leadId) targets.leadIds.add(leadId);
  if (email) targets.emails.add(email);
  if (!targets.emails.size && !targets.leadIds.size) return null;
  expandTargetsInBot(bot, targets);
  return targets;
}

// Folds the in-store copies into the target sets until nothing new appears:
// a lead pulls in its conversation, a conversation pulls in its session, and
// a session pulls in the visitor's other conversations.
export function expandTargetsInBot(bot, targets) {
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  let size = -1;
  while (size !== targetSize(targets)) {
    size = targetSize(targets);
    for (const lead of leads) {
      if (!leadMatches(lead, targets)) continue;
      if (idKey(lead.id)) targets.leadIds.add(idKey(lead.id));
      if (normalizeLeadEmail(lead.email)) targets.emails.add(normalizeLeadEmail(lead.email));
      if (idKey(lead.conversationId)) targets.conversationIds.add(idKey(lead.conversationId));
    }
    for (const conversation of conversations) {
      if (!conversationMatches(conversation, targets)) continue;
      targets.conversationIds.add(idKey(conversation.id));
      const sessionId = conversationSessionId(conversation);
      if (sessionId) targets.sessionIds.add(sessionId);
    }
  }
  return targets;
}

function targetSize(targets) {
  return targets.emails.size + targets.leadIds.size + targets.conversationIds.size + targets.sessionIds.size;
}

function leadMatches(lead, targets) {
  return (
    targets.leadIds.has(idKey(lead?.id)) ||
    targets.emails.has(normalizeLeadEmail(lead?.email)) ||
    (idKey(lead?.conversationId) !== "" && targets.conversationIds.has(idKey(lead.conversationId)))
  );
}

function conversationMatches(conversation, targets) {
  const sessionId = conversationSessionId(conversation);
  const email = conversationEmail(conversation);
  return (
    targets.conversationIds.has(idKey(conversation?.id)) ||
    (email !== "" && targets.emails.has(email)) ||
    (sessionId !== "" && targets.sessionIds.has(sessionId))
  );
}

function textMentionsTarget(text, targets) {
  const value = String(text || "").toLowerCase();
  if (!value) return false;
  for (const email of targets.emails) {
    if (email && value.includes(email)) return true;
  }
  return false;
}

// Multi-lead summaries ("a@x — need · b@y — need") keep their other entries.
function withoutTargetSegments(text, targets) {
  const segments = String(text || "").split(" · ");
  const kept = segments.filter((segment) => !textMentionsTarget(segment, targets));
  return kept.length === segments.length ? null : kept.join(" · ");
}

function metaTouchesTarget(meta, targets) {
  if (!meta || typeof meta !== "object") return false;
  return (
    (idKey(meta.leadId) !== "" && targets.leadIds.has(idKey(meta.leadId))) ||
    (idKey(meta.conversationId) !== "" && targets.conversationIds.has(idKey(meta.conversationId))) ||
    (normalizeLeadEmail(meta.email) !== "" && targets.emails.has(normalizeLeadEmail(meta.email)))
  );
}

function dedupeKeyTouchesTarget(key, targets) {
  const value = String(key || "").toLowerCase();
  for (const email of targets.emails) {
    if (email && value === `lead:${email}`) return true;
  }
  return false;
}

// Removes the visitor's records from one bot record in place and returns
// counts only, so callers can log what happened without logging who.
export function eraseLeadFromBot(bot, targets) {
  const counts = {
    leads: 0,
    conversations: 0,
    tickets: 0,
    escalations: 0,
    unknowns: 0,
    notifications: 0,
    actions: 0,
    events: 0,
  };
  if (!bot || !targets) return counts;
  expandTargetsInBot(bot, targets);

  const keep = (field, predicate) => {
    if (!Array.isArray(bot[field])) return;
    const before = bot[field].length;
    bot[field] = bot[field].filter(predicate);
    counts[field] += before - bot[field].length;
  };

  keep("leads", (lead) => !leadMatches(lead, targets));
  keep("conversations", (conversation) => !conversationMatches(conversation, targets));
  keep("tickets", (ticket) =>
    !(
      targets.leadIds.has(idKey(ticket.leadId)) ||
      (idKey(ticket.conversationId) !== "" && targets.conversationIds.has(idKey(ticket.conversationId))) ||
      targets.emails.has(normalizeLeadEmail(ticket.visitorEmail)) ||
      dedupeKeyTouchesTarget(ticket.dedupeKey, targets)
    ),
  );

  // Escalations and unknowns are shared by every visitor who asked the same
  // question; only drop the ones that came from this visitor alone.
  if (Array.isArray(bot.escalations)) {
    const next = [];
    for (const item of bot.escalations) {
      const linked = idKey(item.conversationId) !== "" && targets.conversationIds.has(idKey(item.conversationId));
      if (linked && Number(item.count || 1) <= 1) {
        counts.escalations += 1;
        continue;
      }
      next.push(linked ? { ...item, conversationId: null } : item);
    }
    bot.escalations = next;
  }
  keep("unknowns", (item) => !(targets.conversationIds.has(idKey(item.id)) && Number(item.count || 1) <= 1));

  if (Array.isArray(bot.notifications)) {
    const next = [];
    for (const notification of bot.notifications) {
      if (metaTouchesTarget(notification.meta, targets) || dedupeKeyTouchesTarget(notification.dedupeKey, targets)) {
        counts.notifications += 1;
        continue;
      }
      if (textMentionsTarget(notification.title, targets) || textMentionsTarget(notification.detail, targets)) {
        const detail = withoutTargetSegments(notification.detail, targets);
        if (detail && !textMentionsTarget(notification.title, targets) && !textMentionsTarget(detail, targets)) {
          next.push({ ...notification, detail });
        } else {
          counts.notifications += 1;
        }
        continue;
      }
      next.push(notification);
    }
    bot.notifications = next;
  }

  if (Array.isArray(bot.actionQueue)) {
    const before = bot.actionQueue.length;
    bot.actionQueue = bot.actionQueue.filter(
      (action) =>
        !metaTouchesTarget(action.payload, targets) &&
        !metaTouchesTarget(action.payloadSummary, targets) &&
        !textMentionsTarget(JSON.stringify(action.payload || {}), targets),
    );
    counts.actions += before - bot.actionQueue.length;
  }

  keep("events", (event) =>
    !(metaTouchesTarget(event.meta, targets) || textMentionsTarget(event.title, targets) || textMentionsTarget(event.detail, targets)),
  );

  return counts;
}

export function totalErased(counts) {
  return Object.values(counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

// Applies the same erasure to a JSON snapshot of the whole store (the KV
// recovery mirror and daily backups). Returns the new JSON, or null when the
// snapshot holds nothing for this visitor.
export function eraseLeadFromStoreSnapshot(raw, botId, targets) {
  let store;
  try {
    store = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  const bot = store?.bots?.[botId];
  if (!bot) return null;
  const snapshotTargets = cloneTargets(targets);
  const counts = eraseLeadFromBot(bot, snapshotTargets);
  return totalErased(counts) > 0 ? JSON.stringify(store) : null;
}

export function cloneTargets(targets) {
  return {
    emails: new Set(targets.emails),
    leadIds: new Set(targets.leadIds),
    conversationIds: new Set(targets.conversationIds),
    sessionIds: new Set(targets.sessionIds),
  };
}

function chunks(values, size = LEDGER_ID_CHUNK) {
  const list = [...values];
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

function placeholders(count) {
  return new Array(count).fill("?").join(", ");
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Widens the targets with D1 ledger rows the in-store record no longer holds
// (the store keeps the newest 200 leads and 1000 conversations; the ledger
// keeps everything). Errors propagate so a deletion never half-succeeds.
export async function expandTargetsInLedger(db, botId, targets) {
  for (const email of targets.emails) {
    const leads = await db
      .prepare("SELECT lead_id, conversation_id FROM siterep_leads WHERE bot_id = ? AND email = ?")
      .bind(botId, email)
      .all();
    for (const row of leads.results || []) {
      if (idKey(row.lead_id)) targets.leadIds.add(idKey(row.lead_id));
      if (idKey(row.conversation_id)) targets.conversationIds.add(idKey(row.conversation_id));
    }
  }
  for (const ids of chunks(targets.leadIds)) {
    const leads = await db
      .prepare(`SELECT email, conversation_id FROM siterep_leads WHERE bot_id = ? AND lead_id IN (${placeholders(ids.length)})`)
      .bind(botId, ...ids)
      .all();
    for (const row of leads.results || []) {
      if (normalizeLeadEmail(row.email)) targets.emails.add(normalizeLeadEmail(row.email));
      if (idKey(row.conversation_id)) targets.conversationIds.add(idKey(row.conversation_id));
    }
  }

  const absorb = (rows) => {
    for (const row of rows || []) {
      if (idKey(row.conversation_id)) targets.conversationIds.add(idKey(row.conversation_id));
      const conversation = parseJson(row.conversation_json);
      const sessionId = conversationSessionId(conversation);
      if (sessionId) targets.sessionIds.add(sessionId);
    }
  };
  for (const email of targets.emails) {
    const rows = await db
      .prepare("SELECT conversation_id, conversation_json FROM siterep_conversations WHERE bot_id = ? AND visitor_email = ?")
      .bind(botId, email)
      .all();
    absorb(rows.results);
  }
  for (const ids of chunks(targets.conversationIds)) {
    const rows = await db
      .prepare(`SELECT conversation_id, conversation_json FROM siterep_conversations WHERE bot_id = ? AND conversation_id IN (${placeholders(ids.length)})`)
      .bind(botId, ...ids)
      .all();
    absorb(rows.results);
  }
  for (const sessionId of [...targets.sessionIds]) {
    const rows = await db
      .prepare("SELECT conversation_id, conversation_json FROM siterep_conversations WHERE bot_id = ? AND instr(conversation_json, ?) > 0")
      .bind(botId, `"sessionId":${JSON.stringify(sessionId)}`)
      .all();
    absorb(rows.results);
  }
  return targets;
}

export async function deleteLeadLedgerRows(db, botId, targets) {
  const removed = { leads: 0, conversations: 0 };
  const changes = (result) => Number(result?.meta?.changes || 0);
  for (const email of targets.emails) {
    removed.leads += changes(await db.prepare("DELETE FROM siterep_leads WHERE bot_id = ? AND email = ?").bind(botId, email).run());
    removed.conversations += changes(
      await db.prepare("DELETE FROM siterep_conversations WHERE bot_id = ? AND visitor_email = ?").bind(botId, email).run(),
    );
  }
  for (const ids of chunks(targets.leadIds)) {
    removed.leads += changes(
      await db.prepare(`DELETE FROM siterep_leads WHERE bot_id = ? AND lead_id IN (${placeholders(ids.length)})`).bind(botId, ...ids).run(),
    );
  }
  for (const ids of chunks(targets.conversationIds)) {
    removed.conversations += changes(
      await db
        .prepare(`DELETE FROM siterep_conversations WHERE bot_id = ? AND conversation_id IN (${placeholders(ids.length)})`)
        .bind(botId, ...ids)
        .run(),
    );
  }
  return removed;
}
