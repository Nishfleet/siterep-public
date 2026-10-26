# Agent notes for siterep-public

Launch stage: 2 (payments). Next trigger: the first business buyer who asks for a contract, SSO or a security review (stage 3).

Success: paid workspaces, live-mode Dodo subscriptions that activated a workspace and are still active. Baseline: 0 on 2026-10-15 (query below, read-only). Measured by: `npx wrangler d1 execute siterep_payments --remote --command "SELECT COUNT(DISTINCT bot_id) FROM dodo_checkout_sessions WHERE mode = 'live' AND activated_at IS NOT NULL AND status IN ('activated', 'active', 'plan_changed')"` (read-only); whether each one has a real-domain widget install is the `real_domain_install` step of `GET /api/customer-receipt`.

Stage 4's EU rules already apply: the widget stores visitors' names and emails as leads.

## Run it and prove it

Live: https://siterep.net (`siterep.net` and `www.siterep.net`, both custom domains on the same `siterep` Worker, `wrangler.jsonc` → `routes`).

- Prove a deploy: `curl -sS https://siterep.net/api/health/deep | jq -e '.ok and .recordLedger.ready and .sourceContent.ready and .accountRbac.ready'` prints `true` and exits 0. Then `curl -sS https://siterep.net/api/health/deep | jq -r '.release.source + " " + .release.commit'` prints `deploy-stamped <sha>`, where `<sha>` is the commit on `main` that is live: `.github/workflows/deploy-production.yml` deploys `main` after its CI run passes. The word `worker-code` instead of `deploy-stamped` means the deploy did not stamp `SITEREP_RELEASE_COMMIT`/`SITEREP_RELEASE_DEPLOYED_AT` and the Worker fell back to a compiled-in commit.
- Readiness route: `GET /api/health/deep`, served from `worker/index.js`. A pass is `"ok":true` with `selfServe` → `ready: true` and `blockers: []`. This route is the storage proof: it ensures and then reads the D1 ledger schema (`recordLedger`) and the account/RBAC schema (`accountRbac`), and it writes, reads back and deletes one R2 object (`sourceContent`). A failure is `"ok":false`, or any of those three with `ready:false`; `selfServe.blockers[0]` names the capability that is down (for example `Durable app storage: ...`).
- `GET /api/health/live` (`/api/health` is the same route) is the cheap liveness check: it answers `"ok":true` whenever the Worker answers and names the deep route, so it catches an unreachable host but never a storage outage. `npm run monitor:health` is this fast probe alone; use the deep route above when the question is whether the deploy really works.
- Test login: none. There is no seeded account and no password: the dashboard signs in with a workspace's own dashboard access key (`POST /api/customer/login`) or with a one-time link emailed by `POST /api/customer/access-email` and claimed at `POST /api/customer/magic-session`, so a signed-in test needs a real workspace credential or a real mailbox. The public widget demo (bot `site-rep-demo`, key `sr_demo_source_backed_widget_key`) is a public install, not a login.
