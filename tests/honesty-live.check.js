import assert from "node:assert/strict";
import { test } from "node:test";

const CHECK_URL = process.env.SITEREP_HONESTY_CHECK_URL || "https://siterep.net/api/public/honesty-check";
const CHECK_ORIGIN = process.env.SITEREP_HONESTY_CHECK_ORIGIN || "https://siterep.net";
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_AGE_MS = 900000;

const configuredTimeout = Number(process.env.SITEREP_HONESTY_CHECK_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS;

async function readCheck() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(CHECK_URL, {
      headers: { origin: CHECK_ORIGIN, accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, body };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`honesty check timed out after ${TIMEOUT_MS}ms: ${CHECK_URL}`);
    throw new Error(`honesty check request failed: ${error.message} (${CHECK_URL})`);
  } finally {
    clearTimeout(timer);
  }
}

test("the deployed honesty check passes and every answer keeps its citation", async () => {
  const { status, body } = await readCheck();
  assert.equal(status, 200, `honesty check answered ${status}: ${String(body).slice(0, 300)}`);
  const payload = JSON.parse(body);
  const ageMs = Date.now() - Date.parse(payload.checkedAt);
  console.log(
    [
      `honesty check ${CHECK_URL}`,
      `checkedAt=${payload.checkedAt}`,
      `age=${Math.round(ageMs / 1000)}s`,
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
  assert.ok(
    Number.isFinite(ageMs) && ageMs < MAX_AGE_MS,
    `checkedAt ${payload.checkedAt} is ${Math.round(ageMs / 1000)}s old; the endpoint sends cache-control public, max-age=300, so an answer older than ${MAX_AGE_MS / 60000} minutes did not come from the worker this run reached`,
  );
  assert.ok(payload.shouldAnswer.total > 0, "the check must ask at least one should-answer question");
  assert.equal(payload.shouldAnswer.passed, payload.shouldAnswer.total, "every should-answer question must answer");
  assert.ok(payload.shouldRefuse.total > 0, "the check must ask at least one should-refuse question");
  assert.equal(payload.shouldRefuse.passed, payload.shouldRefuse.total, "every should-refuse question must refuse");
  assert.ok(payload.citations.total > 0, "the check must cite at least one answer");
  assert.equal(payload.citations.passed, payload.citations.total, "every answer must keep its citation");
  assert.ok(
    payload.pricingAccuracy.skipped ||
      (payload.pricingAccuracy.total > 0 && payload.pricingAccuracy.passed === payload.pricingAccuracy.total),
    "pricing accuracy must pass or be skipped, never fail",
  );
});
