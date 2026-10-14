import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
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

test("worker wires overage: grace gate, gated billing, cron flush, opt-in endpoint", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /responseAnsweringMode\(bot\) === "locked"/);
  assert.match(worker, /const answeringModeNow = responseAnsweringMode\(bot, activeEnv\)/);
  assert.match(worker, /answeringModeNow === "overage"/);
  assert.match(worker, /recordOverageEvent\(bot, conversation\.id/);

  assert.match(worker, /function overageEligible\(bot\)/);
  assert.match(worker, /bot\?\.billing\?\.provider === "dodo" && Boolean\(bot\?\.billing\?\.customerId\)/);
  assert.match(worker, /SITEREP_OVERAGE_BILLING_ENABLED/);

  assert.match(worker, /async function flushOverageUsage/);
  assert.match(worker, /if \(!overageBillingActive\(env\)\) return \{ skipped: true, reason: "billing_disabled" \}/);
  assert.match(worker, /\/events\/ingest/);
  assert.match(worker, /const overage = await flushOverageUsage\(activeEnv\)/);

  assert.match(worker, /url\.pathname === "\/api\/overage\/settings"/);
  assert.match(worker, /"\/api\/overage\/settings",/);
});

test("dashboard shows the overage control only once billing is live and the bot is eligible", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /function setOverageEnabled/);
  assert.match(app, /api<BotState>\("\/api\/overage\/settings"/);
  assert.match(app, /overage\?\.billingActive && overage\?\.eligible \?/);
  assert.match(app, /no surprise charges/i);
});
