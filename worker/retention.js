const DAY_MS = 24 * 60 * 60 * 1000;

export const LEAD_RETENTION_DEFAULT_DAYS = 365;
export const LEAD_RETENTION_MIN_DAYS = 1;
export const LEAD_RETENTION_OPTIONS = Object.freeze([30, 90, 180, 365]);
export const LEAD_RETENTION_CRON = "17 4 * * *";

/**
 * Keep a workspace's retention choice inside the supported range. The default
 * is the 12-month policy; a workspace may shorten it, never extend it.
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function sanitizeLeadRetentionDays(value, fallback = LEAD_RETENTION_DEFAULT_DAYS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < LEAD_RETENTION_MIN_DAYS) return fallback;
  return Math.min(LEAD_RETENTION_DEFAULT_DAYS, Math.floor(parsed));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidLeadRetentionDays(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= LEAD_RETENTION_MIN_DAYS && parsed <= LEAD_RETENTION_DEFAULT_DAYS;
}

/**
 * @param {number} days
 * @param {number} [nowMs]
 * @returns {number}
 */
export function leadRetentionCutoffMs(days, nowMs = Date.now()) {
  return nowMs - sanitizeLeadRetentionDays(days) * DAY_MS;
}

/**
 * @param {number} days
 * @returns {string}
 */
export function leadRetentionPeriodLabel(days) {
  const safeDays = sanitizeLeadRetentionDays(days);
  if (safeDays === 365) return "12 months";
  if (safeDays === 180) return "6 months";
  if (safeDays === 90) return "3 months";
  if (safeDays === 30) return "30 days";
  return `${safeDays} day${safeDays === 1 ? "" : "s"}`;
}
