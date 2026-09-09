## What

Cross-fleet rollout follow-up (Nishfleet/fleet-ops#4303), the piece the judge
narrowed on 2026-09-07: make the **siterep-public canonical**
`.github/workflows/auto-merge-arm.yml` unblock PAT-less repos (e.g. inish-site)
without org secrets.

When `AUTO_REVERT_PAT` is missing, the arm step now emits a `::notice::` and
exits 0 instead of `::error::` + `exit 1`. The PR's own opener already arms
it (`gh pr merge --auto --squash` — the worker's mandatory arm step), so
failing loud here painted every PR red in PAT-less repos over a non-blocker
(same class fixed on the fleet-ops side in fleet-ops#1081 / PR 4276). A human
can always arm or merge via the green button. The `gh pr merge` line is
unchanged.

- `.github/workflows/auto-merge-arm.yml`: missing-PAT branch → `::notice::` +
  `exit 0` (was `::error::` + `exit 1`); comment block updated to document the
  exit-0 behavior.

This does NOT close fleet-ops#4303: the App-token org-secret rollout (item 1),
the full canonical App-token switch (item 2), the `v1` tag (item 3), and the
canary proof (item 4) remain Nish/admin steps tracked there.

## Verification

All run on the VPS worktree
(`/home/nish/workspaces/agent-worktrees/issue-siterep-public-4303`, branch
`claim/issue-4303`, base `22f6660`):

- `actionlint .github/workflows/auto-merge-arm.yml` → exit 0 (clean).
- YAML validity: PyYAML `safe_load` parses the workflow (exit 0).
- `fleet-no-agent-names-check --commit-range origin/main..HEAD` → OK.
- `fleet-exec-review-canary --body` → OK (Verification + run-proof present).
- `fleet-organ-heartbeat-check` → SKIP (no organ diff; not-an-organ:
  `.github/workflows/auto-merge-arm.yml` is a workflow, not an organ).
- `fleet-rebuild-verify-check` → SKIP (no rebuild/masking diff).
- `research-before-build-check` → SKIP (no new `bin/` file).
- `fleet-token-efficiency-check` → OK.
- `fleet-wipe-lessons-check scan` → clean.

run-proof: `actionlint` exit 0; PyYAML parse exit 0; pushed `claim/issue-4303`
to siterep-public under the nishfleet-worker App identity (workflows:write now
granted, #4332).

## Reviewer round (product repo)

One round, reviewer seat **cursor/cursor-grok-4.6-high**: verified the change
matches the 2026-09-07 acceptance (missing PAT → notice + exit 0; `gh pr
merge` line unchanged; comment block consistent). No Critical and no Warning
findings; adjudication:

- Consider — optional `title=` payload on the `::notice::` (cosmetic UX): Noted, deferred.
- Consider — comment-block verbosity / redundancy: Noted, cosmetic, keeps the rationale on record.

No Act-on findings; nothing to fix before arming.

## Gates

- `fleet-review-arm-check` → exit 0 (senior seat usable; reviewer round ran).
- `prove-one-run-check` → SKIP (no new unit/timer/workflow; the durable lock
  is the workflow behavior + fleet-ops#1081's test on the fleet-ops side).

net-positive-because: the +6/-3 diff removes a permanent red check on every PR in PAT-less repos (inish-site#139 class) with a one-branch exit-code change; the behavior is locked on the fleet-ops side by fleet-ops#1081's regression test.

Relates to Nishfleet/fleet-ops#4303
