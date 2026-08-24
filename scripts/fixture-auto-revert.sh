#!/bin/sh
# Auto-revert proof fixture: an unbounded poll loop the semgrep gate rejects
# (no-hand-built-until-sleep-poll-loop, ERROR severity). This file is
# intentionally red and must be auto-reverted by the auto-revert workflow.
# It touches no product behavior and is never executed.
until ready; do sleep 5; done
