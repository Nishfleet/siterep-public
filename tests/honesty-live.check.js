import assert from "node:assert/strict";
import { test } from "node:test";

const CHECK_URL = process.env.SITEREP_HONESTY_CHECK_URL || "https://siterep.net/api/public/honesty-check";
const CHECK_ORIGIN = process.env.SITEREP_HONESTY_CHECK_ORIGIN || "https://siterep.net";
const TIMEOUT_MS = Number(process.env.SITEREP_HONESTY_CHECK_TIMEOUT_MS || 20000);

test("the deployed honesty check passes and every answer keeps its citation", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let status;
  let text;
  try {
    const response = await fetch(CHECK_URL, {
      headers: { origin: CHECK_ORIGIN, accept: "application/json" },
      signal: controller.signal,
    });
    status = response.status;
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }
  assert.equal(status, 200, `honesty check answered ${status}: ${text.slice(0, 300)}`);
  const payload = JSON.parse(text);
  console.log(
    [
      `honesty check ${CHECK_URL}`,
      `checkedAt=${payload.checkedAt}`,
      `allPass=${payload.allPass}`,
      `shouldAnswer=${payload.shouldAnswer.passed}/${payload.shouldAnswer.total}`,
      `shouldRefuse=${payload.shouldRefuse.passed}/${payload.shouldRefuse.total}`,
      `citations=${payload.citations.passed}/${payload.citations.total}`,
      `pricingAccuracy=${payload.pricingAccuracy.passed}/${payload.pricingAccuracy.total}`,
      `pricingSkipped=${payload.pricingAccuracy.skipped}`,
    ].join(" "),
  );
  assert.equal(payload.product, "Site Rep");
  assert.equal(payload.allPass, true, "the deployed honesty check must report allPass");
  assert.equal(payload.shouldAnswer.passed, payload.shouldAnswer.total, "every should-answer question must answer");
  assert.equal(payload.shouldRefuse.passed, payload.shouldRefuse.total, "every should-refuse question must refuse");
  assert.equal(payload.citations.passed, payload.citations.total, "every answer must keep its citation");
  assert.ok(
    payload.pricingAccuracy.skipped || payload.pricingAccuracy.passed === payload.pricingAccuracy.total,
    "pricing accuracy must pass or be skipped, never fail",
  );
});
