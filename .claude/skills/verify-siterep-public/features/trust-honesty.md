# Feature: Trust & honesty `/trust`, `/honesty`, `/api/public/*`

The trust surface is how a buyer doing diligence confirms Site Rep does what it
claims. It spans three pages (`/trust`, `/honesty`, `/privacy`, `/terms`) and
three public JSON endpoints (`/api/public/trust-status`,
`/api/public/release-status`, `/api/public/honesty-check`).

## How users reach it

- Footer / nav links to `/trust`, `/honesty`, `/privacy`, `/terms`.
- `/api/public/trust-status`, `/api/public/release-status`,
  `/api/public/honesty-check` are public GET endpoints (no auth).

## How to drive it

HTTP drive:

```bash
curl -fsS http://127.0.0.1:8787/trust | grep -c 'Site Rep'           # >= 1
curl -fsS http://127.0.0.1:8787/honesty | grep -c 'Site Rep'         # >= 1
curl -fsS http://127.0.0.1:8787/privacy | grep -c 'Site Rep'         # >= 1
curl -fsS http://127.0.0.1:8787/terms | grep -c 'Site Rep'           # >= 1

curl -fsS http://127.0.0.1:8787/api/public/trust-status
# expect: 200, { ok:true, product:"Site Rep", certificationStatus:"not_certified",
#   confirmedControls:[...>=5], notClaimed:[...], needsReview:[...], releaseStatus:{...} }

curl -fsS http://127.0.0.1:8787/api/public/release-status
# expect: 200, { ok:true, product:"Site Rep", launchReady:false, release:{...} }
# MUST NOT contain productionProofRequired / notLaunchProof (internal checklists leak).

curl -fsS http://127.0.0.1:8787/api/public/honesty-check
# expect: 200, { product:"Site Rep", allPass:true, citations:{passed:total,total} }
```

## What observable state proves success

- `/trust`, `/honesty`, `/privacy`, `/terms` → 200, HTML contains `Site Rep`.
- `/api/public/trust-status` → 200, `ok:true`, `product:"Site Rep"`,
  `certificationStatus:"not_certified"` (must NOT imply certification),
  `confirmedControls` has ≥ 5 entries, `notClaimed` and `needsReview` are
  non-empty arrays, `releaseStatus` passes release freshness.
- `/api/public/release-status` → 200, `ok:true`, `launchReady:false` (must NOT
  imply launch readiness), no `productionProofRequired` / `notLaunchProof`
  arrays (internal launch-gate checklists must not leak).
- `/api/public/honesty-check` → 200, `allPass:true`,
  `citations.passed === citations.total`.
- `npm run monitor:local` `trust`, `honesty`, `privacy`, `terms`,
  `trust status`, `release status`, and `honesty check` probes all `ok:true`.

## Notes

- Release freshness (`assertReleaseFreshness`) checks the marker
  `launch-hygiene-proof-health-2026-08-26`, `publicTrustUpdatedAt:"2026-08-11"`,
  `stage:"production_hardening"`, a verifiable commit SHA, and a deploy
  timestamp within 31 days. The local `cf:dev` Worker serves the worker-code
  fallback identity (`RELEASE_STATUS_COMMIT` / `RELEASE_STATUS_DEPLOYED_AT`),
  which is fresh enough to pass — if it ever ages past 31 days the monitor
  fails loudly and the fallback in `worker/index.js` must be refreshed.
- `/api/health/deep` with an `x-citerep-admin-key` header unlocks owner-side
  counts — that is a test-only surface for this feature; the public drive never
  sends the header.
