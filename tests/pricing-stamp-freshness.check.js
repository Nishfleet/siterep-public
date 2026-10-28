import assert from "node:assert/strict";
import { test } from "node:test";
import { collectPricingStamps } from "./pricing-stamps.js";

const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

test("every comparison leaf pricing-check stamp is within 60 days", async () => {
  for (const { path, month, year } of await collectPricingStamps()) {
    const ageMs = Date.now() - Date.UTC(year, month - 1, 1);
    assert.ok(ageMs >= 0, `${path} stamp ${year}-${month} must not be in the future`);
    assert.ok(ageMs <= MAX_AGE_MS, `${path} stamp ${year}-${month} is older than 60 days`);
  }
});
