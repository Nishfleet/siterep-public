import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  FUNNEL_EVENT_NAMES,
  FUNNEL_EVENT_KEY_PREFIX,
  FUNNEL_MAX_COUNT_PER_EVENT_PER_DAY,
  FUNNEL_MAX_DAY_RANGE,
  FUNNEL_RETENTION_DAYS,
  bumpFunnelAggregate,
  checkFunnelEventRateLimit,
  collectFunnelEvent,
  funnelDayKey,
  funnelDayRange,
  isValidFunnelEventName,
  parseFunnelEventPayload,
  readFunnelStats,
  recordFunnelEvent,
  scrubFunnelAggregate,
} from "../worker/funnel-events.js";

const EXPECTED_EVENTS = [
  "demo_opened",
  "demo_question_submitted",
  "demo_answer_completed",
  "signup_submitted",
  "signup_succeeded",
  "signup_failed",
  "checkout_opened",
  "checkout_succeeded",
  "checkout_failed",
  "signin_opened",
  "signin_succeeded",
  "signin_failed",
];

function fakeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    gets: [],
    puts: [],
    async get(key) {
      this.gets.push(key);
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value, options) {
      this.puts.push({ key, value, options });
      map.set(key, value);
    },
  };
}

test("funnel allow-list covers every required funnel stage and nothing else", () => {
  assert.deepEqual([...FUNNEL_EVENT_NAMES].sort(), [...EXPECTED_EVENTS].sort());
  for (const name of EXPECTED_EVENTS) {
    assert.equal(isValidFunnelEventName(name), true, name);
  }
  for (const junk of ["unknown_event", "demo_opened_x", "email_submitted", "pageview", "", 42, null, undefined]) {
    assert.equal(isValidFunnelEventName(junk), false);
  }
});

test("payload parsing reads only the allow-listed event name and ignores everything else", () => {
  const parsed = parseFunnelEventPayload(JSON.stringify({ event: "demo_opened", question: "what is the price?", email: "visitor@example.com", utm: "x" }));
  assert.deepEqual(parsed, { ok: true, event: "demo_opened" });

  assert.equal(parseFunnelEventPayload(JSON.stringify({ event: "not_allowed" })).ok, false);
  assert.equal(parseFunnelEventPayload("not json").ok, false);
  assert.equal(parseFunnelEventPayload("[]").ok, false);
  assert.equal(parseFunnelEventPayload("{}").ok, false);
  assert.equal(parseFunnelEventPayload({ event: 42 }).ok, false);
  assert.equal(parseFunnelEventPayload(null).ok, false);
  assert.equal(parseFunnelEventPayload("").ok, false);
});

test("stored aggregates are scrubbed to the twelve-event allow-list", () => {
  assert.deepEqual(scrubFunnelAggregate({ demo_opened: 2, ignored_junk: 999 }), { demo_opened: 2 });
  assert.deepEqual(scrubFunnelAggregate({ demo_opened: "3", signin_opened: null, checkout_failed: -2, signup_failed: NaN }), {});
  assert.deepEqual(scrubFunnelAggregate({ demo_opened: 2.7, checkout_succeeded: 1e9 }), {
    demo_opened: 2,
    checkout_succeeded: FUNNEL_MAX_COUNT_PER_EVENT_PER_DAY,
  });
  assert.deepEqual(scrubFunnelAggregate("not an object"), {});
  assert.deepEqual(scrubFunnelAggregate([1, 2]), {});
  assert.deepEqual(scrubFunnelAggregate(null), {});
  assert.deepEqual(scrubFunnelAggregate(undefined), {});
});

test("bumpFunnelAggregate drops unknown keys and malformed counters instead of preserving them", () => {
  assert.deepEqual(bumpFunnelAggregate({ ignored_junk: 999, demo_opened: 2 }, "demo_opened"), { demo_opened: 3 });
  assert.deepEqual(bumpFunnelAggregate({ signin_failed: "oops", checkout_opened: -3, signup_submitted: 1.5 }, "signup_submitted"), {
    signup_submitted: 2,
  });
});

test("daily aggregates increment per outcome and are capped hard", () => {
  assert.deepEqual(bumpFunnelAggregate({}, "demo_opened"), { demo_opened: 1 });
  assert.deepEqual(bumpFunnelAggregate({ demo_opened: 2, signin_opened: 5 }, "demo_opened"), { demo_opened: 3, signin_opened: 5 });

  const saturated = bumpFunnelAggregate({ demo_opened: FUNNEL_MAX_COUNT_PER_EVENT_PER_DAY }, "demo_opened");
  assert.equal(saturated.demo_opened, FUNNEL_MAX_COUNT_PER_EVENT_PER_DAY);
});

test("day keys are UTC and padded", () => {
  assert.equal(funnelDayKey(new Date("2026-08-06T23:59:59Z")), "funnel-events:2026-08-06");
  assert.equal(funnelDayKey(new Date("2026-08-06T00:00:00Z")), "funnel-events:2026-08-06");
  assert.equal(funnelDayKey(new Date("2026-12-31T23:59:59Z")), "funnel-events:2026-12-31");
  assert.equal(funnelDayKey(new Date("2027-01-01T00:00:00Z")), "funnel-events:2027-01-01");
});

test("recordFunnelEvent writes a daily aggregate with bounded retention", async () => {
  const kv = fakeKv();
  const first = await recordFunnelEvent(kv, "demo_opened", new Date("2026-08-06T12:00:00Z"));
  assert.equal(first.key, "funnel-events:2026-08-06");
  assert.equal(first.count, 1);

  const second = await recordFunnelEvent(kv, "demo_opened", new Date("2026-08-06T18:00:00Z"));
  assert.equal(second.count, 2);
  assert.equal(JSON.parse(kv.map.get("funnel-events:2026-08-06")).demo_opened, 2);

  assert.deepEqual(kv.puts[0].options, { expirationTtl: FUNNEL_RETENTION_DAYS * 86400 });
  assert.ok(FUNNEL_RETENTION_DAYS >= 30, "retention must be bounded and finite");
});

test("recordFunnelEvent survives a corrupt stored aggregate", async () => {
  const kv = fakeKv({ "funnel-events:2026-08-06": "not json" });
  const result = await recordFunnelEvent(kv, "signup_submitted", new Date("2026-08-06T12:00:00Z"));
  assert.equal(result.count, 1);
});

test("recordFunnelEvent never persists unknown keys or malformed counters", async () => {
  const kv = fakeKv({
    "funnel-events:2026-08-06": JSON.stringify({ demo_opened: 5, unknown_event: 999, signin_failed: "oops", checkout_opened: -3, signup_submitted: 1.5 }),
  });
  await recordFunnelEvent(kv, "demo_opened", new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(JSON.parse(kv.map.get("funnel-events:2026-08-06")), { demo_opened: 6, signup_submitted: 1 });
});

test("collectFunnelEvent is fire-and-forget: never throws, records best-effort", async () => {
  const kv = fakeKv();
  const recorded = await collectFunnelEvent(JSON.stringify({ event: "demo_opened" }), kv, {
    now: new Date("2026-08-06T12:00:00Z"),
  });
  assert.deepEqual(recorded, { event: "demo_opened", recorded: true });
  assert.equal(JSON.parse(kv.map.get("funnel-events:2026-08-06")).demo_opened, 1);

  const brokenStore = {
    async get() {
      throw new Error("kv down");
    },
    async put() {
      throw new Error("kv down");
    },
  };
  const degraded = await collectFunnelEvent(JSON.stringify({ event: "signup_submitted" }), brokenStore, {
    now: new Date("2026-08-06T12:00:00Z"),
  });
  assert.deepEqual(degraded, { event: "signup_submitted", recorded: false }, "store failures must degrade silently");

  const invalid = await collectFunnelEvent("not json", kv);
  assert.deepEqual(invalid, { event: null, recorded: false });
  assert.equal(kv.puts.length, 1, "invalid payloads must never reach the store");
});

test("collectFunnelEvent applies the per-minute rate limit before recording", async () => {
  const kv = fakeKv();
  let checks = 0;
  const rejecting = () => {
    checks += 1;
    return false;
  };
  const limited = await collectFunnelEvent(JSON.stringify({ event: "checkout_opened" }), kv, { rateLimitCheck: rejecting });
  assert.deepEqual(limited, { event: "checkout_opened", recorded: false });
  assert.equal(checks, 1);
  assert.equal(kv.puts.length, 0, "rate-limited events must not be recorded");

  const accepted = await collectFunnelEvent(JSON.stringify({ event: "checkout_opened" }), kv, { rateLimitCheck: () => true });
  assert.deepEqual(accepted, { event: "checkout_opened", recorded: true });
  assert.equal(kv.puts.length, 1);
});

test("built-in rate limiter caps hits per event per minute", () => {
  for (let hit = 1; hit <= 600; hit++) {
    assert.equal(checkFunnelEventRateLimit("checkout_failed"), true, `hit ${hit} must pass`);
  }
  assert.equal(checkFunnelEventRateLimit("checkout_failed"), false, "the 601st hit in the minute must be dropped");
  assert.equal(checkFunnelEventRateLimit("demo_answer_completed"), true, "other events share no state with a saturated bucket");
});

test("readFunnelStats is queryable by date and outcome and sums totals", async () => {
  const kv = fakeKv({
    "funnel-events:2026-08-02": JSON.stringify({ pure_junk: 1 }),
    "funnel-events:2026-08-03": JSON.stringify({ demo_opened: "many", signup_failed: -1, checkout_opened: 2.9, junk_only: 7 }),
    "funnel-events:2026-08-04": JSON.stringify({ demo_opened: 3, demo_question_submitted: 2 }),
    "funnel-events:2026-08-05": JSON.stringify({ demo_opened: 4, demo_question_submitted: 1, demo_answer_completed: 1 }),
    "funnel-events:2026-08-06": JSON.stringify({ demo_opened: 2, signup_submitted: 1, ignored_junk: 999 }),
  });
  const stats = await readFunnelStats(kv, { from: "2026-08-02", to: "2026-08-06" }, new Date("2026-08-06T12:00:00Z"));

  assert.deepEqual(stats.days, {
    "2026-08-03": { checkout_opened: 2 },
    "2026-08-04": { demo_opened: 3, demo_question_submitted: 2 },
    "2026-08-05": { demo_opened: 4, demo_question_submitted: 1, demo_answer_completed: 1 },
    "2026-08-06": { demo_opened: 2, signup_submitted: 1 },
  });
  assert.deepEqual(stats.totals, {
    checkout_opened: 2,
    demo_opened: 9,
    demo_question_submitted: 3,
    demo_answer_completed: 1,
    signup_submitted: 1,
  });
  assert.equal(stats.retentionDays, FUNNEL_RETENTION_DAYS);
});

test("readFunnelStats is bounded to the retention window and tolerates failures", async () => {
  const kv = fakeKv({ "funnel-events:2026-08-06": JSON.stringify({ demo_opened: 1 }) });
  const wide = await readFunnelStats(kv, { from: "2020-01-01", to: "2026-08-06" }, new Date("2026-08-06T12:00:00Z"));
  assert.ok(wide.days["2026-08-06"], "today must be included");
  assert.ok(Object.keys(wide.days).length <= FUNNEL_MAX_DAY_RANGE, "range must be capped");

  const empty = await readFunnelStats(null, { from: "2026-08-01", to: "2026-08-06" });
  assert.deepEqual(empty, { days: {}, totals: {}, from: "", to: "", retentionDays: FUNNEL_RETENTION_DAYS });

  const range = funnelDayRange("2026-08-10", "2026-08-06", new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(range.keys, []);
});

test("worker serves the funnel event route before the coordinator queue and always 204s", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const fetchHandler = worker.slice(worker.indexOf("async fetch(request, env, ctx)"), worker.indexOf("async scheduled(event, env, ctx)"));

  const eventRouteIndex = fetchHandler.indexOf('url.pathname === "/api/public/funnel-event"');
  const routeApiIndex = fetchHandler.indexOf("routeApiToCoordinator(request, env, ctx)");
  assert.ok(eventRouteIndex > -1, "funnel event route must exist in the top-level fetch handler");
  assert.ok(routeApiIndex > -1);
  assert.ok(eventRouteIndex < routeApiIndex, "funnel collection must not wait behind the Durable Object queue");
  assert.match(worker, /import .* from "\.\/funnel-events\.js"/);

  const handler = worker.slice(worker.indexOf("async function handlePublicFunnelEvent"), worker.indexOf("async function handleApi"));
  assert.match(handler, /writeHead\(204\)/, "collection must answer 204 no matter what");
  // The fire-and-forget contract itself (the waitUntil promise never rejects
  // and is never awaited) is behavior-tested above via collectFunnelEvent;
  // only the deferral wiring is asserted at the source level here.
  assert.match(handler, /ctx\.waitUntil\(/, "collection must be deferred to the event loop as fire-and-forget");
  assert.doesNotMatch(handler, /cookie/i, "collection must never read cookies");
  assert.doesNotMatch(handler, /cf-connecting-ip/i, "collection must never read the visitor IP");
});

test("worker exposes admin-gated funnel stats queryable by date", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(worker, /url\.pathname === "\/api\/funnel\/stats"/);
  assert.match(worker, /isAuthorizedAdmin\(request, url\)/);
  assert.match(worker, /readFunnelStats\(activeEnv\?\.CITEREP_STORE, \{ from, to \}\)/);
});

test("public site fires all twelve funnel events from public surfaces", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const funnel = await readFile(new URL("../src/funnel.ts", import.meta.url), "utf8");

  assert.match(app, /import \{ funnelEvent \} from "\.\/funnel"/);
  assert.match(funnel, /keepalive: true/, "beacon must be best-effort keepalive");
  assert.match(funnel, /credentials: "omit"/, "beacon must never send credentials");
  assert.match(funnel, /content-type": "text\/plain"/, "beacon must stay a simple CORS request");
  assert.match(funnel, /\/api\/public\/funnel-event/);

  for (const name of EXPECTED_EVENTS) {
    assert.match(app, new RegExp(`funnelEvent\\("${name}"\\)`), `App must fire ${name}`);
  }
});

test("live synthetic monitor pins the public funnel delivery contract on the live bundle", async () => {
  const monitor = await readFile(new URL("../scripts/siterep-live-synthetic.mjs", import.meta.url), "utf8");
  // The scout re-files on 2026-08-09 and 2026-08-10 ("closed twin still missing
  // on the live bundle") searched the deployed JS for third-party analytics
  // tokens and missed the first-party allow-listed beacon. The monitor must pin
  // the real contract instead: the collection endpoint stays 204 for invalid
  // payloads (dropped by design, never recorded) and the SPA bundle keeps the
  // collection path plus every allow-listed event name.
  assert.match(monitor, /import \{ FUNNEL_EVENT_NAMES \} from "\.\.\/worker\/funnel-events\.js"/);
  assert.match(monitor, /"funnel event collection"/);
  assert.match(monitor, /funnel collection must answer 204 no matter what/);
  assert.match(monitor, /"funnel instrumentation bundle"/);
  assert.match(monitor, /"\/api\/public\/funnel-event"/);
  assert.match(monitor, /for \(const eventName of FUNNEL_EVENT_NAMES\)/);
});
