import assert from "node:assert/strict";
import { test } from "node:test";

import { enforceSelfServeReadinessInvariant, requiredReadinessComponents } from "../worker/readiness.js";

// Behavioral tests for the one enforced readiness invariant behind scout
// 2026-08-09: required storage components (recordLedger, sourceContent,
// accountRbac) can never report `ready: false` while the aggregate
// self-serve readiness reports green — that would tell agents, monitors,
// and trust-conscious buyers two contradictory truths at once.

function greenSelfServe() {
  return {
    ready: true,
    score: 5,
    total: 5,
    blockers: [],
    checks: [
      { label: "Live billing", ok: true, detail: "Products and webhook configured." },
      { label: "Customer billing portal", ok: true, detail: "Portal configured." },
      { label: "Email value loop", ok: true, detail: "Delivery ready." },
      { label: "Durable app storage", ok: true, detail: "Storage live." },
      { label: "Admin lock", ok: true, detail: "Admin routes locked." },
    ],
  };
}

const readyComponents = {
  recordLedger: { configured: true, ready: true },
  sourceContent: { configured: true, ready: true },
  accountRbac: { configured: true, ready: true },
};

test("required readiness components are the storage trio", () => {
  assert.deepEqual(requiredReadinessComponents(), ["recordLedger", "sourceContent", "accountRbac"]);
});

test("green aggregate with all required components ready passes through unchanged", () => {
  const input = greenSelfServe();
  const output = enforceSelfServeReadinessInvariant(input, readyComponents);
  assert.equal(output.ready, true);
  assert.equal(output.score, 5);
  assert.deepEqual(output.blockers, []);
  assert.deepEqual(output.checks, input.checks);
});

test("a required component not ready forces the aggregate red and flags the storage check", () => {
  const input = greenSelfServe();
  const output = enforceSelfServeReadinessInvariant(input, {
    ...readyComponents,
    recordLedger: { configured: true, ready: false },
  });
  assert.equal(output.ready, false);
  assert.equal(output.score, 4);
  const storageCheck = output.checks.find((check) => check.label === "Durable app storage");
  assert.equal(storageCheck.ok, false);
  assert.match(storageCheck.detail, /recordLedger/);
  assert.equal(output.blockers.length, 1);
  assert.match(output.blockers[0], /recordLedger/);
});

test("multiple not-ready components are all named", () => {
  const output = enforceSelfServeReadinessInvariant(greenSelfServe(), {
    ...readyComponents,
    sourceContent: { configured: true, ready: false },
    accountRbac: { configured: false, ready: false },
  });
  assert.equal(output.ready, false);
  assert.match(output.blockers[0], /sourceContent, accountRbac/);
});

test("an already-red aggregate is left untouched", () => {
  const input = { ...greenSelfServe(), ready: false, score: 3, blockers: ["Live billing: missing setup."] };
  const output = enforceSelfServeReadinessInvariant(input, {
    ...readyComponents,
    sourceContent: { configured: true, ready: false },
  });
  assert.equal(output.ready, false);
  assert.equal(output.score, 3);
  assert.deepEqual(output.blockers, ["Live billing: missing setup."]);
});

test("the invariant never mutates its input", () => {
  const input = greenSelfServe();
  const inputSnapshot = JSON.stringify(input);
  enforceSelfServeReadinessInvariant(input, {
    ...readyComponents,
    recordLedger: { configured: true, ready: false },
  });
  assert.equal(JSON.stringify(input), inputSnapshot);
});
