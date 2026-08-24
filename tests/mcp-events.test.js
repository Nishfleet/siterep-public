import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  MCP_EVENT_NAMES,
  MCP_EVENT_KEY_PREFIX,
  MCP_MAX_COUNT_PER_EVENT_PER_DAY,
  MCP_MAX_DAY_RANGE,
  MCP_RETENTION_DAYS,
  bumpMcpAggregate,
  isValidMcpEventName,
  mcpDayKey,
  mcpDayRange,
  readMcpStats,
  recordMcpEvent,
  scrubMcpAggregate,
} from "../worker/mcp-events.js";
import { collectFunnelEvent, parseFunnelEventPayload, readFunnelStats } from "../worker/funnel-events.js";
import { handleSiteRepMcp } from "../worker/site-rep-mcp.js";

const REQUIRED_SCOPES = ["bot:read", "sources:read", "conversations:read", "leads:read"];
const VALID_TOKEN = "sr_live_valid";

class TestResponse {
  constructor() {
    this.status = 0;
    this.headers = {};
    this.body = "";
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = headers;
  }

  end(body = "") {
    this.body = body ?? "";
  }

  json() {
    return JSON.parse(this.body || "{}");
  }
}

function mcpRequest({ method = "POST", body = {}, headers = {} } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(raw);
  return {
    method,
    body: new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          controller.enqueue(bytes.slice(offset, offset + 8192));
        }
        controller.close();
      },
    }),
    headers: new Headers(headers),
    arrayBuffer: async () => {
      throw new Error("MCP tests should use the streaming body reader.");
    },
    text: async () => raw,
  };
}

function authHeaders(token = VALID_TOKEN, extra = {}) {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
    ...extra,
  };
}

function makeDeps(options = {}) {
  const bot = {
    botId: "starter-demo",
    label: "Starter demo",
    apiKeys: [
      {
        id: "api_123",
        tokenHash: `hash:${VALID_TOKEN}`,
        scopes: options.scopes || REQUIRED_SCOPES,
        revokedAt: "",
      },
    ],
  };
  const state = {
    failedAttempts: 0,
    readStoreCount: 0,
    touches: [],
    mcpEvents: [],
  };
  const deps = {
    buildAgentBrief: (record) => ({ kind: "agentBrief", botId: record.botId, mode: "team_review_required" }),
    buildCustomerReceipt: (record) => ({ kind: "customerReceipt", botId: record.botId, privateAccessMaterial: "" }),
    buildSiteRepPendingWork: (record) => ({ kind: "pendingWork", botId: record.botId, queues: { conversationItems: [] } }),
    checkFailedAuthLimit: async () =>
      options.preAuthLimited ? { limited: true, retryAfterSeconds: 60 } : { limited: false },
    checkPublicRateLimit: async () => ({ limited: false }),
    developerApiKeyPrefix: "sr_live_",
    developerApiRateLimitMax: 120,
    getBotWithRecordLedger: async (botId) => (botId === bot.botId ? bot : null),
    normalizeDeveloperApiScopes: (scopes) => scopes || [],
    readStore: async () => {
      state.readStoreCount += 1;
      return { bots: { [bot.botId]: bot } };
    },
    recordFailedAuthAttempt: async () => {
      state.failedAttempts += 1;
      return { limited: false };
    },
    sha256Hex: async (value) => `hash:${value}`,
    timingSafeEqual: (value, expected) => value === expected,
    touchDeveloperApiKey: async (botId, keyId) => {
      state.touches.push({ botId, keyId });
    },
    // Production wiring (worker/index.js) always passes a recorder; tests
    // mirror that by default. options.noRecorder simulates an unwired harness
    // and options.recorder customizes the callback behavior (e.g. throwing).
    ...(options.noRecorder
      ? {}
      : {
          recordMcpEvent: (eventName) => {
            state.mcpEvents.push(eventName);
            if (options.recorder) options.recorder(eventName);
          },
        }),
  };
  return { deps, state, bot };
}

async function dispatch({ method = "POST", body = {}, headers = {}, deps } = {}) {
  const response = new TestResponse();
  await handleSiteRepMcp(
    mcpRequest({ method, body, headers }),
    response,
    new URL("https://siterep.net/api/mcp"),
    deps || makeDeps().deps,
  );
  return response;
}

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

// ---------------------------------------------------------------------------
// Module: allow-list and spoof-resistant boundary
// ---------------------------------------------------------------------------

test("MCP attribution allow-list covers connection, call, and first value and nothing else", () => {
  assert.deepEqual([...MCP_EVENT_NAMES].sort(), ["mcp_connected", "mcp_customer_receipt_read", "mcp_tool_called"]);
  for (const name of MCP_EVENT_NAMES) {
    assert.equal(isValidMcpEventName(name), true, name);
  }
  // Arbitrary or unsupported event names must fail — including lookalikes and
  // every public funnel event, which live in a separate allow-list.
  for (const junk of [
    "mcp_pageview",
    "mcp_connected_x",
    "mcp_",
    "mcp_receipt_read",
    "demo_opened",
    "signup_succeeded",
    "checkout_opened",
    "unknown_event",
    "MCP_CONNECTED",
    "",
    42,
    null,
    undefined,
  ]) {
    assert.equal(isValidMcpEventName(junk), false, String(junk));
  }
});

test("public funnel beacon cannot record MCP-origin events (spoof-resistant boundary)", async () => {
  // The unauthenticated public endpoint parses only the twelve-event funnel
  // allow-list, so a visitor POSTing mcp_* names gets nothing recorded.
  for (const name of MCP_EVENT_NAMES) {
    assert.equal(parseFunnelEventPayload(JSON.stringify({ event: name })).ok, false, name);
  }

  const kv = fakeKv();
  for (const name of MCP_EVENT_NAMES) {
    const collected = await collectFunnelEvent(JSON.stringify({ event: name }), kv, {
      now: new Date("2026-08-06T12:00:00Z"),
    });
    assert.deepEqual(collected, { event: null, recorded: false }, name);
  }
  assert.equal(kv.puts.length, 0, "MCP event names must never reach KV via the public beacon");

  // Even a foreign writer cannot smuggle MCP counts into the funnel stats
  // view: the funnel read path scrubs unknown keys.
  const funnelKv = fakeKv({
    "funnel-events:2026-08-06": JSON.stringify({ demo_opened: 2, mcp_connected: 999 }),
  });
  const stats = await readFunnelStats(funnelKv, { from: "2026-08-06", to: "2026-08-06" }, new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(stats.days, { "2026-08-06": { demo_opened: 2 } });
  assert.deepEqual(stats.totals, { demo_opened: 2 });
  assert.equal("mcp_connected" in stats.totals, false);
});

// ---------------------------------------------------------------------------
// Module: bounded aggregation
// ---------------------------------------------------------------------------

test("MCP aggregates are scrubbed to the three-event allow-list", () => {
  assert.deepEqual(scrubMcpAggregate({ mcp_connected: 2, ignored_junk: 999 }), { mcp_connected: 2 });
  assert.deepEqual(scrubMcpAggregate({ mcp_connected: "3", mcp_tool_called: null, mcp_customer_receipt_read: -2, demo_opened: 1.5 }), {});
  assert.deepEqual(scrubMcpAggregate({ mcp_connected: 2.7, mcp_tool_called: 1e9 }), {
    mcp_connected: 2,
    mcp_tool_called: MCP_MAX_COUNT_PER_EVENT_PER_DAY,
  });
  assert.deepEqual(scrubMcpAggregate("not an object"), {});
  assert.deepEqual(scrubMcpAggregate([1, 2]), {});
  assert.deepEqual(scrubMcpAggregate(null), {});
  assert.deepEqual(scrubMcpAggregate(undefined), {});
});

test("bumpMcpAggregate drops unknown keys and malformed counters and caps hard", () => {
  assert.deepEqual(bumpMcpAggregate({ ignored_junk: 999, mcp_connected: 2 }, "mcp_connected"), { mcp_connected: 3 });
  assert.deepEqual(bumpMcpAggregate({ mcp_tool_called: "oops", mcp_customer_receipt_read: -3 }, "mcp_tool_called"), {
    mcp_tool_called: 1,
  });

  const saturated = bumpMcpAggregate({ mcp_connected: MCP_MAX_COUNT_PER_EVENT_PER_DAY }, "mcp_connected");
  assert.equal(saturated.mcp_connected, MCP_MAX_COUNT_PER_EVENT_PER_DAY);
});

test("MCP day keys are UTC and use the mcp-events namespace", () => {
  assert.equal(mcpDayKey(new Date("2026-08-06T23:59:59Z")), "mcp-events:2026-08-06");
  assert.equal(mcpDayKey(new Date("2026-08-06T00:00:00Z")), "mcp-events:2026-08-06");
  assert.equal(mcpDayKey(new Date("2027-01-01T00:00:00Z")), "mcp-events:2027-01-01");
  assert.equal(mcpDayKey(new Date("2026-08-06T12:00:00Z")).startsWith(MCP_EVENT_KEY_PREFIX), true);
});

test("recordMcpEvent writes a daily aggregate with bounded retention and never stores unknown names", async () => {
  const kv = fakeKv();
  const first = await recordMcpEvent(kv, "mcp_connected", new Date("2026-08-06T12:00:00Z"));
  assert.equal(first.key, "mcp-events:2026-08-06");
  assert.equal(first.count, 1);
  assert.equal(first.recorded, true);

  const second = await recordMcpEvent(kv, "mcp_connected", new Date("2026-08-06T18:00:00Z"));
  assert.equal(second.count, 2);
  assert.equal(JSON.parse(kv.map.get("mcp-events:2026-08-06")).mcp_connected, 2);

  assert.deepEqual(kv.puts[0].options, { expirationTtl: MCP_RETENTION_DAYS * 86400 });
  assert.ok(MCP_RETENTION_DAYS >= 30, "retention must be bounded and finite");

  const unknown = await recordMcpEvent(kv, "mcp_pageview", new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(unknown, { event: null, recorded: false });
  assert.equal(kv.puts.length, 2, "unknown event names must never reach KV");
});

test("recordMcpEvent survives corrupt storage and is best-effort: never throws", async () => {
  const corrupt = fakeKv({ "mcp-events:2026-08-06": "not json" });
  const result = await recordMcpEvent(corrupt, "mcp_tool_called", new Date("2026-08-06T12:00:00Z"));
  assert.equal(result.count, 1);
  assert.equal(result.recorded, true);

  const brokenStore = {
    async get() {
      throw new Error("kv down");
    },
    async put() {
      throw new Error("kv down");
    },
  };
  const degraded = await recordMcpEvent(brokenStore, "mcp_connected", new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(degraded, { event: "mcp_connected", recorded: false }, "store failures must degrade silently");
});

test("recordMcpEvent never persists unknown keys or malformed counters", async () => {
  const kv = fakeKv({
    "mcp-events:2026-08-06": JSON.stringify({
      mcp_connected: 5,
      unknown_event: 999,
      mcp_tool_called: "oops",
      mcp_customer_receipt_read: -3,
      demo_opened: 1.5,
    }),
  });
  await recordMcpEvent(kv, "mcp_connected", new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(JSON.parse(kv.map.get("mcp-events:2026-08-06")), { mcp_connected: 6 });
});

test("readMcpStats is queryable by date and outcome, scrubbed, and bounded", async () => {
  const kv = fakeKv({
    "mcp-events:2026-08-03": JSON.stringify({ mcp_connected: "many", junk_only: 7 }),
    "mcp-events:2026-08-04": JSON.stringify({ mcp_connected: 2, mcp_tool_called: 3 }),
    "mcp-events:2026-08-05": JSON.stringify({ mcp_connected: 1, mcp_customer_receipt_read: 1 }),
    "mcp-events:2026-08-06": JSON.stringify({ mcp_tool_called: 4, mcp_connected: 1, ignored_junk: 999 }),
  });
  const stats = await readMcpStats(kv, { from: "2026-08-03", to: "2026-08-06" }, new Date("2026-08-06T12:00:00Z"));

  assert.deepEqual(stats.days, {
    "2026-08-04": { mcp_connected: 2, mcp_tool_called: 3 },
    "2026-08-05": { mcp_connected: 1, mcp_customer_receipt_read: 1 },
    "2026-08-06": { mcp_connected: 1, mcp_tool_called: 4 },
  });
  assert.deepEqual(stats.totals, {
    mcp_connected: 4,
    mcp_tool_called: 7,
    mcp_customer_receipt_read: 1,
  });
  assert.equal(stats.retentionDays, MCP_RETENTION_DAYS);

  const empty = await readMcpStats(null, { from: "2026-08-01", to: "2026-08-06" });
  assert.deepEqual(empty, { days: {}, totals: {}, from: "", to: "", retentionDays: MCP_RETENTION_DAYS });

  const wide = await readMcpStats(fakeKv(), { from: "2020-01-01", to: "2026-08-06" }, new Date("2026-08-06T12:00:00Z"));
  assert.ok(Object.keys(wide.days).length <= MCP_MAX_DAY_RANGE, "range must be capped");

  const range = mcpDayRange("2026-08-10", "2026-08-06", new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(range.keys, []);
});

// ---------------------------------------------------------------------------
// Handler: server-derived recording only after server-verified auth
// ---------------------------------------------------------------------------

test("MCP handler records connection, call, and first value after auth — and nothing before it", async () => {
  const connected = makeDeps();
  const init = await dispatch({
    deps: connected.deps,
    body: { jsonrpc: "2.0", id: "init-1", method: "initialize" },
    headers: authHeaders(),
  });
  assert.equal(init.status, 200);
  assert.deepEqual(connected.state.mcpEvents, ["mcp_connected"]);

  const calls = makeDeps();
  for (const [tool, kind] of [
    ["get_site_rep_agent_brief", null],
    ["list_site_rep_pending_work", null],
    ["get_site_rep_customer_receipt", "mcp_customer_receipt_read"],
  ]) {
    const response = await dispatch({
      deps: calls.deps,
      body: { jsonrpc: "2.0", id: tool, method: "tools/call", params: { name: tool, arguments: {} } },
      headers: authHeaders(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json().result.isError, false);
    if (kind) assert.ok(calls.state.mcpEvents.includes(kind), `${tool} must record ${kind}`);
  }
  // Every authenticated tool call records the call counter exactly once, and
  // the receipt read records first value in addition.
  assert.deepEqual(calls.state.mcpEvents, [
    "mcp_tool_called",
    "mcp_tool_called",
    "mcp_tool_called",
    "mcp_customer_receipt_read",
  ]);

  // Unknown tools still count as authenticated call attempts.
  const unknown = makeDeps();
  const badTool = await dispatch({
    deps: unknown.deps,
    body: { jsonrpc: "2.0", id: "unknown", method: "tools/call", params: { name: "send_email", arguments: {} } },
    headers: authHeaders(),
  });
  assert.equal(badTool.json().error.code, -32602);
  assert.deepEqual(unknown.state.mcpEvents, ["mcp_tool_called"]);
});

test("MCP attribution never fires for unauthenticated, unverified, or pre-auth-rejected traffic", async () => {
  // No token at all.
  const anonymous = makeDeps();
  await dispatch({
    deps: anonymous.deps,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(anonymous.state.mcpEvents, []);

  // Invalid token.
  const invalid = makeDeps();
  await dispatch({
    deps: invalid.deps,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    headers: authHeaders("sr_live_random"),
  });
  assert.deepEqual(invalid.state.mcpEvents, []);

  // Missing scopes.
  const scoped = makeDeps({ scopes: ["bot:read"] });
  await dispatch({
    deps: scoped.deps,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    headers: authHeaders(),
  });
  assert.deepEqual(scoped.state.mcpEvents, []);

  // Pre-auth rate limited.
  const limited = makeDeps({ preAuthLimited: true });
  await dispatch({
    deps: limited.deps,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    headers: authHeaders("sr_live_random"),
  });
  assert.deepEqual(limited.state.mcpEvents, []);

  // Unsupported protocol version is rejected before auth ever runs.
  const version = makeDeps();
  await dispatch({
    deps: version.deps,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    headers: authHeaders(VALID_TOKEN, { "mcp-protocol-version": "2099-01-01" }),
  });
  assert.deepEqual(version.state.mcpEvents, []);

  // Browser discovery (GET) is not a connection: no attribution at all.
  const discovery = makeDeps();
  const get = await dispatch({
    deps: discovery.deps,
    method: "GET",
    headers: { accept: "application/json" },
  });
  assert.equal(get.status, 200);
  assert.deepEqual(discovery.state.mcpEvents, []);

  // Malformed initialize (invalid id) is rejected before method dispatch.
  const malformedId = makeDeps();
  await dispatch({
    deps: malformedId.deps,
    body: { jsonrpc: "2.0", id: null, method: "initialize" },
    headers: authHeaders(),
  });
  assert.deepEqual(malformedId.state.mcpEvents, []);
});

test("MCP responses are byte-for-byte unchanged by attribution", async () => {
  // Two independent wired harnesses; recording fires in both, so any change
  // to status or body caused by attribution would show up as a mismatch.
  const harnessA = makeDeps();
  const harnessB = makeDeps();
  const requests = [
    { body: { jsonrpc: "2.0", id: "init-1", method: "initialize" }, headers: authHeaders() },
    {
      body: { jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "get_site_rep_customer_receipt", arguments: {} } },
      headers: authHeaders(),
    },
    { body: { jsonrpc: "2.0", id: "ping-1", method: "ping" }, headers: authHeaders() },
    { body: { jsonrpc: "2.0", id: "list-1", method: "tools/list" }, headers: authHeaders() },
  ];
  for (const request of requests) {
    const recorded = await dispatch({ deps: harnessA.deps, ...request });
    const plain = await dispatch({ deps: harnessB.deps, ...request });
    assert.equal(recorded.status, plain.status, `${request.body.method} status`);
    assert.equal(recorded.body, plain.body, `${request.body.method} body must be identical with and without attribution`);
  }
});

test("MCP attribution degrades cleanly: absent or throwing recorders never break the handler", async () => {
  // No recorder wired at all (deps without recordMcpEvent) — the protocol
  // keeps working exactly as before, exactly like the pre-attribution harness
  // used by the existing site-rep-mcp tests.
  const plain = makeDeps({ noRecorder: true });
  const response = await dispatch({
    deps: plain.deps,
    body: { jsonrpc: "2.0", id: "init-1", method: "initialize" },
    headers: authHeaders(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.json().result.serverInfo.name, "siterep");

  // Recorder throws synchronously — still no effect on the response.
  const throwing = makeDeps({
    recorder: () => {
      throw new Error("recorder exploded");
    },
  });
  const tough = await dispatch({
    deps: throwing.deps,
    body: { jsonrpc: "2.0", id: "init-1", method: "initialize" },
    headers: authHeaders(),
  });
  assert.equal(tough.status, 200);
  assert.equal(tough.json().result.protocolVersion, "2025-06-18");
});

// ---------------------------------------------------------------------------
// Worker wiring: fire-and-forget recording and admin-gated stats read
// ---------------------------------------------------------------------------

test("worker wires fire-and-forget MCP attribution through the Durable Object context", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(worker, /import \{ readMcpStats, recordMcpEvent \} from "\.\/mcp-events\.js"/);

  const mcpWiring = worker.slice(worker.indexOf('url.pathname === "/api/mcp"'), worker.indexOf('url.pathname.startsWith("/api/v1/")'));
  assert.match(mcpWiring, /recordMcpEvent: \(eventName\) => \{/, "the MCP route must pass a recorder dep");
  assert.match(mcpWiring, /activeEnv\?\.CITEREP_STORE/, "recording must be a no-op without the KV store");
  assert.match(mcpWiring, /ctx\.waitUntil\(recording\)/, "recording must be deferred, never awaited");
  assert.match(mcpWiring, /\.catch\(\(\) => \{\}\)/, "recording must never reject");
  assert.doesNotMatch(mcpWiring, /await recordMcpEvent/, "recording must never delay the MCP response");

  // The event names always come from the server-derived allow-list in the
  // handler, never from the request: the wiring itself must not parse bodies.
  const handler = await readFile(new URL("../worker/site-rep-mcp.js", import.meta.url), "utf8");
  assert.match(handler, /noteMcpEvent\(deps, "mcp_connected"\)/);
  assert.match(handler, /noteMcpEvent\(deps, "mcp_tool_called"\)/);
  assert.match(handler, /noteMcpEvent\(deps, "mcp_customer_receipt_read"\)/);
});

test("worker exposes admin-gated MCP attribution stats queryable by date", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(worker, /url\.pathname === "\/api\/mcp\/stats"/);
  assert.match(worker, /isAuthorizedAdmin\(request, url\)/);
  assert.match(worker, /readMcpStats\(activeEnv\?\.CITEREP_STORE, \{ from, to \}\)/);

  const funnelStatsIndex = worker.indexOf('url.pathname === "/api/funnel/stats"');
  const mcpStatsIndex = worker.indexOf('url.pathname === "/api/mcp/stats"');
  const mcpRouteIndex = worker.indexOf('url.pathname === "/api/mcp"');
  assert.ok(funnelStatsIndex > -1 && mcpStatsIndex > -1 && mcpRouteIndex > -1);
  // Exact-match stats route must not be swallowed by the MCP route handler.
  assert.ok(mcpStatsIndex < mcpRouteIndex, "the stats route must be matched before the exact /api/mcp route");
});
