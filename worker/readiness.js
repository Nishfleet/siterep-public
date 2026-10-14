const REQUIRED_READINESS_COMPONENTS = Object.freeze([
  "recordLedger",
  "sourceContent",
  "accountRbac",
]);

export function requiredReadinessComponents() {
  return REQUIRED_READINESS_COMPONENTS;
}

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
