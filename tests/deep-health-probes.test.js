import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const workerPath = new URL("../worker/index.js", import.meta.url);

test("deep health actively probes the D1 ledger schema and read path", async () => {
  const worker = await readFile(workerPath, "utf8");

  assert.match(worker, /async function probeRecordLedgerSchema\(env = activeEnv\)/);
  assert.match(worker, /await ensureRecordLedgerSchema\(env\)/);
  assert.match(worker, /SELECT COUNT\(\*\) AS count FROM siterep_conversations/);
  assert.match(worker, /return \{ ok: true, detail: "D1 ledger schema and read path verified\." \};/);
});

test("deep health actively probes R2 write/read capability with cleanup", async () => {
  const worker = await readFile(workerPath, "utf8");

  assert.match(worker, /async function probeSourceContent\(env = activeEnv\)/);
  assert.match(worker, /await bucket\.put\(key, payload/);
  assert.match(worker, /await bucket\.get\(key\)/);
  assert.match(worker, /finally \{\n\s+await bucket\.delete\(key\)\.catch\(\(\) => \{\}\);/);
  assert.match(worker, /DEEP_HEALTH_PROBE_PREFIX = "__siterep_deep_health_probe__"/);
});

test("deep health actively probes the RBAC schema and read path", async () => {
  const worker = await readFile(workerPath, "utf8");

  assert.match(worker, /async function probeAccountRbacSchema\(env = activeEnv\)/);
  assert.match(worker, /await ensureAccountRbacSchema\(env\)/);
  assert.match(worker, /SELECT COUNT\(\*\) AS count FROM siterep_accounts/);
  assert.match(worker, /return \{ ok: true, detail: "RBAC schema and read path verified\." \};/);
});

test("deep handler runs the storage proofs and passes them into the payload", async () => {
  const worker = await readFile(workerPath, "utf8");
  const deepHandler = worker.slice(
    worker.indexOf('if (request.method === "GET" && url.pathname === "/api/health/deep") {'),
    worker.indexOf('if (request.method === "GET" && url.pathname === "/api/funnel/stats") {'),
  );

  assert.match(deepHandler, /const deepProof = await runDeepStorageProofs\(\)/);
  assert.match(deepHandler, /const adminUnlocked = await adminHealthUnlocked\(request\)/);
  assert.match(deepHandler, /mode: "deep",\n\s+store,\n\s+\.\.\.\(adminUnlocked \? \{ accountRbacCounts \} : \{\}\),\n\s+deepProof,/);
  assert.match(deepHandler, /deepProof,\n\s+publicSafe: !adminUnlocked/);
});

test("ready flags are derived from the storage proofs, never from configuration", async () => {
  const worker = await readFile(workerPath, "utf8");
  const payloadFn = worker.slice(
    worker.indexOf("function deploymentHealthPayload"),
    worker.indexOf("function publicDeploymentHealthPayload"),
  );

  assert.match(payloadFn, /const deepProof = options\.deepProof \|\| null;/);
  assert.match(payloadFn, /ready: Boolean\(deepProof\?\.recordLedger\?\.ok\)/);
  assert.match(payloadFn, /ready: Boolean\(deepProof\?\.sourceContent\?\.ok\)/);
  assert.match(payloadFn, /ready: Boolean\(deepProof\?\.accountRbac\?\.ok\)/);
  assert.match(payloadFn, /const durableStorageProven = Boolean\(/);
  assert.match(payloadFn, /ok: deepProof \? durableStorageProven : true/);
});

test("self-serve storage readiness requires proved ready flags, not configuration", async () => {
  const worker = await readFile(workerPath, "utf8");
  const selfServeFn = worker.slice(
    worker.indexOf("function selfServeReadinessInfo"),
    worker.indexOf("function publicFastHealthResponse"),
  );

  assert.match(selfServeFn, /recordLedger\?\.ready && sourceContent\?\.ready && accountRbac\?\.ready/);
  assert.doesNotMatch(selfServeFn, /recordLedger\?\.configured && sourceContent\?\.configured && accountRbac\?\.configured/);
});
