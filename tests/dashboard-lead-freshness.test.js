import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

function dashboardRefreshEffect(source) {
  const intervalIndex = source.indexOf("window.setInterval");
  assert.ok(intervalIndex >= 0, "App.tsx must keep a dashboard refresh interval");
  const effectStart = source.lastIndexOf("useEffect(() => {", intervalIndex);
  assert.ok(
    effectStart >= 0 && effectStart < intervalIndex,
    "the dashboard refresh interval must live inside a useEffect",
  );
  const depsStart = source.indexOf("}, [", intervalIndex);
  assert.ok(depsStart > intervalIndex, "the dashboard refresh effect must close with a dependency array");
  const effectEnd = source.indexOf("]);", depsStart) + 3;
  assert.ok(effectEnd > depsStart, "the dashboard refresh effect must end after its dependency array");
  const effect = source.slice(effectStart, effectEnd);
  const body = effect.slice(0, effect.indexOf("}, ["));
  assert.match(body, /liveCustomerDashboard/, "the refresh interval must sit in the customer-dashboard effect");
  return effect;
}

function runRefreshEffect(effect, { visibilityState = "visible", crawlJobActive = false, liveCustomerDashboard = true } = {}) {
  const body = effect.slice(effect.indexOf("{") + 1, effect.lastIndexOf("}"));
  const calls = [];
  const listeners = new Map();
  const cleared = { count: 0 };
  let intervalFn = null;
  let intervalMs = null;
  const document = {
    visibilityState,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.delete(type, fn),
  };
  const window = {
    setInterval: (fn, ms) => {
      intervalFn = fn;
      intervalMs = ms;
      return 1;
    },
    clearInterval: () => {
      intervalFn = null;
      cleared.count += 1;
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
  const cleanup = run(crawlJobActive, liveCustomerDashboard, "bot-1", (id) => calls.push(id), window, document);
  const emitVisibilityChange = (next) => {
    document.visibilityState = next;
    listeners.get("visibilitychange")?.();
  };
  return { calls, cleared, emitVisibilityChange, intervalMs, listeners, cleanup, runInterval: () => intervalFn?.() };
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

test("the visibility listener and the interval are both dropped on cleanup", () => {
  const { calls, cleared, emitVisibilityChange, cleanup, listeners } = runRefreshEffect(dashboardRefreshEffect(appSource));
  assert.equal(listeners.has("visibilitychange"), true, "the refresh effect must listen for visibilitychange");
  cleanup();
  assert.equal(listeners.has("visibilitychange"), false, "the visibilitychange listener must be removed on cleanup");
  assert.equal(cleared.count, 1, "cleanup must clear the refresh interval");
  emitVisibilityChange("visible");
  assert.deepEqual(calls, [], "a cleaned-up effect must not pull state");
});

test("a closed dashboard and a finished crawl start no refresh at all", () => {
  const { calls, intervalMs, listeners } = runRefreshEffect(dashboardRefreshEffect(appSource), {
    liveCustomerDashboard: false,
  });
  assert.equal(listeners.size, 0, "no dashboard open must register no listener");
  assert.equal(intervalMs, null, "no dashboard open must start no interval");
  assert.deepEqual(calls, [], "no dashboard open must pull no state");
});

test("a running crawl refreshes faster than an idle dashboard", () => {
  const crawl = runRefreshEffect(dashboardRefreshEffect(appSource), { crawlJobActive: true });
  const idle = runRefreshEffect(dashboardRefreshEffect(appSource));
  assert.equal(crawl.intervalMs, 2500, "a running crawl must refresh every 2.5s");
  assert.equal(idle.intervalMs, 10000, "an idle dashboard must refresh every 10s");
  assert.ok(crawl.intervalMs < idle.intervalMs, "a running crawl must refresh faster than an idle dashboard");
});
