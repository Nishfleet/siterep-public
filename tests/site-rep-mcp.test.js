import assert from "node:assert/strict";
import { test } from "node:test";

import { handleSiteRepMcp } from "../worker/site-rep-mcp.js";

const VALID_TOKEN = "sr_live_valid";
const REQUIRED_SCOPES = ["bot:read", "sources:read", "conversations:read", "leads:read"];

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
  };
  return { deps, state, bot };
}

test("Site Rep MCP discovery is browser-friendly but refuses unsupported SSE GET", async () => {
  const discovery = await dispatch({
    method: "GET",
    headers: { accept: "application/json" },
  });
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers["cache-control"], "no-store");
  assert.deepEqual(discovery.json().auth.requiredScopes, REQUIRED_SCOPES);
  assert.ok(discovery.json().tools.every((tool) => tool.annotations.readOnlyHint === true));
  assert.ok(discovery.json().tools.every((tool) => tool.annotations.destructiveHint === false));

  const sse = await dispatch({
    method: "GET",
    headers: { accept: "text/event-stream" },
  });
  assert.equal(sse.status, 405);
  assert.equal(sse.headers.Allow, "POST, GET");
  assert.equal(sse.body, "");
});

test("Site Rep MCP rejects unsupported protocol versions before auth lookup", async () => {
  const { deps, state } = makeDeps();
  const response = await dispatch({
    deps,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    headers: authHeaders(VALID_TOKEN, { "mcp-protocol-version": "2099-01-01" }),
  });

  assert.equal(response.status, 400);
  assert.match(response.json().error, /Unsupported MCP-Protocol-Version/);
  assert.equal(state.readStoreCount, 0);
});

test("Site Rep MCP rate limits and records failed auth before store-wide token lookup", async () => {
  const limited = makeDeps({ preAuthLimited: true });
  const blocked = await dispatch({
    deps: limited.deps,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    headers: authHeaders("sr_live_random"),
  });
  assert.equal(blocked.status, 429);
  assert.equal(limited.state.readStoreCount, 0);

  const invalid = makeDeps();
  const response = await dispatch({
    deps: invalid.deps,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    headers: authHeaders("sr_live_random"),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(response.json().requiredScopes, REQUIRED_SCOPES);
  assert.equal(invalid.state.failedAttempts, 1);

  const malformed = makeDeps();
  const unauthenticatedMalformed = await dispatch({
    deps: malformed.deps,
    body: "{not-json",
    headers: { "content-type": "application/json" },
  });
  assert.equal(unauthenticatedMalformed.status, 401);
  assert.equal(malformed.state.failedAttempts, 1);
  assert.equal(malformed.state.readStoreCount, 0);
});

test("Site Rep MCP rejects oversized or non-JSON POSTs before auth lookup", async () => {
  const oversized = makeDeps();
  const tooLarge = await dispatch({
    deps: oversized.deps,
    body: { jsonrpc: "2.0", id: "large", method: "initialize" },
    headers: authHeaders(VALID_TOKEN, { "content-length": String(65 * 1024) }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(oversized.state.readStoreCount, 0);

  const wrongType = makeDeps();
  const unsupported = await dispatch({
    deps: wrongType.deps,
    body: { jsonrpc: "2.0", id: "type", method: "initialize" },
    headers: authHeaders(VALID_TOKEN, { "content-type": "text/plain" }),
  });
  assert.equal(unsupported.status, 415);
  assert.equal(wrongType.state.readStoreCount, 0);
});

test("Site Rep MCP enforces the body limit on actual bytes when Content-Length is absent", async () => {
  const { deps, state } = makeDeps();
  const response = await dispatch({
    deps,
    body: {
      jsonrpc: "2.0",
      id: "actual-size",
      method: "initialize",
      padding: "x".repeat(65 * 1024),
    },
    headers: authHeaders(),
  });

  assert.equal(response.status, 413);
  assert.match(response.json().error, /too large/);
  assert.equal(state.readStoreCount, 1);
});

test("Site Rep MCP requires every read scope covered by its tool payloads", async () => {
  const { deps, state } = makeDeps({ scopes: ["bot:read", "sources:read", "conversations:read"] });
  const response = await dispatch({
    deps,
    body: { jsonrpc: "2.0", id: "scope-check", method: "tools/list" },
    headers: authHeaders(),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(response.json().requiredScopes, REQUIRED_SCOPES);
  assert.equal(state.failedAttempts, 1);
});

test("Site Rep MCP initialize, tools/list, and notifications follow JSON-RPC transport shape", async () => {
  const initialized = await dispatch({
    body: { jsonrpc: "2.0", id: "init-1", method: "initialize" },
    headers: authHeaders(),
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.json().jsonrpc, "2.0");
  assert.equal(initialized.json().id, "init-1");
  assert.equal(initialized.json().result.protocolVersion, "2025-06-18");

  const listed = await dispatch({
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    headers: authHeaders(),
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.json().id, 2);
  assert.ok(listed.json().result.tools.every((tool) => tool.annotations.readOnlyHint === true));
  assert.ok(listed.json().result.tools.every((tool) => tool.annotations.destructiveHint === false));

  const ping = await dispatch({
    body: { jsonrpc: "2.0", id: "ping-1", method: "ping" },
    headers: authHeaders(),
  });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json(), { jsonrpc: "2.0", id: "ping-1", result: {} });

  const notification = await dispatch({
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
    headers: authHeaders(),
  });
  assert.equal(notification.status, 202);
  assert.equal(notification.body, "");
});

test("Site Rep MCP rejects invalid request ids", async () => {
  for (const id of [null, true, 1.5, {}, []]) {
    const response = await dispatch({
      body: { jsonrpc: "2.0", id, method: "tools/list" },
      headers: authHeaders(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json().id, null);
    assert.equal(response.json().error.code, -32600);
  }
});

test("Site Rep MCP tools/call returns structured content and safe errors", async () => {
  const { deps, state } = makeDeps();
  for (const [name, kind] of [
    ["get_site_rep_agent_brief", "agentBrief"],
    ["list_site_rep_pending_work", "pendingWork"],
    ["get_site_rep_customer_receipt", "customerReceipt"],
  ]) {
    const response = await dispatch({
      deps,
      body: { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: {} } },
      headers: authHeaders(),
    });
    assert.equal(response.status, 200);
    const result = response.json().result;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.kind, kind);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  assert.equal(state.touches.length, 3);

  const unknown = await dispatch({
    deps,
    body: { jsonrpc: "2.0", id: "unknown", method: "tools/call", params: { name: "send_email", arguments: {} } },
    headers: authHeaders(),
  });
  assert.equal(unknown.json().error.code, -32602);

  const args = await dispatch({
    deps,
    body: {
      jsonrpc: "2.0",
      id: "args",
      method: "tools/call",
      params: { name: "get_site_rep_agent_brief", arguments: { botId: "starter-demo" } },
    },
    headers: authHeaders(),
  });
  assert.equal(args.json().error.code, -32602);
});
