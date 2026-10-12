import assert from "node:assert/strict";
import { test } from "node:test";
import { collectPricingStamps } from "./pricing-stamps.js";

const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

// Scheduled only (weekly workflow, filed as a follow-up). Not named
// *.test.js, so `npm test` and the PR gate never run it: it compares the
// literal stamps to the clock and would fail unrelated PRs once they age.
test("every comparison leaf pricing-check stamp is within 60 days", async () => {
  for (const { path, month, year } of await collectPricingStamps()) {
    const ageMs = Date.now() - Date.UTC(year, month - 1, 1);
    assert.ok(ageMs >= 0, `${path} stamp ${year}-${month} must not be in the future`);
    assert.ok(ageMs <= MAX_AGE_MS, `${path} stamp ${year}-${month} is older than 60 days`);
  }
});
