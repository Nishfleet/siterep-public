#!/bin/sh
# Proof fixture for the no-hand-built-orchestration gate.
# Genuine banned shape: unbounded poll loop waiting for a unit to come up.
# This file must NEVER merge — it exists only to prove the detector goes RED.
until systemctl is-active siterep-worker.service; do
  sleep 15
done
