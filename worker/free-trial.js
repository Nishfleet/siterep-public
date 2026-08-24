// Free-trial mechanics, extracted from the worker entry so the cap and the
// conversion-nudge thresholds are unit-testable in Node (worker/index.js
// imports cloudflare:workers and cannot be imported outside the runtime).
//
// The trial is a LIFETIME allowance of cited answers — it never resets and
// refusals never count against it, because refusing honestly is the cheap,
// trustworthy path we never want to discourage.

export const FREE_ANSWER_CAP = 50;

export const FREE_PLAN_LIMITS = Object.freeze({
  priceCents: 0,
  botLimit: 1,
  pageLimit: 25,
  responseLimit: FREE_ANSWER_CAP,
  monthlyRefreshLimit: 1,
  allowedOriginsLimit: 1,
  brandingLocked: true,
});

export function isFreePlanName(plan) {
  return String(plan || "").trim() === "Free";
}

// Which conversion nudge — if any — this lifetime usage count has just reached.
// Returns null when no nudge is due, otherwise { threshold, kind }:
//   half     — the trial is proving value (caller fires once)
//   almost   — only a handful of answers left
//   used_up  — the rep has auto-paused into lead capture
// Thresholds derive from the cap so the same logic holds if the cap changes.
export function freeTrialNudge(used, cap = FREE_ANSWER_CAP) {
  const u = Math.max(0, Number(used) || 0);
  const half = Math.floor(cap / 2);
  const almost = Math.max(half + 1, cap - 5);
  if (u >= cap) return { threshold: cap, kind: "used_up" };
  if (u >= almost) return { threshold: almost, kind: "almost" };
  if (u >= half) return { threshold: half, kind: "half" };
  return null;
}
