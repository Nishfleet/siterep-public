export const RESPONSE_CAP_GRACE_RATIO = 0.1;
export const DEFAULT_OVERAGE_CEILING = 10000;
export const OVERAGE_EVENT_NAME = "siterep_overage_answer";
export const OVERAGE_BUNDLE_SIZE = 500;
export const OVERAGE_BUNDLE_PRICE_CENTS = 500;
export const OVERAGE_PENDING_LIMIT = 5000;

export function defaultOverageSettings() {
  return { enabled: false, maxExtraPerMonth: DEFAULT_OVERAGE_CEILING, reportedMonth: "", reportedCount: 0, pending: [] };
}

export function sanitizeOverageSettings(input = {}, current = {}) {
  const base = { ...defaultOverageSettings(), ...current };
  const maxRaw = input.maxExtraPerMonth ?? base.maxExtraPerMonth;
  const max = Math.max(0, Math.min(1_000_000, Math.floor(Number(maxRaw) || 0)));
  return {
    ...base,
    enabled: typeof input.enabled === "boolean" ? input.enabled : Boolean(base.enabled),
    maxExtraPerMonth: max || DEFAULT_OVERAGE_CEILING,
  };
}

export function graceLimitFor(limit) {
  const safe = Math.max(0, Number(limit) || 0);
  return safe + Math.ceil(safe * RESPONSE_CAP_GRACE_RATIO);
}

export function answeringMode({
  used,
  limit,
  overageEnabled = false,
  overageEligible = false,
  billingActive = false,
  reportedThisMonth = 0,
  maxExtraPerMonth = DEFAULT_OVERAGE_CEILING,
}) {
  const u = Math.max(0, Number(used) || 0);
  const l = Math.max(0, Number(limit) || 0);
  if (u < l) return "included";
  if (u < graceLimitFor(l)) return "grace";
  if (overageEnabled && overageEligible && billingActive && reportedThisMonth < maxExtraPerMonth) {
    return "overage";
  }
  return "locked";
}
