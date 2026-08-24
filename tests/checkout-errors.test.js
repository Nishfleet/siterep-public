import assert from "node:assert/strict";
import { test } from "node:test";

import { buyerCheckoutErrorMessage } from "../src/checkout-errors.js";

test("buyer checkout errors hide provider and credential details", () => {
  const fallback = "Secure checkout is not available right now. Email hello@siterep.net and the team will open it for you.";

  for (const message of [
    "Dodo API key is not configured.",
    "Invalid Razorpay signature.",
    "Webhook processing failed.",
    "Provider returned an untrusted checkout URL.",
    "Dodo billing portal is not linked for this account yet.",
  ]) {
    assert.equal(buyerCheckoutErrorMessage(new Error(message)), fallback);
  }
});

test("buyer checkout errors keep safe customer-actionable messages", () => {
  assert.equal(
    buyerCheckoutErrorMessage(new Error("Live checkout pricing is not available for this plan yet.")),
    "Live checkout pricing is not available for this plan yet.",
  );
});
