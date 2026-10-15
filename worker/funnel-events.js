export const FUNNEL_EVENT_NAMES = Object.freeze([
  "demo_opened",
  "demo_question_submitted",
  "demo_answer_completed",
  "signup_submitted",
  "signup_succeeded",
  "signup_failed",
  "checkout_opened",
  "checkout_succeeded",
  "checkout_failed",
  "signin_opened",
  "signin_succeeded",
  "signin_failed",
]);

export const FUNNEL_RETENTION_DAYS = 90;
export const FUNNEL_EVENT_KEY_PREFIX = "funnel-events:";
export const FUNNEL_MAX_COUNT_PER_EVENT_PER_DAY = 1_000_000;
export const FUNNEL_MAX_DAY_RANGE = FUNNEL_RETENTION_DAYS;

const FUNNEL_EVENT_RATE_LIMIT_PER_MINUTE = 600;
const FUNNEL_EVENT_RATE_LIMIT_MAX_BUCKETS = 1024;
const funnelEventRateLimitBuckets = new Map();

export function checkFunnelEventRateLimit(event) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const bucket = `${event}:${minute}`;
  const hits = (funnelEventRateLimitBuckets.get(bucket) || 0) + 1;
  funnelEventRateLimitBuckets.set(bucket, hits);
  if (funnelEventRateLimitBuckets.size > FUNNEL_EVENT_RATE_LIMIT_MAX_BUCKETS) {
    for (const key of funnelEventRateLimitBuckets.keys()) {
      if (!key.endsWith(`:${minute}`)) funnelEventRateLimitBuckets.delete(key);
    }
  }
  return hits <= FUNNEL_EVENT_RATE_LIMIT_PER_MINUTE;
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidFunnelEventName(name) {
  return typeof name === "string" && FUNNEL_EVENT_NAMES.includes(name);
}

export function funnelDayKey(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${FUNNEL_EVENT_KEY_PREFIX}${year}-${month}-${day}`;
}

export function scrubFunnelAggregate(aggregate) {
  const scrubbed = {};
  if (!aggregate || typeof aggregate !== "object" || Array.isArray(aggregate)) return scrubbed;
  for (const event of FUNNEL_EVENT_NAMES) {
    const value = aggregate[event];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const normalized = Math.min(Math.floor(value), FUNNEL_MAX_COUNT_PER_EVENT_PER_DAY);
    if (normalized > 0) scrubbed[event] = normalized;
  }
  return scrubbed;
}

export function bumpFunnelAggregate(aggregate = {}, eventName) {
  const next = scrubFunnelAggregate(aggregate);
  next[eventName] = Math.min(Number(next[eventName] || 0) + 1, FUNNEL_MAX_COUNT_PER_EVENT_PER_DAY);
  return next;
}

export function parseFunnelEventPayload(rawBody) {
  try {
    const parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
    const name = String(parsed.event || "");
    return isValidFunnelEventName(name) ? { ok: true, event: name } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function recordFunnelEvent(kv, eventName, now = new Date()) {
  const key = funnelDayKey(now);
  let aggregate = {};
  let existing = null;
  try {
    existing = await kv.get(key);
  } catch {
    existing = null;
  }
  if (existing) {
    try {
      aggregate = JSON.parse(existing);
    } catch {
      aggregate = {};
    }
  }
  const next = bumpFunnelAggregate(aggregate, eventName);
  await kv.put(key, JSON.stringify(next), { expirationTtl: FUNNEL_RETENTION_DAYS * 86400 });
  return { key, event: eventName, count: next[eventName] };
}

export async function collectFunnelEvent(rawBody, store, { now = new Date(), rateLimitCheck = checkFunnelEventRateLimit } = {}) {
  let event = null;
  try {
    const parsed = parseFunnelEventPayload(rawBody);
    if (!parsed.ok) return { event: null, recorded: false };
    event = parsed.event;
    if (!store || !rateLimitCheck(event)) return { event, recorded: false };
    await recordFunnelEvent(store, event, now);
    return { event, recorded: true };
  } catch {
    return { event, recorded: false };
  }
}

function validDay(value, fallback) {
  return DAY_KEY_PATTERN.test(String(value || "")) ? String(value) : fallback;
}

export function funnelDayRange(from = "", to = "", now = new Date()) {
  const today = funnelDayKey(now).slice(FUNNEL_EVENT_KEY_PREFIX.length);
  const toDay = validDay(to, today);
  const fromDay = validDay(from, toDay);
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`);
  const clampedFromMs = Math.max(fromMs, toMs - (FUNNEL_MAX_DAY_RANGE - 1) * 86400000);
  const keys = [];
  for (let ms = clampedFromMs; ms <= toMs; ms += 86400000) {
    keys.push(`${FUNNEL_EVENT_KEY_PREFIX}${new Date(ms).toISOString().slice(0, 10)}`);
  }
  return { keys, from: keys[0]?.slice(FUNNEL_EVENT_KEY_PREFIX.length) || fromDay, to: toDay };
}

export async function readFunnelStats(kv, { from = "", to = "" } = {}, now = new Date()) {
  if (!kv) return { days: {}, totals: {}, from: "", to: "", retentionDays: FUNNEL_RETENTION_DAYS };
  const range = funnelDayRange(from, to, now);
  const days = {};
  const totals = {};
  for (const key of range.keys) {
    let raw = null;
    try {
      raw = await kv.get(key);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    let counts = null;
    try {
      counts = JSON.parse(raw);
    } catch {
      counts = null;
    }
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) continue;
    const scrubbed = scrubFunnelAggregate(counts);
    if (Object.keys(scrubbed).length === 0) continue;
    days[key.slice(FUNNEL_EVENT_KEY_PREFIX.length)] = scrubbed;
    for (const [event, count] of Object.entries(scrubbed)) {
      totals[event] = (totals[event] || 0) + count;
    }
  }
  return { days, totals, from: range.from, to: range.to, retentionDays: FUNNEL_RETENTION_DAYS };
}
