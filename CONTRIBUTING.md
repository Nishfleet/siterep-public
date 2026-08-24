# Contributing to siterep-public

## No hand-built orchestration

This repo has a mechanical gate against hand-built orchestration: Semgrep
rules in `.semgrep/no-hand-built-orchestration.yml` plus a shell-line ratchet
in `.semgrep/shell-line-budget`. The gate is enforced in CI (`semgrep` job)
and locally (`sgscan`).

If you reach for a `while true` loop, a retry counter, a cooldown timestamp,
a `flock` mutex, a `.tombstone`/`.ledger` state file, or a `pgrep` liveness
poller, stop: systemd already owns that shape. Each rule's message names the
exact directive to use instead.

A new executable file needs a one-line justification naming the platform
feature or systemd directive it could not use; raising
`.semgrep/shell-line-budget` is that act for shell.
