export const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_MAX_POST_BYTES = 64 * 1024;

export const SITE_REP_MCP_REQUIRED_SCOPES = Object.freeze([
  "bot:read",
  "sources:read",
  "conversations:read",
  "leads:read",
]);

export const SITE_REP_MCP_READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const SITE_REP_MCP_TOOLS = Object.freeze([
  {
    name: "get_site_rep_agent_brief",
    title: "Get Site Rep Agent Brief",
    description:
      "Read the account-owned Site Rep handoff brief: readiness, unresolved conversation work, lead follow-ups, source gaps, answer QA gaps, account tasks, and safe exports.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: SITE_REP_MCP_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "list_site_rep_pending_work",
    title: "List Site Rep Pending Work",
    description:
      "Read the account-owned customer work queues that still need team review, keeping conversation-linked customer work separated from account tasks.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: SITE_REP_MCP_READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_site_rep_customer_receipt",
    title: "Get Site Rep Customer Receipt",
    description:
      "Read the account-owned first-customer receipt with payment/free-start, source, cited-answer, widget-install, lead, and export evidence. Private access material is omitted.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: SITE_REP_MCP_READ_ONLY_ANNOTATIONS,
  },
]);

export async function handleSiteRepMcp(request, response, url, deps) {
  if (request.method === "GET") {
    if (headerValue(request, "accept").toLowerCase().includes("text/event-stream")) {
      sendMcpEmpty(response, 405, { Allow: "POST, GET" });
      return;
    }
    sendMcpJson(response, 200, discoveryPayload(url));
    return;
  }

  if (request.method !== "POST") {
    sendMcpJson(response, 405, { error: "This MCP endpoint accepts GET discovery or JSON-RPC over POST." }, { Allow: "GET, POST" });
    return;
  }

  const protocolVersion = headerValue(request, "mcp-protocol-version");
  if (protocolVersion && protocolVersion !== MCP_PROTOCOL_VERSION) {
    sendMcpJson(response, 400, {
      error: "Unsupported MCP-Protocol-Version.",
      supportedProtocolVersion: MCP_PROTOCOL_VERSION,
    });
    return;
  }

  const postGuard = validateMcpPostHeaders(request);
  if (!postGuard.ok) {
    sendMcpJson(response, postGuard.status, { error: postGuard.error });
    return;
  }

  const authorization = await authorizeMcpRequest(request, deps, SITE_REP_MCP_REQUIRED_SCOPES);
  if (!authorization.ok) {
    sendMcpJson(response, authorization.status || 401, {
      error: authorization.error || "Valid Site Rep API key required.",
      retryAfterSeconds: authorization.retryAfterSeconds,
      requiredScopes: authorization.requiredScopes,
    });
    return;
  }

  let message = null;
  try {
    message = await readJson(request);
  } catch {
    if (request._mcpBodyTooLarge) {
      sendMcpJson(response, 413, { error: "MCP JSON-RPC request body is too large." });
      return;
    }
    if (request._mcpBodyUnbounded) {
      sendMcpJson(response, 411, { error: "MCP JSON-RPC request body must be stream-readable or include Content-Length." });
      return;
    }
    sendMcpJsonRpcError(response, null, -32700, "Parse error");
    return;
  }

  if (!isSiteRepMcpMessage(message)) {
    sendMcpJsonRpcError(response, null, -32600, "Invalid Request");
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id") && !isValidMcpRequestId(message.id)) {
    sendMcpJsonRpcError(response, null, -32600, "Invalid Request");
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    sendMcpEmpty(response, 202);
    return;
  }

  const id = message.id;
  if (message.method === "initialize") {
    // Server-derived MCP-origin attribution: only reachable after the
    // server-verified API-key check above, so a browser hitting the public
    // discovery URL can never fabricate a connection counter.
    noteMcpEvent(deps, "mcp_connected");
    sendMcpJsonRpcResult(response, id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: "siterep",
        title: "Site Rep",
        version: "1.0.0",
      },
      instructions:
        "Use these read-only tools to inspect Site Rep customer work queues and first-customer evidence. Draft replies and source fixes for team review; do not send autonomous outbound messages, write to a CRM/helpdesk, or claim external workflow execution from this MCP endpoint.",
    });
    return;
  }

  if (message.method === "ping") {
    sendMcpJsonRpcResult(response, id, {});
    return;
  }

  if (message.method === "tools/list") {
    sendMcpJsonRpcResult(response, id, { tools: SITE_REP_MCP_TOOLS });
    return;
  }

  if (message.method === "tools/call") {
    const toolName = String(message.params?.name || "");
    const result = await callSiteRepMcpTool(authorization, message.params, deps);
    // Any authenticated tools/call is agent-native activity; the receipt read
    // additionally marks first value (the receipt is the first-value evidence
    // surface). Both counters are server-derived, never client-supplied.
    noteMcpEvent(deps, "mcp_tool_called");
    if (!result.ok) {
      sendMcpJsonRpcError(response, id, -32602, result.message);
      return;
    }
    if (toolName === "get_site_rep_customer_receipt") {
      noteMcpEvent(deps, "mcp_customer_receipt_read");
    }
    sendMcpJsonRpcResult(response, id, result.value);
    return;
  }

  sendMcpJsonRpcError(response, id, -32601, `Method not found: ${message.method}`);
}

function validateMcpPostHeaders(request) {
  const contentType = headerValue(request, "content-type").toLowerCase();
  if (contentType && !contentType.includes("application/json")) {
    return { ok: false, status: 415, error: "MCP JSON-RPC POST requests must use application/json." };
  }
  const contentLength = Number(headerValue(request, "content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MCP_MAX_POST_BYTES) {
    return { ok: false, status: 413, error: "MCP JSON-RPC request body is too large." };
  }
  return { ok: true };
}

export function discoveryPayload(url) {
  return {
    name: "Site Rep MCP",
    status: "live",
    endpoint: `${url.origin}/api/mcp`,
    transport: "streamable-http-json-rpc",
    protocolVersion: MCP_PROTOCOL_VERSION,
    auth: {
      type: "bearer",
      header: "Authorization: Bearer <Site Rep API key>",
      requiredScopes: SITE_REP_MCP_REQUIRED_SCOPES,
    },
    tools: SITE_REP_MCP_TOOLS,
    liveDataScope: [
      "Account-owned handoff brief",
      "Conversation-linked unresolved customer work",
      "Lead follow-ups linked to conversations",
      "Source gaps and answer QA gaps that need team review",
      "First-customer receipt evidence and safe export links",
    ],
    safety: {
      mode: "team_review_required",
      outboundEmail: "not_available",
      crmOrHelpdeskWrites: "not_available",
      externalSystemExecution: "not_available",
    },
  };
}

async function authorizeMcpRequest(request, deps, requiredScopes = SITE_REP_MCP_REQUIRED_SCOPES) {
  const failedLimit = await deps.checkFailedAuthLimit(request, {}, "mcp-api-key");
  if (failedLimit.limited) {
    return {
      ok: false,
      status: 429,
      error: "API key is rate limited. Try again shortly.",
      retryAfterSeconds: failedLimit.retryAfterSeconds,
      requiredScopes,
    };
  }

  const token = developerApiTokenFromRequest(request);
  if (!token || !token.startsWith(deps.developerApiKeyPrefix)) {
    return await failedMcpAuth(request, deps, requiredScopes);
  }

  const tokenHash = await deps.sha256Hex(token);
  const store = await deps.readStore();
  let authorizedBot = null;
  let authorizedApiKey = null;
  for (const bot of Object.values(store.bots || {})) {
    if (!bot) continue;
    const apiKey = (bot.apiKeys || []).find((key) => !key.revokedAt && deps.timingSafeEqual(key.tokenHash, tokenHash));
    if (apiKey) {
      authorizedBot = bot;
      authorizedApiKey = apiKey;
      break;
    }
  }
  if (!authorizedBot || !authorizedApiKey) {
    return await failedMcpAuth(request, deps, requiredScopes);
  }

  const scopes = deps.normalizeDeveloperApiScopes(authorizedApiKey.scopes);
  const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length) {
    const failure = await deps.recordFailedAuthAttempt(request, {}, "mcp-api-key");
    return {
      ok: false,
      status: failure.limited ? 429 : 403,
      error: failure.limited ? "API key is rate limited. Try again shortly." : "API key scope is not allowed for this MCP route.",
      retryAfterSeconds: failure.retryAfterSeconds,
      requiredScopes,
    };
  }

  const rateLimit = await deps.checkPublicRateLimit(`mcp:${authorizedBot.botId}`, authorizedApiKey.id, "mcp", deps.developerApiRateLimitMax);
  if (rateLimit.limited) {
    return {
      ok: false,
      status: 429,
      error: "API key is rate limited. Try again shortly.",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      requiredScopes,
    };
  }
  return { ok: true, bot: authorizedBot, apiKey: authorizedApiKey, scopes };
}

async function failedMcpAuth(request, deps, requiredScopes) {
  const failure = await deps.recordFailedAuthAttempt(request, {}, "mcp-api-key");
  return {
    ok: false,
    status: failure.limited ? 429 : 401,
    error: failure.limited ? "API key is rate limited. Try again shortly." : "Valid Site Rep API key required.",
    retryAfterSeconds: failure.retryAfterSeconds,
    requiredScopes,
  };
}

// Best-effort MCP-origin attribution: hands a server-derived event name to
// the caller-wired recorder (worker/index.js writes it to KV fire-and-forget
// via ctx.waitUntil). Synchronous dispatch, never awaited, never throws, and
// never changes the MCP response — attribution must not affect the protocol.
// With no recorder wired (e.g., unit harnesses or a future caller), recording
// simply degrades to a no-op.
function noteMcpEvent(deps, eventName) {
  if (!deps || typeof deps.recordMcpEvent !== "function") return;
  try {
    deps.recordMcpEvent(eventName);
  } catch {
    // Attribution failures are swallowed by design.
  }
}

async function callSiteRepMcpTool(authorization, params, deps) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, message: "tools/call params must be an object." };
  }
  const name = String(params.name || "");
  const args = params.arguments || {};
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
    return { ok: false, message: `${name || "Tool"} does not accept arguments.` };
  }

  const bot = await deps.getBotWithRecordLedger(authorization.bot.botId);
  if (!bot) return { ok: false, message: "Site Rep account not found." };
  await deps.touchDeveloperApiKey(bot.botId, authorization.apiKey.id);

  if (name === "get_site_rep_agent_brief") {
    return mcpStructuredToolResult(deps.buildAgentBrief(bot));
  }
  if (name === "list_site_rep_pending_work") {
    return mcpStructuredToolResult(deps.buildSiteRepPendingWork(bot));
  }
  if (name === "get_site_rep_customer_receipt") {
    return mcpStructuredToolResult(deps.buildCustomerReceipt(bot));
  }
  return { ok: false, message: `Unknown tool: ${name}` };
}

function isSiteRepMcpMessage(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.jsonrpc === "2.0" && typeof value.method === "string");
}

function isValidMcpRequestId(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function mcpStructuredToolResult(structuredContent) {
  return {
    ok: true,
    value: {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
      isError: false,
    },
  };
}

function sendMcpJsonRpcResult(response, id, result) {
  sendMcpJson(response, 200, {
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendMcpJsonRpcError(response, id, code, message) {
  sendMcpJson(response, 200, {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function sendMcpJson(response, status, data, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

function sendMcpEmpty(response, status, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    ...headers,
  });
  response.end("");
}

async function readJson(request) {
  if (request._jsonBody !== undefined) return request._jsonBody;
  const raw = await readLimitedBody(request);
  request._jsonBody = raw ? JSON.parse(raw) : {};
  return request._jsonBody;
}

async function readLimitedBody(request) {
  request._mcpBodyTooLarge = false;
  request._mcpBodyUnbounded = false;

  if (request.body && typeof request.body.getReader === "function") {
    const reader = request.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > MCP_MAX_POST_BYTES) {
          request._mcpBodyTooLarge = true;
          await reader.cancel().catch(() => {});
          throw new Error("MCP body too large.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  }

  const contentLength = Number(headerValue(request, "content-length") || 0);
  if (!contentLength) {
    request._mcpBodyUnbounded = true;
    throw new Error("MCP body length required.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MCP_MAX_POST_BYTES) {
    request._mcpBodyTooLarge = true;
    throw new Error("MCP body too large.");
  }
  return raw;
}

function developerApiTokenFromRequest(request) {
  const authorization = headerValue(request, "authorization");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return bearer || headerValue(request, "x-siterep-api-key");
}

function headerValue(request, name) {
  const lower = name.toLowerCase();
  return String(request?.headers?.get?.(name) || request?.headers?.get?.(lower) || request?.headers?.[lower] || request?.headers?.[name] || "");
}
