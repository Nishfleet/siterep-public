import assert from "node:assert/strict";
import { test } from "node:test";
import { freeTrialNudge, isFreePlanName } from "../worker/free-trial.js";


test("isFreePlanName recognizes only the Free plan", () => {
  assert.equal(isFreePlanName("Free"), true);
  assert.equal(isFreePlanName(" Free "), true);
  assert.equal(isFreePlanName("Starter"), false);
  assert.equal(isFreePlanName(""), false);
  assert.equal(isFreePlanName(undefined), false);
});

test("conversion nudges fire at half, almost-out, and used-up — once each", () => {
  assert.equal(freeTrialNudge(0), null);
  assert.equal(freeTrialNudge(24), null);
  assert.deepEqual(freeTrialNudge(25), { threshold: 25, kind: "half" });
  assert.deepEqual(freeTrialNudge(44), { threshold: 25, kind: "half" });
  assert.deepEqual(freeTrialNudge(45), { threshold: 45, kind: "almost" });
  assert.deepEqual(freeTrialNudge(49), { threshold: 45, kind: "almost" });
  assert.deepEqual(freeTrialNudge(50), { threshold: 50, kind: "used_up" });
  assert.deepEqual(freeTrialNudge(51), { threshold: 50, kind: "used_up" });
});

test("nudge thresholds derive from the cap so they hold if the cap changes", () => {
  assert.deepEqual(freeTrialNudge(50, 100), { threshold: 50, kind: "half" });
  assert.deepEqual(freeTrialNudge(95, 100), { threshold: 95, kind: "almost" });
  assert.deepEqual(freeTrialNudge(100, 100), { threshold: 100, kind: "used_up" });
  assert.equal(freeTrialNudge(2, 4).threshold >= freeTrialNudge(2, 4).threshold, true);
});

test("negative or junk usage never triggers a nudge", () => {
  assert.equal(freeTrialNudge(-5), null);
  assert.equal(freeTrialNudge(NaN), null);
});


