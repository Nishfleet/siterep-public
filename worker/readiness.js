// One enforced readiness invariant for the machine-readable health payload.
//
// Required storage components (D1 record ledger, R2 source content, and D1
// account/team RBAC) must never report `ready: false` while the aggregate
// self-serve/storage check reports green — that would publish two
// contradictory truths to agents, monitors, and trust-conscious buyers at
// once (the exact defect behind scout 2026-08-09). The "Durable app storage"
// self-serve check derives from the same component `ready` signals, so today
// the aggregate and the components cannot drift apart by construction; this
// guard exists so any future divergence downgrades the aggregate with an
// explicit mismatch blocker instead of shipping the contradiction.

const REQUIRED_READINESS_COMPONENTS = Object.freeze([
  "recordLedger",
  "sourceContent",
  "accountRbac",
]);

export function requiredReadinessComponents() {
  return REQUIRED_READINESS_COMPONENTS;
}

// Enforce the invariant on a computed self-serve readiness result. Pure:
// never mutates the input. Returns the input-shaped result unchanged when
// the invariant holds, and a downgraded copy when it does not.
export function enforceSelfServeReadinessInvariant(selfServe, components) {
  const result = {
    ready: Boolean(selfServe?.ready),
    score: Number(selfServe?.score || 0),
    total: Number(selfServe?.total || 0),
    blockers: Array.isArray(selfServe?.blockers) ? [...selfServe.blockers] : [],
    checks: Array.isArray(selfServe?.checks)
      ? selfServe.checks.map((check) => ({ ...check }))
      : [],
  };
  if (!result.ready) return result;

  const notReady = REQUIRED_READINESS_COMPONENTS.filter((name) => !components?.[name]?.ready);
  if (notReady.length === 0) return result;

  result.ready = false;
  for (const check of result.checks) {
    if (check.label === "Durable app storage") {
      check.ok = false;
      check.detail = `Required storage component not ready: ${notReady.join(", ")}.`;
    }
  }
  result.score = result.checks.filter((check) => Boolean(check.ok)).length;
  result.blockers.push(
    `Storage readiness mismatch: ${notReady.join(", ")} ${notReady.length === 1 ? "is" : "are"} not ready while the self-serve aggregate reports ready.`,
  );
  return result;
}
