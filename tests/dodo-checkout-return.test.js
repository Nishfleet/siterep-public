import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// D6 UX flow: buyers who abandon Dodo checkout land on
// ?checkout=dodo&referenceId=...&surface=customer. claimDodoReturn polls
// payment_pending up to five times, then must scrub the return URL, fire
// checkout_failed, and show a clear not-charged message — not leave stale
// "still confirming" copy with checkout params stuck in the address bar.

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

const claimDodoFn = app.slice(app.indexOf("async function claimDodoReturn"), app.indexOf("async function claimCustomerMagicLink"));
const workerClaim = worker.slice(worker.indexOf("async function claimDodoReturn"), worker.indexOf("async function createDodoPortalSessionForBot"));

test("dodo checkout return scrubs URL and reports failure after pending retries exhaust", () => {
  const pendingBlock = claimDodoFn.slice(
    claimDodoFn.indexOf("if (result.status === \"payment_pending\")"),
    claimDodoFn.indexOf("if (result.status === \"payment_mismatch\""),
  );
  assert.match(pendingBlock, /attempt < 5/);
  assert.match(pendingBlock, /scrubPaymentParamsFromUrl\(\)/, "exhausted pending retries must scrub checkout return params");
  assert.match(pendingBlock, /funnelEvent\("checkout_failed"\)/, "exhausted pending retries must record checkout_failed");
  assert.match(
    pendingBlock,
    /Checkout was not completed\. Your card was not charged/,
    "exhausted pending retries must tell the buyer checkout did not finish",
  );
});

test("dodo checkout return handles terminal checkout_failed from the worker", () => {
  assert.match(claimDodoFn, /if \(result\.status === "checkout_failed"\)/);
  const failedBlock = claimDodoFn.slice(
    claimDodoFn.indexOf("if (result.status === \"checkout_failed\")"),
    claimDodoFn.indexOf("if (result.emailedAccess"),
  );
  assert.match(failedBlock, /scrubPaymentParamsFromUrl\(\)/);
  assert.match(failedBlock, /funnelEvent\("checkout_failed"\)/);
  assert.match(failedBlock, /Checkout was not completed\. Your card was not charged/);
});

test("worker claim maps terminal checkout errors to checkout_failed, not payment_pending", () => {
  assert.match(workerClaim, /checkout_failed/);
  assert.match(workerClaim, /checkout_request_failed/);
  assert.match(workerClaim, /checkout_untrusted_url/);
  assert.match(workerClaim, /status: "checkout_failed"/);
  assert.match(workerClaim, /Checkout was not completed\. Your card was not charged/);
  const terminalGuard = workerClaim.slice(
    workerClaim.indexOf("checkout_failed"),
    workerClaim.indexOf("if (row.status === \"activated\""),
  );
  assert.doesNotMatch(terminalGuard, /status: "payment_pending"/, "terminal checkout errors must not masquerade as payment_pending");
});
