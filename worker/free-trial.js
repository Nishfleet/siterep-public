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

export function freeTrialNudge(used, cap = FREE_ANSWER_CAP) {
  const u = Math.max(0, Number(used) || 0);
  const half = Math.floor(cap / 2);
  const almost = Math.max(half + 1, cap - 5);
  if (u >= cap) return { threshold: cap, kind: "used_up" };
  if (u >= almost) return { threshold: almost, kind: "almost" };
  if (u >= half) return { threshold: half, kind: "half" };
  return null;
}
