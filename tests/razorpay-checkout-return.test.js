import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// D6 UX flow: Razorpay buyers return with signed payment-link params while the
// webhook is still catching up. claimRazorpayReturn must poll payment_pending
// like claimDodoReturn instead of falling through to handleSelfServeSignup and
// reporting checkout_failed on a still-valid pending payment.

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

const claimRazorpayFn = app.slice(
  app.indexOf("async function claimRazorpayReturn"),
  app.indexOf("async function claimDodoReturn"),
);
const workerClaim = worker.slice(
  worker.indexOf("async function claimRazorpayPayment"),
  worker.indexOf("async function activatePaidCustomer(env, payment"),
);

test("razorpay checkout return polls payment_pending before giving up", () => {
  assert.match(claimRazorpayFn, /async function claimRazorpayReturn\(attempt = 0\)/);
  const pendingBlock = claimRazorpayFn.slice(
    claimRazorpayFn.indexOf("if (result.status === \"payment_pending\")"),
    claimRazorpayFn.indexOf("if (result.status === \"payment_mismatch\")"),
  );
  assert.match(pendingBlock, /attempt < 5/);
  assert.match(pendingBlock, /claimRazorpayReturn\(attempt \+ 1\)/);
  assert.match(pendingBlock, /setPaymentClaimState\("pending"\)/);
});

test("razorpay checkout return scrubs URL and reports failure after pending retries exhaust", () => {
  const pendingBlock = claimRazorpayFn.slice(
    claimRazorpayFn.indexOf("if (result.status === \"payment_pending\")"),
    claimRazorpayFn.indexOf("if (result.status === \"payment_mismatch\")"),
  );
  assert.match(pendingBlock, /scrubPaymentParamsFromUrl\(\)/, "exhausted pending retries must scrub Razorpay return params");
  assert.match(pendingBlock, /funnelEvent\("checkout_failed"\)/, "exhausted pending retries must record checkout_failed");
  assert.match(
    pendingBlock,
    /Checkout was not completed\. Your card was not charged/,
    "exhausted pending retries must tell the buyer checkout did not finish",
  );
});

test("worker razorpay claim can return payment_pending before activation", () => {
  assert.match(workerClaim, /status: "payment_pending"/);
  assert.match(workerClaim, /activatePaidCustomer/);
});
