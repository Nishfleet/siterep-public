import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answeringMode,
  graceLimitFor,
  sanitizeOverageSettings,
  defaultOverageSettings,
  RESPONSE_CAP_GRACE_RATIO,
  DEFAULT_OVERAGE_CEILING,
} from "../worker/overage.js";

test("grace buffer is 10% above the cap", () => {
  assert.equal(RESPONSE_CAP_GRACE_RATIO, 0.1);
  assert.equal(graceLimitFor(1000), 1100);
  assert.equal(graceLimitFor(4000), 4400);
  assert.equal(graceLimitFor(0), 0);
});

test("answering mode walks included → grace → locked when overage is off", () => {
  const base = { limit: 1000, overageEnabled: false, overageEligible: true, billingActive: true };
  assert.equal(answeringMode({ ...base, used: 0 }), "included");
  assert.equal(answeringMode({ ...base, used: 999 }), "included");
  assert.equal(answeringMode({ ...base, used: 1000 }), "grace");
  assert.equal(answeringMode({ ...base, used: 1099 }), "grace");
  assert.equal(answeringMode({ ...base, used: 1100 }), "locked");
});

test("overage only answers past grace when opted in, eligible, billing live, under ceiling", () => {
  const at = (over) => answeringMode({ used: 1100, limit: 1000, reportedThisMonth: 0, maxExtraPerMonth: 5000, ...over });
  assert.equal(at({ overageEnabled: true, overageEligible: true, billingActive: true }), "overage");
  assert.equal(at({ overageEnabled: false, overageEligible: true, billingActive: true }), "locked");
  assert.equal(at({ overageEnabled: true, overageEligible: false, billingActive: true }), "locked");
  assert.equal(at({ overageEnabled: true, overageEligible: true, billingActive: false }), "locked");
  assert.equal(
    answeringMode({ used: 1100, limit: 1000, overageEnabled: true, overageEligible: true, billingActive: true, reportedThisMonth: 5000, maxExtraPerMonth: 5000 }),
    "locked",
  );
});

test("sanitizeOverageSettings clamps and defaults safely", () => {
  const fresh = sanitizeOverageSettings({}, {});
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.maxExtraPerMonth, DEFAULT_OVERAGE_CEILING);
  assert.equal(sanitizeOverageSettings({ enabled: true, maxExtraPerMonth: 2500 }, {}).enabled, true);
  assert.equal(sanitizeOverageSettings({ maxExtraPerMonth: -5 }, {}).maxExtraPerMonth, DEFAULT_OVERAGE_CEILING);
  assert.equal(sanitizeOverageSettings({ maxExtraPerMonth: 9_999_999 }, {}).maxExtraPerMonth, 1_000_000);
  assert.equal(defaultOverageSettings().pending.length, 0);
});


