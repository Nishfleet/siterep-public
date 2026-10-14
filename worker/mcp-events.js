export const MCP_EVENT_NAMES = Object.freeze([
  "mcp_connected",
  "mcp_tool_called",
  "mcp_customer_receipt_read",
]);

export const MCP_RETENTION_DAYS = 90;
export const MCP_EVENT_KEY_PREFIX = "mcp-events:";
export const MCP_MAX_COUNT_PER_EVENT_PER_DAY = 1_000_000;
export const MCP_MAX_DAY_RANGE = MCP_RETENTION_DAYS;

const MCP_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidMcpEventName(name) {
  return typeof name === "string" && MCP_EVENT_NAMES.includes(name);
}

export function mcpDayKey(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${MCP_EVENT_KEY_PREFIX}${year}-${month}-${day}`;
}

export function scrubMcpAggregate(aggregate) {
  const scrubbed = {};
  if (!aggregate || typeof aggregate !== "object" || Array.isArray(aggregate)) return scrubbed;
  for (const event of MCP_EVENT_NAMES) {
    const value = aggregate[event];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const normalized = Math.min(Math.floor(value), MCP_MAX_COUNT_PER_EVENT_PER_DAY);
    if (normalized > 0) scrubbed[event] = normalized;
  }
  return scrubbed;
}

export function bumpMcpAggregate(aggregate = {}, eventName) {
  const next = scrubMcpAggregate(aggregate);
  next[eventName] = Math.min(Number(next[eventName] || 0) + 1, MCP_MAX_COUNT_PER_EVENT_PER_DAY);
  return next;
}

export async function recordMcpEvent(kv, eventName, now = new Date()) {
  if (!isValidMcpEventName(eventName)) return { event: null, recorded: false };
  const key = mcpDayKey(now);
  try {
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
    const next = bumpMcpAggregate(aggregate, eventName);
    await kv.put(key, JSON.stringify(next), { expirationTtl: MCP_RETENTION_DAYS * 86400 });
    return { key, event: eventName, count: next[eventName], recorded: true };
  } catch {
    return { event: eventName, recorded: false };
  }
}

function validDay(value, fallback) {
  return MCP_DAY_KEY_PATTERN.test(String(value || "")) ? String(value) : fallback;
}

export function mcpDayRange(from = "", to = "", now = new Date()) {
  const today = mcpDayKey(now).slice(MCP_EVENT_KEY_PREFIX.length);
  const toDay = validDay(to, today);
  const fromDay = validDay(from, toDay);
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`);
  const clampedFromMs = Math.max(fromMs, toMs - (MCP_MAX_DAY_RANGE - 1) * 86400000);
  const keys = [];
  for (let ms = clampedFromMs; ms <= toMs; ms += 86400000) {
    keys.push(`${MCP_EVENT_KEY_PREFIX}${new Date(ms).toISOString().slice(0, 10)}`);
  }
  return { keys, from: keys[0]?.slice(MCP_EVENT_KEY_PREFIX.length) || fromDay, to: toDay };
}

export async function readMcpStats(kv, { from = "", to = "" } = {}, now = new Date()) {
  if (!kv) return { days: {}, totals: {}, from: "", to: "", retentionDays: MCP_RETENTION_DAYS };
  const range = mcpDayRange(from, to, now);
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
    const scrubbed = scrubMcpAggregate(counts);
    if (Object.keys(scrubbed).length === 0) continue;
    days[key.slice(MCP_EVENT_KEY_PREFIX.length)] = scrubbed;
    for (const [event, count] of Object.entries(scrubbed)) {
      totals[event] = (totals[event] || 0) + count;
    }
  }
  return { days, totals, from: range.from, to: range.to, retentionDays: MCP_RETENTION_DAYS };
}
