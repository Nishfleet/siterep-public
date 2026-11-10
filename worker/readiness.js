const REQUIRED_READINESS_COMPONENTS = Object.freeze([
  "recordLedger",
  "sourceContent",
  "accountRbac",
]);

export function requiredReadinessComponents() {
  return REQUIRED_READINESS_COMPONENTS;
}

/**
 * One computed check line of the self-serve readiness report.
 *
 * @typedef {object} ReadinessCheck
 * @property {string} [label]
 * @property {boolean} [ok]
 * @property {string} [detail]
 */

/**
 * The self-serve aggregate reported by /api/health/deep.
 *
 * @typedef {object} SelfServeReadiness
 * @property {boolean} [ready]
 * @property {number} [score]
 * @property {number} [total]
 * @property {string[]} [blockers]
 * @property {ReadinessCheck[]} [checks]
 */

/**
 * A required readiness component (recordLedger, sourceContent, accountRbac).
 *
 * @typedef {object} ReadinessComponent
 * @property {boolean} ready
 */

/**
 * @typedef {Record<string, ReadinessComponent>} ReadinessComponents
 */

/**
 * The aggregate after the self-serve/storage invariant has been enforced.
 *
 * @typedef {object} EnforcedSelfServeReadiness
 * @property {boolean} ready
 * @property {number} score
 * @property {number} total
 * @property {string[]} blockers
 * @property {ReadinessCheck[]} checks
 */

/**
 * Downgrade a ready-looking self-serve aggregate when any required storage
 * component is actually not ready, so the health report never over-reports.
 *
 * @param {SelfServeReadiness} [selfServe]
 * @param {ReadinessComponents} [components]
 * @returns {EnforcedSelfServeReadiness}
 */
export function enforceSelfServeReadinessInvariant(selfServe, components) {
  const unenforced = {
    ready: Boolean(selfServe?.ready),
    score: Number(selfServe?.score || 0),
    total: Number(selfServe?.total || 0),
    blockers: Array.isArray(selfServe?.blockers) ? [...selfServe.blockers] : [],
    checks: Array.isArray(selfServe?.checks)
      ? selfServe.checks.map((check) => ({ ...check }))
      : [],
  };
  /** @type {EnforcedSelfServeReadiness} */
  const result = unenforced;
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
