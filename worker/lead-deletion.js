// Self-serve erasure of one visitor's lead data inside a workspace.
//
// A lead is keyed by email and links to the conversation it was captured
// from. Deleting a lead removes the lead, every conversation tied to that
// identity, plus every copy the workspace keeps of them: follow-up tickets,
// escalations, owner notifications, queued webhook payloads, activity
// entries, the D1 record ledger, and the KV recovery snapshots.
//
// Browser session ids are visitor-supplied and can be shared (one tab, two
// people). A session only widens the deletion to its anonymous questions
// when nothing in it belongs to another email or lead; otherwise it is
// skipped and reported, so a deletion never crosses into another lead.

export const LEAD_DELETION_SCOPES = Object.freeze(["lead", "visitor"]);

const LEDGER_ID_CHUNK = 50;
const SCRUBBED_EMAIL = "[deleted]";

export function normalizeLeadEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// Same grouping key the worker uses for shared questions (unknowns and
// escalations): case and punctuation do not matter.
export function normalizeQuestionKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  return {
    emails: new Set(),
    leadIds: new Set(),
    // Every conversation to delete.
    conversationIds: new Set(),
    // The subset reached through the lead or email itself, not a session.
    identityConversationIds: new Set(),
    // Candidate sessions seen on the visitor's own conversations.
    sessionIds: new Set(),
    // Sessions that also hold another email or lead: never followed.
    blockedSessions: new Set(),
    // conversation id -> normalized question, to tell the visitor's shared
    // questions apart from unrelated entries.
    questionKeys: new Map(),
    // Rows the ledger held for this visitor (0 without a ledger).
    ledgerRows: 0,
    // email -> salted one-way hash, filled by the caller (hashing is async).
    // A privacy request that named the email keeps only this hash.
    emailHashes: new Map(),
    // Set when a lead reached by id carries an email other than the one
    // already known: the deletion is refused instead of widened.
    ambiguous: false,
  };
}

export function cloneTargets(targets) {
  return {
    emails: new Set(targets.emails),
    leadIds: new Set(targets.leadIds),
    conversationIds: new Set(targets.conversationIds),
    identityConversationIds: new Set(targets.identityConversationIds),
    sessionIds: new Set(targets.sessionIds),
    blockedSessions: new Set(targets.blockedSessions),
    questionKeys: new Map(targets.questionKeys),
    ledgerRows: targets.ledgerRows,
    emailHashes: new Map(targets.emailHashes || []),
    ambiguous: Boolean(targets.ambiguous),
  };
}

// Resolves a lead id or email to everything that belongs to that visitor in
// the in-store bot record. Returns null when nothing identifies a visitor.
export function leadDeletionTargets(bot, input = {}, options = {}) {
  const targets = emptyLeadDeletionTargets();
  const leadId = idKey(input.leadId);
  const requestedEmail = normalizeLeadEmail(input.email);
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const byId = leadId ? leads.find((lead) => idKey(lead.id) === leadId) : null;
  const email = normalizeLeadEmail(byId?.email) || requestedEmail;
  if (leadId) targets.leadIds.add(leadId);
  if (email) targets.emails.add(email);
  if (!targets.emails.size && !targets.leadIds.size) return null;
  expandTargetsInBot(bot, targets, options);
  return targets;
}

function addConversation(targets, id, question, { identity = false } = {}) {
  const key = idKey(id);
  if (!key) return;
  targets.conversationIds.add(key);
  if (identity) targets.identityConversationIds.add(key);
  if (question !== undefined && question !== null && !targets.questionKeys.has(key)) {
    targets.questionKeys.set(key, normalizeQuestionKey(question));
  }
}

// Folds the in-store copies into the target sets until nothing new appears:
// the visitor's leads pull in the conversations they were captured in, and
// conversations carrying the visitor's email are theirs. Emails never come
// from a conversation or session, and a lead reached by id adds its email
// only while none is known (see addEmailFromLeadId), so the set of people
// never grows. With
// followSessions, each candidate session then adds
// its other (anonymous) conversations, but only when every conversation and
// lead in it belongs to this visitor.
export function expandTargetsInBot(bot, targets, { followSessions = true } = {}) {
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  let size = -1;
  while (size !== identitySize(targets)) {
    size = identitySize(targets);
    for (const lead of leads) {
      if (!leadMatches(lead, targets)) continue;
      if (idKey(lead.id)) targets.leadIds.add(idKey(lead.id));
      addEmailFromLeadId(targets, normalizeLeadEmail(lead.email));
      if (idKey(lead.conversationId)) addConversation(targets, lead.conversationId, undefined, { identity: true });
    }
    for (const conversation of conversations) {
      if (!identityConversationMatches(conversation, targets)) continue;
      addConversation(targets, conversation.id, conversation.question, { identity: true });
      const sessionId = conversationSessionId(conversation);
      if (sessionId) targets.sessionIds.add(sessionId);
    }
  }
  if (followSessions) {
    for (const sessionId of targets.sessionIds) {
      if (targets.blockedSessions.has(sessionId)) continue;
      const members = conversations.filter((conversation) => conversationSessionId(conversation) === sessionId);
      if (sessionHasOtherVisitor(members, leads, targets)) {
        targets.blockedSessions.add(sessionId);
        continue;
      }
      for (const conversation of members) addConversation(targets, conversation.id, conversation.question);
    }
  }
  // Question text of conversations reached by id only.
  for (const conversation of conversations) {
    const key = idKey(conversation?.id);
    if (targets.conversationIds.has(key) && !targets.questionKeys.has(key)) {
      targets.questionKeys.set(key, normalizeQuestionKey(conversation.question));
    }
  }
  return targets;
}

function sessionHasOtherVisitor(members, leads, targets) {
  const memberIds = new Set(members.map((conversation) => idKey(conversation.id)));
  return (
    members.some((conversation) => isForeignEmail(conversationEmail(conversation), targets)) ||
    leads.some((lead) => memberIds.has(idKey(lead.conversationId)) && !isTargetLead(lead, targets))
  );
}

function isForeignEmail(email, targets) {
  return email !== "" && !targets.emails.has(email);
}

function isTargetLead(lead, targets) {
  return targets.leadIds.has(idKey(lead?.id)) || targets.emails.has(normalizeLeadEmail(lead?.email));
}

// One lead id is one lead with one email: the ledger's primary key is
// (bot_id, lead_id) and store lead ids are unique per bot. A lead reached by
// id may supply the email only while no email is known yet (a lead older
// than the store, found in the ledger). A lead that carries a different email
// means the records disagree, so the targets are marked ambiguous and nobody
// is added: a deletion never spreads from one person to a second.
function addEmailFromLeadId(targets, email) {
  if (!email || targets.emails.has(email)) return;
  if (targets.emails.size) {
    targets.ambiguous = true;
    return;
  }
  targets.emails.add(email);
}

function identitySize(targets) {
  return targets.emails.size + targets.leadIds.size + targets.identityConversationIds.size + targets.sessionIds.size;
}

// Leads match by id or email only. A lead with another email is another
// person's record even when it points at one of this visitor's
// conversations, so it is never pulled in.
function leadMatches(lead, targets) {
  return isTargetLead(lead, targets);
}

function identityConversationMatches(conversation, targets) {
  const email = conversationEmail(conversation);
  return targets.identityConversationIds.has(idKey(conversation?.id)) || (email !== "" && targets.emails.has(email));
}

function conversationMatches(conversation, targets) {
  return targets.conversationIds.has(idKey(conversation?.id)) || identityConversationMatches(conversation, targets);
}

// An email mentioned as a whole address, case-insensitive. The characters
// around it must not continue an address: deleting jo@x.com never matches
// bojo@x.com or jo@x.com.au, and deleting jo@x.co never matches jo@x.co.uk.
// A sentence's closing full stop still ends the address.
function emailMentionPattern(email, flags) {
  return new RegExp(`(?<![A-Za-z0-9._%+\\-])${escapeRegExp(email)}(?![A-Za-z0-9_\\-]|\\.[A-Za-z0-9])`, flags);
}

function textMentionsTarget(text, targets) {
  const value = String(text || "");
  if (!value) return false;
  for (const email of targets.emails) {
    if (email && emailMentionPattern(email, "i").test(value)) return true;
  }
  return false;
}

// Multi-lead summaries ("a@x — need · b@y — need") keep their other entries.
function withoutTargetSegments(text, targets) {
  const segments = String(text || "").split(" · ");
  const kept = segments.filter((segment) => !textMentionsTarget(segment, targets));
  return kept.length === segments.length ? null : kept.join(" · ");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Removes the visitor from free text that also covers other people: their
// " · " segment goes, and any remaining mention of their email is masked.
function scrubText(text, targets) {
  if (!textMentionsTarget(text, targets)) return text;
  // A single-subject text has no other segment to keep, so it is masked.
  let next = withoutTargetSegments(text, targets) || String(text);
  for (const email of targets.emails) {
    if (email) next = next.replace(emailMentionPattern(email, "gi"), SCRUBBED_EMAIL);
  }
  return next;
}

function scrubValue(value, targets) {
  if (typeof value === "string") return scrubText(value, targets);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, targets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "email" && targets.emails.has(normalizeLeadEmail(item)) ? "" : scrubValue(item, targets),
      ]),
    );
  }
  return value;
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

// Wording for a shared question once the deleted visitor's own text goes:
// another remaining visitor's wording when there is one, otherwise the
// normalized question every asker shares.
function sharedQuestionWording(bot, key, targets) {
  const other = (Array.isArray(bot?.conversations) ? bot.conversations : []).find(
    (conversation) => !conversationMatches(conversation, targets) && normalizeQuestionKey(conversation.question) === key,
  );
  return other ? String(other.question) : key;
}

// Removes the visitor's records from one bot record in place and returns
// counts only, so callers can log what happened without logging who.
export function eraseLeadFromBot(bot, targets, options = {}) {
  const counts = {
    leads: 0,
    conversations: 0,
    tickets: 0,
    escalations: 0,
    escalationsUnlinked: 0,
    unknowns: 0,
    unknownsUnlinked: 0,
    notifications: 0,
    actions: 0,
    actionsScrubbed: 0,
    events: 0,
    privacyRequestsScrubbed: 0,
  };
  if (!bot || !targets) return counts;
  expandTargetsInBot(bot, targets, options);

  // Shared questions first, while the visitor's conversations are still
  // there to read question text from.
  // Escalations and unknowns are grouped by question across visitors. One
  // asked only by this visitor goes; a shared one stays as a count, unlinked
  // from them and without their wording.
  if (Array.isArray(bot.escalations)) {
    const next = [];
    for (const item of bot.escalations) {
      const linked = idKey(item.conversationId) !== "" && targets.conversationIds.has(idKey(item.conversationId));
      if (!linked) {
        next.push(item);
      } else if (Number(item.count || 1) <= 1) {
        counts.escalations += 1;
      } else {
        counts.escalationsUnlinked += 1;
        const key = normalizeQuestionKey(item.question);
        next.push({ ...item, conversationId: null, count: Number(item.count) - 1, question: sharedQuestionWording(bot, key, targets) });
      }
    }
    bot.escalations = next;
  }
  // An unknown's id is the conversation id of its first asker for chat
  // gaps, but a timestamp for feedback and QA-run gaps, so an id match alone
  // is not proof. It is the visitor's only when the question matches too.
  if (Array.isArray(bot.unknowns)) {
    const next = [];
    for (const item of bot.unknowns) {
      const id = idKey(item.id);
      const key = normalizeQuestionKey(item.question);
      const linked = targets.conversationIds.has(id) && targets.questionKeys.get(id) === key;
      if (!linked) {
        next.push(item);
      } else if (Number(item.count || 1) <= 1) {
        counts.unknowns += 1;
      } else {
        counts.unknownsUnlinked += 1;
        next.push({ ...item, count: Number(item.count) - 1, question: sharedQuestionWording(bot, key, targets) });
      }
    }
    bot.unknowns = next;
  }

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

  // Each queued webhook carries one subject (lead, conversation, ticket or
  // source). An action about this visitor goes; one about someone else that
  // only mentions them in its text is kept with the mention scrubbed, so
  // other leads' deliveries are never dropped.
  if (Array.isArray(bot.actionQueue)) {
    const next = [];
    for (const action of bot.actionQueue) {
      if (metaTouchesTarget(action.payload, targets) || metaTouchesTarget(action.payloadSummary, targets)) {
        counts.actions += 1;
        continue;
      }
      if (textMentionsTarget(JSON.stringify([action.payload ?? null, action.payloadSummary ?? null]), targets)) {
        counts.actionsScrubbed += 1;
        next.push({
          ...action,
          ...(action.payload ? { payload: scrubValue(action.payload, targets) } : {}),
          ...(action.payloadSummary ? { payloadSummary: scrubValue(action.payloadSummary, targets) } : {}),
        });
        continue;
      }
      next.push(action);
    }
    bot.actionQueue = next;
  }

  keep("events", (event) =>
    !(
      metaTouchesTarget(event.meta, targets) ||
      textMentionsTarget(event.title, targets) ||
      textMentionsTarget(event.detail, targets) ||
      textMentionsTarget(JSON.stringify(event.meta ?? null), targets)
    ),
  );

  // Privacy requests stay as the record that a request was made and done,
  // but never with the visitor's address: a named email becomes its salted
  // hash, a requester address that is the visitor's is blanked, and a note
  // that mentions it is masked.
  if (Array.isArray(bot.privacyRequests)) {
    bot.privacyRequests = bot.privacyRequests.map((item) => {
      const named = normalizeLeadEmail(item?.targetEmail);
      const namesTarget = named !== "" && targets.emails.has(named);
      const fromTarget = targets.emails.has(normalizeLeadEmail(item?.requesterEmail));
      const noteMentions = textMentionsTarget(item?.note, targets);
      if (!namesTarget && !fromTarget && !noteMentions) return item;
      counts.privacyRequestsScrubbed += 1;
      const next = { ...item };
      if (namesTarget) {
        delete next.targetEmail;
        const hash = targets.emailHashes?.get(named);
        if (hash) next.targetEmailHash = hash;
      }
      if (fromTarget) next.requesterEmail = "";
      if (noteMentions) next.note = scrubText(item.note, targets);
      return next;
    });
  }

  return counts;
}

// Any change counts, masked mentions and unlinked shared questions included:
// a snapshot that changed only that way still holds the visitor until it is
// rewritten, so it must be rewritten.
export function totalErased(counts) {
  return Object.values(counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

// Applies the same erasure to a JSON snapshot of the whole store (the KV
// recovery mirror and daily backups). Returns { json, unreadable }: json is
// the scrubbed snapshot, or null when it holds nothing for this visitor;
// unreadable is true when the snapshot is not a store this code can scrub,
// so the caller reports it instead of claiming success.
export function eraseLeadFromStoreSnapshot(raw, botId, targets) {
  let store;
  try {
    store = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { json: null, unreadable: true };
  }
  if (!store || typeof store !== "object" || !store.bots || typeof store.bots !== "object" || Array.isArray(store.bots)) {
    return { json: null, unreadable: true };
  }
  const bot = store.bots[botId];
  if (!bot) return { json: null, unreadable: false };
  // Snapshots never follow sessions on their own: the live store and the
  // ledger decided which sessions are safe, and those ids are in targets.
  const counts = eraseLeadFromBot(bot, cloneTargets(targets), { followSessions: false });
  return { json: totalErased(counts) > 0 ? JSON.stringify(store) : null, unreadable: false };
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
// keeps everything). Identity only: sessions are checked separately by
// resolveSessionsInLedger. Errors propagate so a deletion never
// half-succeeds.
// Emails are matched with lower() because rows written before the ledger
// lowercased addresses can still hold mixed case.
export async function expandTargetsInLedger(db, botId, targets) {
  for (const email of targets.emails) {
    const leads = await db
      .prepare("SELECT lead_id, conversation_id FROM siterep_leads WHERE bot_id = ? AND lower(email) = ?")
      .bind(botId, email)
      .all();
    for (const row of leads.results || []) {
      targets.ledgerRows += 1;
      if (idKey(row.lead_id)) targets.leadIds.add(idKey(row.lead_id));
      if (idKey(row.conversation_id)) addConversation(targets, row.conversation_id, undefined, { identity: true });
    }
  }
  for (const ids of chunks(targets.leadIds)) {
    const leads = await db
      .prepare(`SELECT email, conversation_id FROM siterep_leads WHERE bot_id = ? AND lead_id IN (${placeholders(ids.length)})`)
      .bind(botId, ...ids)
      .all();
    for (const row of leads.results || []) {
      targets.ledgerRows += 1;
      addEmailFromLeadId(targets, normalizeLeadEmail(row.email));
      if (idKey(row.conversation_id)) addConversation(targets, row.conversation_id, undefined, { identity: true });
    }
  }

  const absorb = (rows) => {
    for (const row of rows || []) {
      targets.ledgerRows += 1;
      addConversation(targets, row.conversation_id, row.question, { identity: true });
      const sessionId = conversationSessionId(parseJson(row.conversation_json));
      if (sessionId) targets.sessionIds.add(sessionId);
    }
  };
  for (const email of targets.emails) {
    const rows = await db
      .prepare("SELECT conversation_id, question, conversation_json FROM siterep_conversations WHERE bot_id = ? AND lower(visitor_email) = ?")
      .bind(botId, email)
      .all();
    absorb(rows.results);
  }
  for (const ids of chunks(targets.identityConversationIds)) {
    const rows = await db
      .prepare(
        `SELECT conversation_id, question, conversation_json FROM siterep_conversations WHERE bot_id = ? AND conversation_id IN (${placeholders(ids.length)})`,
      )
      .bind(botId, ...ids)
      .all();
    absorb(rows.results);
  }
  return targets;
}

// Decides each candidate session once, against both the live bot record and
// the ledger: a session is followed only when none of its conversations
// carries another email and no other lead was captured in it. Followed
// sessions add their conversations; the rest are blocked and counted.
export async function resolveSessions(db, botId, bot, targets) {
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  const candidates = [...targets.sessionIds].filter((sessionId) => !targets.blockedSessions.has(sessionId));
  // The ledger has no session column, so the bot's rows are scanned by text
  // (bot_id is indexed). One scan covers every candidate session.
  const ledgerMembers = new Map(candidates.map((sessionId) => [sessionId, []]));
  if (db) {
    for (const group of chunks(candidates, 20)) {
      const rows = await db
        .prepare(
          `SELECT conversation_id, question, visitor_email, conversation_json FROM siterep_conversations WHERE bot_id = ? AND (${group
            .map(() => "instr(conversation_json, ?) > 0")
            .join(" OR ")})`,
        )
        .bind(botId, ...group.map((sessionId) => `"sessionId":${JSON.stringify(sessionId)}`))
        .all();
      for (const row of rows.results || []) {
        const conversation = parseJson(row.conversation_json);
        const list = ledgerMembers.get(conversationSessionId(conversation));
        if (!list) continue;
        list.push({
          id: idKey(row.conversation_id),
          question: row.question,
          email: normalizeLeadEmail(row.visitor_email) || conversationEmail(conversation),
        });
      }
    }
  }
  for (const sessionId of candidates) {
    const members = conversations
      .filter((conversation) => conversationSessionId(conversation) === sessionId)
      .map((conversation) => ({ id: idKey(conversation.id), question: conversation.question, email: conversationEmail(conversation) }))
      .concat(ledgerMembers.get(sessionId) || []);
    const memberIds = new Set(members.map((member) => member.id).filter(Boolean));
    let foreign =
      members.some((member) => isForeignEmail(member.email, targets)) ||
      leads.some((lead) => memberIds.has(idKey(lead.conversationId)) && !isTargetLead(lead, targets));
    if (!foreign && db) {
      for (const ids of chunks(memberIds)) {
        const rows = await db
          .prepare(`SELECT lead_id, email FROM siterep_leads WHERE bot_id = ? AND conversation_id IN (${placeholders(ids.length)})`)
          .bind(botId, ...ids)
          .all();
        if ((rows.results || []).some((row) => !isTargetLead({ id: row.lead_id, email: row.email }, targets))) foreign = true;
      }
    }
    if (foreign) {
      targets.blockedSessions.add(sessionId);
      continue;
    }
    for (const member of members) addConversation(targets, member.id, member.question);
  }
  return targets;
}

// Whether anything stored still identifies this visitor: a lead or a
// conversation in the live record, or a ledger row.
export function targetsFoundAnything(bot, targets) {
  if (targets.ledgerRows > 0) return true;
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  return leads.some((lead) => leadMatches(lead, targets)) || conversations.some((conversation) => conversationMatches(conversation, targets));
}

export async function deleteLeadLedgerRows(db, botId, targets) {
  const removed = { leads: 0, conversations: 0 };
  const changes = (result) => Number(result?.meta?.changes || 0);
  for (const email of targets.emails) {
    removed.leads += changes(await db.prepare("DELETE FROM siterep_leads WHERE bot_id = ? AND lower(email) = ?").bind(botId, email).run());
    removed.conversations += changes(
      await db.prepare("DELETE FROM siterep_conversations WHERE bot_id = ? AND lower(visitor_email) = ?").bind(botId, email).run(),
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
