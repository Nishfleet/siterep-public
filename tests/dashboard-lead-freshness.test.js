import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

function dashboardRefreshEffect(source) {
  const intervalIndex = source.indexOf("window.setInterval");
  assert.ok(intervalIndex >= 0, "App.tsx must keep a dashboard refresh interval");
  const effectStart = source.lastIndexOf("useEffect(() => {", intervalIndex);
  const effectEnd = source.indexOf("]);", source.indexOf("}, [", intervalIndex)) + 3;
  assert.ok(effectStart >= 0 && effectEnd > intervalIndex, "the dashboard refresh must be a self-contained useEffect");
  const effect = source.slice(effectStart, effectEnd);
  assert.match(effect, /liveCustomerDashboard/, "the refresh interval must sit in the customer-dashboard effect");
  return effect;
}

function runRefreshEffect(effect, { visibilityState = "visible", crawlJobActive = false } = {}) {
  const body = effect.slice(effect.indexOf("{") + 1, effect.lastIndexOf("}"));
  const calls = [];
  const listeners = new Map();
  let intervalFn = null;
  const document = {
    visibilityState,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.delete(type, fn),
  };
  const window = {
    setInterval: (fn) => {
      intervalFn = fn;
      return 1;
    },
    clearInterval: () => {
      intervalFn = null;
    },
  };
  const run = new Function(
    "crawlJobActive",
    "liveCustomerDashboard",
    "botId",
    "refreshBot",
    "window",
    "document",
    body,
  );
  const cleanup = run(crawlJobActive, true, "bot-1", (id) => calls.push(id), window, document);
  const emitVisibilityChange = (next) => {
    document.visibilityState = next;
    listeners.get("visibilitychange")?.();
  };
  return { calls, emitVisibilityChange, runInterval: () => intervalFn?.(), cleanup, listeners };
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

test("the timer and the focus trigger share one guarded pull", () => {
  const effect = dashboardRefreshEffect(appSource);
  const pullCalls = effect.match(/refreshBot\(botId\)/g) || [];
  assert.equal(pullCalls.length, 1, "the interval and the focus trigger must share one pull of the bot state");
  const intervalFn = effect.match(/setInterval\(([^,]+),/)[1].trim();
  assert.ok(
    effect.includes(`addEventListener("visibilitychange", ${intervalFn})`),
    "the focus trigger must run the same function the interval runs",
  );
  assert.ok(
    effect.includes(`removeEventListener("visibilitychange", ${intervalFn})`),
    "the focus trigger must be removed with the same function on cleanup",
  );
  assert.match(effect, /visibilityState === "hidden"/, "the shared pull must stay quiet while the tab is hidden");
});

test("a dashboard tab that becomes visible again pulls fresh state at once", () => {
  const { calls, emitVisibilityChange, runInterval, listeners } = runRefreshEffect(dashboardRefreshEffect(appSource));
  assert.ok(listeners.has("visibilitychange"), "the refresh effect must listen for visibilitychange");
  emitVisibilityChange("hidden");
  assert.deepEqual(calls, [], "a tab that stays hidden must not pull state");
  runInterval();
  assert.deepEqual(calls, [], "the interval must not pull while the tab is hidden");
  emitVisibilityChange("visible");
  assert.deepEqual(calls, ["bot-1"], "a tab that returns to the foreground must pull bot state immediately");
  runInterval();
  assert.deepEqual(calls, ["bot-1", "bot-1"], "the interval must keep pulling after a focus refresh");
});

test("the visibility listener is removed when the dashboard closes", () => {
  const { calls, emitVisibilityChange, cleanup, listeners } = runRefreshEffect(dashboardRefreshEffect(appSource));
  assert.equal(listeners.has("visibilitychange"), true, "the refresh effect must listen for visibilitychange");
  cleanup();
  assert.equal(listeners.has("visibilitychange"), false, "the visibilitychange listener must be removed on cleanup");
  emitVisibilityChange("visible");
  assert.deepEqual(calls, [], "a cleaned-up effect must not pull state");
});
