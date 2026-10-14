import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { FREE_ANSWER_CAP, FREE_PLAN_LIMITS, freeTrialNudge, isFreePlanName } from "../worker/free-trial.js";

test("free plan is a no-card, branded, single-site tier with a 50-answer cap", () => {
  assert.equal(FREE_ANSWER_CAP, 50);
  assert.equal(FREE_PLAN_LIMITS.priceCents, 0);
  assert.equal(FREE_PLAN_LIMITS.responseLimit, 50);
  assert.equal(FREE_PLAN_LIMITS.botLimit, 1);
  assert.equal(FREE_PLAN_LIMITS.allowedOriginsLimit, 1);
  assert.equal(FREE_PLAN_LIMITS.brandingLocked, true);
});

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

test("worker wires the free tier through provisioning, counting, and go-live", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const freeStartRoute = worker.slice(
    worker.indexOf('request.method === "POST" && url.pathname === "/api/free/start"'),
    worker.indexOf('request.method === "POST" && url.pathname === "/api/signup-requests"'),
  );
  const nudgeBlock = worker.slice(
    worker.indexOf("function maybeQueueFreeTrialNudge"),
    worker.indexOf("function buildLaunchReport"),
  );

  assert.match(worker, /if \(plan === "Free"\) return "Free"/);
  assert.match(worker, /if \(plan === "Free"\) return FREE_PLAN_LIMITS/);

  assert.match(worker, /if \(isFreePlan\(bot\)\) \{[\s\S]*?bot\.freeTrial\?\.citedAnswersUsed \|\| 0, FREE_ANSWER_CAP/);
  assert.match(worker, /if \(!answer\.unknown && isFreePlan\(bot\)\)/);
  assert.match(worker, /bot\.freeTrial\.citedAnswersUsed = \(bot\.freeTrial\.citedAnswersUsed \|\| 0\) \+ 1/);
  assert.match(worker, /maybeQueueFreeTrialNudge\(bot\)/);

  assert.match(worker, /url\.pathname === "\/api\/free\/start"/);
  assert.match(worker, /if \(method === "POST" && pathname === "\/api\/free\/start"\) return true/);
  assert.match(worker, /function freeTrialClaim/);
  assert.match(worker, /queueCrawlJob\(record, \{ type: "train"/);
  assert.match(freeStartRoute, /Review cited answers, then install the widget when it is ready/);
  assert.match(freeStartRoute, /Upgrade from the live checkout/);
  assert.doesNotMatch(freeStartRoute, /\$9\/month/);
  assert.doesNotMatch(freeStartRoute, /goes live on your site automatically/);
  assert.match(nudgeBlock, /Upgrade from the live checkout/);
  assert.match(nudgeBlock, /exact local price/);
  assert.doesNotMatch(nudgeBlock, /\$9\/month/);
  assert.doesNotMatch(nudgeBlock, /Add a plan from/);

  assert.match(worker, /if \(bot\.lifecycleStatus === "approved" && !publicLaunchBlockers\(bot\)\.length\)/);
  assert.match(worker, /Rep ready for review/);
  assert.match(worker, /Review cited answers, then install the widget when it is ready/);
  assert.doesNotMatch(worker, /went live automatically after the first successful training/);
  assert.match(worker, /!isFreePlan\(bot\) && !billingHasActiveAccess\(bot\.billing\)/);

  assert.match(worker, /freeTrial: isFreePlan\(bot\)/);
  assert.match(worker, /startedAt: bot\.freeTrial\?\.startedAt \|\| ""/);
});

test("the SPA and prerendered homepage expose the no-card free trial", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const index = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(app, /function FreeStartModal/);
  assert.match(app, /api<SelfServeSignupResponse>\("\/api\/free\/start"/);
  assert.match(app, /freeStartOpen \? \(/);
  assert.match(app, /Start free — no card/);
  assert.match(app, /install only after you review a cited answer and add the widget snippet/);
  assert.match(app, /function planPriceSuffix/);
  assert.match(app, /per month, tax included/);
  assert.doesNotMatch(app, /goes live on your site automatically/);
  assert.doesNotMatch(app, /from \$9\/month/);
  assert.match(app, /free-trial-banner/);
  assert.match(app, /setFreeTrial\(bot\.freeTrial \|\| null\)/);
  assert.match(index, /Start free — 50 answers, no card/);
});
