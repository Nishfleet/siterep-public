# Agent notes for siterep-public

Launch stage: 2 (payments). Next trigger: the first business buyer who asks for a contract, SSO or a security review (stage 3).

Success: paid workspaces, live-mode Dodo subscriptions that activated a workspace and are still active. Baseline: none yet (production D1 has not been read for it; run the query below and write the count and date here). Measured by: `npx wrangler d1 execute siterep_payments --remote --command "SELECT COUNT(DISTINCT bot_id) FROM dodo_checkout_sessions WHERE mode = 'live' AND activated_at IS NOT NULL AND status IN ('activated', 'active', 'plan_changed')"` (read-only); whether each one has a real-domain widget install is the `real_domain_install` step of `GET /api/customer-receipt`.

Stage 4's EU rules already apply: the widget stores visitors' names and emails as leads.
