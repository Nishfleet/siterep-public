import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

function dashboardRefreshEffect(source) {
  const intervalIndex = source.indexOf("window.setInterval");
  assert.ok(intervalIndex >= 0, "App.tsx must keep a dashboard refresh interval");
  const effectStart = source.lastIndexOf("useEffect(() => {", intervalIndex);
  const effectEnd = source.indexOf("});", intervalIndex);
  assert.ok(effectStart >= 0 && effectEnd > effectStart, "the dashboard refresh must be a self-contained useEffect");
  return source.slice(effectStart, effectEnd + 3);
}

test("the customer dashboard keeps its own view fresh after the crawl ends", () => {
  const effect = dashboardRefreshEffect(appSource);
  assert.match(effect, /refreshBot\(botId\)/, "the refresh effect must reload the bot state");
  assert.doesNotMatch(
    effect,
    /if \(!crawlJobActive\) return;/,
    "the refresh must not stop the moment a crawl job ends",
  );
  assert.match(
    effect,
    /liveCustomerDashboard/,
    "the refresh must keep running while a customer dashboard is open",
  );
});

test("the idle dashboard refresh lands inside the smoke gate's lead-inbox window", () => {
  const effect = dashboardRefreshEffect(appSource);
  const idle = effect.match(/crawlJobActive \? \d+ : (\d+)\)/);
  assert.ok(idle, "the refresh effect must declare a crawl period and an idle period");
  const idleMs = Number(idle[1]);
  assert.ok(idleMs > 0, `the idle refresh must be a positive interval, got ${idleMs}`);
  assert.ok(idleMs <= 20000, `the idle refresh (${idleMs}ms) must stay inside the smoke gate's 30s lead-inbox window`);
});
