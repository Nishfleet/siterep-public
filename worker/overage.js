// Opt-in overage mechanics, extracted so the answering-state machine is
// unit-testable in Node (worker/index.js imports cloudflare:workers).
//
// Model (decided with Nish, 2026-06-12):
// - Every plan answers a 10% GRACE buffer past its monthly cap, free — a
//   goodwill cushion so a bot never slams shut on the round number while the
//   "you've hit your cap" alert is still in flight.
// - Past the grace buffer, the bot only keeps answering if the owner has
//   OPTED IN to overage AND billing is actually wired (env flag) AND they are
//   under their own monthly extra-answer ceiling. Otherwise it degrades to
//   lead capture — never a surprise charge.
// - Overage is billed via Dodo metering at $5 per 500 answers ($0.01 each).
//   Billing config lives in Dodo, never hardcoded here beyond display copy.

export const RESPONSE_CAP_GRACE_RATIO = 0.1;
export const DEFAULT_OVERAGE_CEILING = 10000; // max extra answers/month, even opted in
export const OVERAGE_EVENT_NAME = "siterep_overage_answer";
export const OVERAGE_BUNDLE_SIZE = 500;
export const OVERAGE_BUNDLE_PRICE_CENTS = 500; // $5 per 500 → $0.01/answer
export const OVERAGE_PENDING_LIMIT = 5000; // cap the in-record pending queue

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

// Pure answering decision. The caller supplies already-resolved facts so this
// stays runtime-agnostic. Returns one of: included | grace | overage | locked.
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
