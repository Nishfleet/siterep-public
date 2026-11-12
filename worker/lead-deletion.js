
export const LEAD_DELETION_SCOPES = Object.freeze(["lead", "visitor"]);

/**
 * @typedef {object} LeadDeletionTargets
 * @property {Set<string>} emails
 * @property {Set<string>} leadIds
 * @property {Set<string>} conversationIds
 * @property {Set<string>} identityConversationIds
 * @property {Set<string>} sessionIds
 * @property {Set<string>} blockedSessions
 * @property {Map<string, string>} questionKeys
 * @property {number} ledgerRows
 * @property {Map<string, string>} emailHashes
 * @property {boolean} ambiguous
 */

/**
 * @typedef {object} BotVisitor
 * @property {unknown} [sessionId]
 * @property {unknown} [email]
 */

/**
 * @typedef {object} BotLead
 * @property {unknown} [id]
 * @property {unknown} [email]
 * @property {unknown} [conversationId]
 * @property {unknown} [firstSeenAt]
 * @property {unknown} [updatedAt]
 * @property {unknown} [lastSeenAt]
 * @property {unknown} [createdAt]
 * @property {{ createdAt?: unknown }} [feedback]
 */

/**
 * @typedef {object} BotConversation
 * @property {unknown} [id]
 * @property {unknown} [question]
 * @property {unknown} [sessionId]
 * @property {BotVisitor} [visitor]
 * @property {unknown} [firstSeenAt]
 * @property {unknown} [updatedAt]
 * @property {unknown} [lastSeenAt]
 * @property {unknown} [createdAt]
 * @property {{ createdAt?: unknown }} [feedback]
 */

/**
 * @typedef {object} BotEscalation
 * @property {unknown} [conversationId]
 * @property {unknown} [count]
 * @property {unknown} [question]
 */

/**
 * @typedef {object} BotUnknownEntry
 * @property {unknown} [id]
 * @property {unknown} [question]
 * @property {unknown} [count]
 */

/**
 * @typedef {object} BotTicket
 * @property {unknown} [leadId]
 * @property {unknown} [conversationId]
 * @property {unknown} [visitorEmail]
 * @property {unknown} [dedupeKey]
 */

/**
 * @typedef {object} BotNotification
 * @property {Record<string, unknown> | null} [meta]
 * @property {unknown} [dedupeKey]
 * @property {unknown} [title]
 * @property {unknown} [detail]
 */

/**
 * @typedef {object} BotAction
 * @property {unknown} [payload]
 * @property {unknown} [payloadSummary]
 */

/**
 * @typedef {object} BotEvent
 * @property {unknown} [meta]
 * @property {unknown} [title]
 * @property {unknown} [detail]
 */

/**
 * @typedef {object} BotPrivacyRequest
 * @property {unknown} [targetEmail]
 * @property {unknown} [requesterEmail]
 * @property {unknown} [note]
 * @property {unknown} [targetEmailHash]
 */

/**
 * @typedef {object} DeletableBot
 * @property {BotLead[]} [leads]
 * @property {BotConversation[]} [conversations]
 * @property {BotEscalation[]} [escalations]
 * @property {BotUnknownEntry[]} [unknowns]
 * @property {BotTicket[]} [tickets]
 * @property {BotNotification[]} [notifications]
 * @property {BotAction[]} [actionQueue]
 * @property {BotEvent[]} [events]
 * @property {BotPrivacyRequest[]} [privacyRequests]
 */

/**
 * @typedef {object} DeletionCounts
 * @property {number} leads
 * @property {number} conversations
 * @property {number} tickets
 * @property {number} escalations
 * @property {number} escalationsUnlinked
 * @property {number} unknowns
 * @property {number} unknownsUnlinked
 * @property {number} notifications
 * @property {number} actions
 * @property {number} actionsScrubbed
 * @property {number} events
 * @property {number} privacyRequestsScrubbed
 */

const LEDGER_ID_CHUNK = 50;
const SCRUBBED_EMAIL = "[deleted]";

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLeadEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * @param {string} email
 * @returns {boolean}
 */
function isAddress(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeQuestionKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function idKey(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * @param {BotConversation | null} conversation
 * @returns {string}
 */
function conversationSessionId(conversation) {
  return String(conversation?.sessionId || conversation?.visitor?.sessionId || "").trim();
}

/**
 * @param {BotConversation | null} conversation
 * @returns {string}
 */
function conversationEmail(conversation) {
  return normalizeLeadEmail(conversation?.visitor?.email);
}

/**
 * @returns {LeadDeletionTargets}
 */
export function emptyLeadDeletionTargets() {
  return {
    emails: new Set(),
    leadIds: new Set(),
    conversationIds: new Set(),
    identityConversationIds: new Set(),
    sessionIds: new Set(),
    blockedSessions: new Set(),
    questionKeys: new Map(),
    ledgerRows: 0,
    emailHashes: new Map(),
    ambiguous: false,
  };
}

/**
 * @param {LeadDeletionTargets} targets
 * @returns {LeadDeletionTargets}
 */
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

/**
 * @param {DeletableBot} bot
 * @param {{ leadId?: unknown, email?: unknown }} [input]
 * @param {{ followSessions?: boolean }} [options]
 * @returns {LeadDeletionTargets | null}
 */
export function leadDeletionTargets(bot, input = {}, options = {}) {
  const targets = emptyLeadDeletionTargets();
  const leadId = idKey(input.leadId);
  const requestedEmail = normalizeLeadEmail(input.email);
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const byId = leadId ? leads.find((lead) => idKey(lead.id) === leadId) : null;
  const email = normalizeLeadEmail(byId?.email) || requestedEmail;
  if (leadId) targets.leadIds.add(leadId);
  if (isAddress(email)) targets.emails.add(email);
  if (!targets.emails.size && !targets.leadIds.size) return null;
  expandTargetsInBot(bot, targets, options);
  return targets;
}

/**
 * @param {LeadDeletionTargets} targets
 * @param {unknown} id
 * @param {unknown} [question]
 * @param {{ identity?: boolean }} [options]
 */
function addConversation(targets, id, question, { identity = false } = {}) {
  const key = idKey(id);
  if (!key) return;
  targets.conversationIds.add(key);
  if (identity) targets.identityConversationIds.add(key);
  if (question !== undefined && question !== null && !targets.questionKeys.has(key)) {
    targets.questionKeys.set(key, normalizeQuestionKey(question));
  }
}

/**
 * @param {DeletableBot} bot
 * @param {LeadDeletionTargets} targets
 * @param {{ followSessions?: boolean }} [options]
 * @returns {LeadDeletionTargets}
 */
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
  for (const conversation of conversations) {
    const key = idKey(conversation?.id);
    if (targets.conversationIds.has(key) && !targets.questionKeys.has(key)) {
      targets.questionKeys.set(key, normalizeQuestionKey(conversation.question));
    }
  }
  return targets;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function activityTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The visitor's own latest activity, not an owner status or note edit. A
 * conversation's updatedAt can move when the owner reviews it, so it is only
 * used when older records have no visitor timestamp at all.
 * @param {BotLead | BotConversation | null | undefined} record
 * @returns {number}
 */
export function recordVisitorActivityMs(record) {
  const visitorActivity = Math.max(
    activityTimestampMs(record?.createdAt),
    activityTimestampMs(record?.firstSeenAt),
    activityTimestampMs(record?.lastSeenAt),
    activityTimestampMs(record?.feedback?.createdAt),
  );
  return visitorActivity || activityTimestampMs(record?.updatedAt);
}

/**
 * @param {DeletableBot} bot
 * @param {LeadDeletionTargets} targets
 * @returns {number}
 */
function deletionTargetsLastActivityMs(bot, targets) {
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  let latest = 0;
  for (const lead of leads) {
    if (!targets.leadIds.has(idKey(lead.id)) && !targets.emails.has(normalizeLeadEmail(lead.email))) continue;
    latest = Math.max(latest, recordVisitorActivityMs(lead));
  }
  for (const conversation of conversations) {
    if (!targets.conversationIds.has(idKey(conversation.id)) && !targets.emails.has(conversationEmail(conversation))) continue;
    latest = Math.max(latest, recordVisitorActivityMs(conversation));
  }
  return latest;
}

/**
 * Merge one target set into another without dropping any identifier or
 * recovery-copy hint.
 * @param {LeadDeletionTargets} target
 * @param {LeadDeletionTargets} source
 * @returns {LeadDeletionTargets}
 */
export function mergeLeadDeletionTargets(target, source) {
  for (const value of source.emails) target.emails.add(value);
  for (const value of source.leadIds) target.leadIds.add(value);
  for (const value of source.conversationIds) target.conversationIds.add(value);
  for (const value of source.identityConversationIds) target.identityConversationIds.add(value);
  for (const value of source.sessionIds) target.sessionIds.add(value);
  for (const value of source.blockedSessions) target.blockedSessions.add(value);
  for (const [key, value] of source.questionKeys) {
    if (!target.questionKeys.has(key)) target.questionKeys.set(key, value);
  }
  for (const [key, value] of source.emailHashes || []) {
    if (!target.emailHashes.has(key)) target.emailHashes.set(key, value);
  }
  target.ledgerRows += Number(source.ledgerRows) || 0;
  target.ambiguous = target.ambiguous || Boolean(source.ambiguous);
  return target;
}

/**
 * Build the records tied to one conversation, including the rest of its
 * browser session when that session belongs to the same visitor.
 * @param {DeletableBot} bot
 * @param {unknown} conversationId
 * @param {{ followSessions?: boolean }} [options]
 * @returns {LeadDeletionTargets | null}
 */
export function conversationDeletionTargets(bot, conversationId, options = {}) {
  const key = idKey(conversationId);
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  const conversation = conversations.find((item) => idKey(item.id) === key);
  if (!conversation) return null;
  const targets = emptyLeadDeletionTargets();
  const email = conversationEmail(conversation);
  if (isAddress(email)) targets.emails.add(email);
  const sessionId = conversationSessionId(conversation);
  if (sessionId) targets.sessionIds.add(sessionId);
  addConversation(targets, conversation.id, conversation.question, { identity: true });
  return expandTargetsInBot(bot, targets, options);
}

/**
 * Return everything that must be deleted once a visitor has been silent for
 * the retention period. Leads and conversations are grouped by the same
 * identifiers used by manual deletion, so a recent message protects the whole
 * visitor record while an old anonymous session can still be removed.
 * @param {DeletableBot} bot
 * @param {number} cutoffMs
 * @returns {LeadDeletionTargets}
 */
export function leadRetentionTargets(bot, cutoffMs) {
  const targets = emptyLeadDeletionTargets();
  const cutoff = Number(cutoffMs);
  if (!Number.isFinite(cutoff)) return targets;

  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  const leadTargets = [];
  const leadConversationIds = new Set();

  for (const lead of leads) {
    const input = idKey(lead.id) ? { leadId: lead.id } : { email: lead.email };
    const candidate = leadDeletionTargets(bot, input, { followSessions: true });
    if (!candidate) continue;
    leadTargets.push(candidate);
    for (const id of candidate.conversationIds) leadConversationIds.add(id);
  }

  for (const candidate of leadTargets) {
    const latest = deletionTargetsLastActivityMs(bot, candidate);
    if (latest > 0 && latest < cutoff) mergeLeadDeletionTargets(targets, candidate);
  }

  for (const conversation of conversations) {
    const id = idKey(conversation.id);
    if (!id || leadConversationIds.has(id)) continue;
    const latest = recordVisitorActivityMs(conversation);
    if (!latest || latest >= cutoff) continue;
    const candidate = conversationDeletionTargets(bot, id, { followSessions: true });
    if (!candidate) continue;
    const candidateLatest = deletionTargetsLastActivityMs(bot, candidate);
    if (candidateLatest > 0 && candidateLatest < cutoff) mergeLeadDeletionTargets(targets, candidate);
  }

  return targets;
}

/**
 * @param {BotConversation[]} members
 * @param {BotLead[]} leads
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function sessionHasOtherVisitor(members, leads, targets) {
  const memberIds = new Set(members.map((conversation) => idKey(conversation.id)));
  return (
    members.some((conversation) => isForeignEmail(conversationEmail(conversation), targets)) ||
    leads.some((lead) => memberIds.has(idKey(lead.conversationId)) && !isTargetLead(lead, targets))
  );
}

/**
 * @param {string} email
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function isForeignEmail(email, targets) {
  return email !== "" && !targets.emails.has(email);
}

/**
 * @param {{ id?: unknown, email?: unknown }} lead
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function isTargetLead(lead, targets) {
  return targets.leadIds.has(idKey(lead?.id)) || targets.emails.has(normalizeLeadEmail(lead?.email));
}

/**
 * @param {LeadDeletionTargets} targets
 * @param {string} email
 */
function addEmailFromLeadId(targets, email) {
  if (!isAddress(email) || targets.emails.has(email)) return;
  if (targets.emails.size) {
    targets.ambiguous = true;
    return;
  }
  targets.emails.add(email);
}

/**
 * @param {LeadDeletionTargets} targets
 * @returns {number}
 */
function identitySize(targets) {
  return targets.emails.size + targets.leadIds.size + targets.identityConversationIds.size + targets.sessionIds.size;
}

/**
 * @param {{ id?: unknown, email?: unknown }} lead
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function leadMatches(lead, targets) {
  return isTargetLead(lead, targets);
}

/**
 * @param {{ id?: unknown, visitor?: BotVisitor }} conversation
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function identityConversationMatches(conversation, targets) {
  const email = conversationEmail(conversation);
  return targets.identityConversationIds.has(idKey(conversation?.id)) || (email !== "" && targets.emails.has(email));
}

/**
 * @param {BotConversation} conversation
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function conversationMatches(conversation, targets) {
  return targets.conversationIds.has(idKey(conversation?.id)) || identityConversationMatches(conversation, targets);
}

/**
 * @param {string} email
 * @param {string} flags
 * @returns {RegExp}
 */
function emailMentionPattern(email, flags) {
  return new RegExp(`(?<![A-Za-z0-9._%+\\-])${escapeRegExp(email)}(?![A-Za-z0-9_\\-]|\\.[A-Za-z0-9])`, flags); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
}

/**
 * @param {unknown} text
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function textMentionsTarget(text, targets) {
  const value = String(text || "");
  if (!value) return false;
  for (const email of targets.emails) {
    if (email && emailMentionPattern(email, "i").test(value)) return true;
  }
  return false;
}

/**
 * @param {unknown} text
 * @param {LeadDeletionTargets} targets
 * @returns {string | null}
 */
function withoutTargetSegments(text, targets) {
  const segments = String(text || "").split(" · ");
  const kept = segments.filter((segment) => !textMentionsTarget(segment, targets));
  return kept.length === segments.length ? null : kept.join(" · ");
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {unknown} text
 * @param {LeadDeletionTargets} targets
 * @returns {unknown}
 */
function scrubText(text, targets) {
  if (!textMentionsTarget(text, targets)) return text;
  let next = withoutTargetSegments(text, targets) || String(text);
  for (const email of targets.emails) {
    if (email) next = next.replace(emailMentionPattern(email, "gi"), SCRUBBED_EMAIL);
  }
  return next;
}

/**
 * @param {unknown} value
 * @param {LeadDeletionTargets} targets
 * @returns {unknown}
 */
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

/**
 * @param {unknown} meta
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function metaTouchesTarget(meta, targets) {
  if (!meta || typeof meta !== "object") return false;
  const record = Object.fromEntries(Object.entries(meta));
  return (
    (idKey(record.leadId) !== "" && targets.leadIds.has(idKey(record.leadId))) ||
    (idKey(record.conversationId) !== "" && targets.conversationIds.has(idKey(record.conversationId))) ||
    (normalizeLeadEmail(record.email) !== "" && targets.emails.has(normalizeLeadEmail(record.email)))
  );
}

/**
 * @param {unknown} key
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
function dedupeKeyTouchesTarget(key, targets) {
  const value = String(key || "").toLowerCase();
  for (const email of targets.emails) {
    if (email && value === `lead:${email}`) return true;
  }
  return false;
}

/**
 * @param {DeletableBot} bot
 * @param {string} key
 * @param {LeadDeletionTargets} targets
 * @returns {string}
 */
function sharedQuestionWording(bot, key, targets) {
  const other = (Array.isArray(bot?.conversations) ? bot.conversations : []).find(
    (conversation) => !conversationMatches(conversation, targets) && normalizeQuestionKey(conversation.question) === key,
  );
  return other ? String(other.question) : key;
}

/**
 * @param {DeletableBot} bot
 * @param {LeadDeletionTargets} targets
 * @param {{ followSessions?: boolean }} [options]
 * @returns {DeletionCounts}
 */
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

  if (Array.isArray(bot.escalations)) {
    /** @type {BotEscalation[]} */
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
  if (Array.isArray(bot.unknowns)) {
    /** @type {BotUnknownEntry[]} */
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
        next.push({
          ...item,
          id: `unknown_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`,
          count: Number(item.count) - 1,
          question: sharedQuestionWording(bot, key, targets),
        });
      }
    }
    bot.unknowns = next;
  }

  if (Array.isArray(bot.leads)) {
    const before = bot.leads.length;
    bot.leads = bot.leads.filter((lead) => !leadMatches(lead, targets));
    counts.leads += before - bot.leads.length;
  }
  if (Array.isArray(bot.conversations)) {
    const before = bot.conversations.length;
    bot.conversations = bot.conversations.filter((conversation) => !conversationMatches(conversation, targets));
    counts.conversations += before - bot.conversations.length;
  }
  if (Array.isArray(bot.tickets)) {
    const before = bot.tickets.length;
    bot.tickets = bot.tickets.filter(
      (ticket) =>
        !(
          targets.leadIds.has(idKey(ticket.leadId)) ||
          (idKey(ticket.conversationId) !== "" && targets.conversationIds.has(idKey(ticket.conversationId))) ||
          targets.emails.has(normalizeLeadEmail(ticket.visitorEmail)) ||
          dedupeKeyTouchesTarget(ticket.dedupeKey, targets)
        ),
    );
    counts.tickets += before - bot.tickets.length;
  }

  if (Array.isArray(bot.notifications)) {
    /** @type {BotNotification[]} */
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
    /** @type {BotAction[]} */
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

  if (Array.isArray(bot.events)) {
    const before = bot.events.length;
    bot.events = bot.events.filter(
      (event) =>
        !(
          metaTouchesTarget(event.meta, targets) ||
          textMentionsTarget(event.title, targets) ||
          textMentionsTarget(event.detail, targets) ||
          textMentionsTarget(JSON.stringify(event.meta ?? null), targets)
        ),
    );
    counts.events += before - bot.events.length;
  }

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

/**
 * @param {Partial<DeletionCounts>} [counts]
 * @returns {number}
 */
export function totalErased(counts) {
  return Object.values(counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

/**
 * @typedef {{ bots?: Record<string, DeletableBot> }} StoreSnapshot
 */

/**
 * @param {string | StoreSnapshot} raw
 * @param {string} botId
 * @param {LeadDeletionTargets} targets
 * @returns {{ json: string | null, unreadable: boolean }}
 */
export function eraseLeadFromStoreSnapshot(raw, botId, targets) {
  /** @type {StoreSnapshot | null} */
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
  const counts = eraseLeadFromBot(bot, cloneTargets(targets), { followSessions: false });
  return { json: totalErased(counts) > 0 ? JSON.stringify(store) : null, unreadable: false };
}

/**
 * @param {string[] | Set<string>} values
 * @param {number} [size]
 * @returns {string[][]}
 */
function chunks(values, size = LEDGER_ID_CHUNK) {
  const list = [...values];
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

/**
 * @param {number} count
 * @returns {string}
 */
function placeholders(count) {
  return new Array(count).fill("?").join(", ");
}

/**
 * @param {unknown} value
 * @returns {BotConversation | null}
 */
function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {D1Database} db
 * @param {string} botId
 * @param {LeadDeletionTargets} targets
 * @returns {Promise<LeadDeletionTargets>}
 */
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

  /**
   * @param {Record<string, unknown>[]} [rows]
   */
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

/**
 * @param {D1Database | null} db
 * @param {string} botId
 * @param {DeletableBot} bot
 * @param {LeadDeletionTargets} targets
 * @returns {Promise<LeadDeletionTargets>}
 */
export async function resolveSessions(db, botId, bot, targets) {
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  const candidates = [...targets.sessionIds].filter((sessionId) => !targets.blockedSessions.has(sessionId));
  /** @type {Map<string, { id: string, question: unknown, email: string }[]>} */
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

/**
 * @param {DeletableBot} bot
 * @param {LeadDeletionTargets} targets
 * @returns {boolean}
 */
export function targetsFoundAnything(bot, targets) {
  if (targets.ledgerRows > 0) return true;
  const leads = Array.isArray(bot?.leads) ? bot.leads : [];
  const conversations = Array.isArray(bot?.conversations) ? bot.conversations : [];
  return leads.some((lead) => leadMatches(lead, targets)) || conversations.some((conversation) => conversationMatches(conversation, targets));
}

/**
 * @param {D1Database} db
 * @param {string} botId
 * @param {LeadDeletionTargets} targets
 * @returns {Promise<{ leads: number, conversations: number }>}
 */
export async function deleteLeadLedgerRows(db, botId, targets) {
  const removed = { leads: 0, conversations: 0 };
  /**
   * @param {{ meta?: { changes?: unknown } } | null | undefined} result
   * @returns {number}
   */
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
