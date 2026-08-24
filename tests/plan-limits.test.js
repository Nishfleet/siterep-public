import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("starter plan limits are centralized and enforced by API paths", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /const PLAN_LIMITS = Object\.freeze/);
  assert.match(worker, /Starter: \{\s+priceCents: STARTER_PRICE_CENTS,\s+botLimit: 1,\s+pageLimit: STARTER_PAGE_LIMIT,\s+responseLimit: STARTER_RESPONSE_LIMIT,\s+monthlyRefreshLimit: 4,\s+allowedOriginsLimit: 1,\s+brandingLocked: true,/s);
  assert.match(worker, /function botCreationLimitError/);
  assert.match(worker, /if \(refreshUsageFor\(current\)\.locked\)/);
  assert.match(worker, /if \(current && sourceUsageFor\(current\)\.locked\)/);
  assert.match(worker, /if \(current && !alreadyAllowed && domainUsageFor\(current\)\.locked\)/);
  assert.match(worker, /maxPages: body\.maxPages \|\| pageLimit,\s+pageLimit,/s);
});

test("public config, widget, and dashboard expose the same plan limits", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(worker, /planLimits: bot \? publicPlanLimitsFor\(bot\) : publicPlanLimitsFor\("Starter"\)/);
  // Live usage/limitStatus are private: any visitor can read the public
  // config response, and it must not reveal how close the owner is to caps.
  assert.doesNotMatch(worker, /limitStatus: bot \? limitStatusFor\(bot\) : null/);
  assert.match(worker, /brandingRequired: bot \? planLimitsFor\(bot\)\.brandingLocked : true/);
  assert.match(widget, /let brandingRequired = true/);
  assert.match(widget, /brandingRequired = data\.brandingRequired !== false/);
  assert.match(widget, /powered\.hidden = !brandingRequired/);
  assert.match(app, /type PlanLimits/);
  assert.match(app, /type LimitStatus/);
  assert.match(app, /plan-limit-grid/);
});
