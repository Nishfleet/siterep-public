#!/bin/sh
# PROOF FIXTURE — expected outcome: push to main turns semgrep RED on the push run;
# auto-revert opens a revert PR that self-merges and restores green. Never merge via PR.
until systemctl is-active nonexistent.service; do sleep 15; done
