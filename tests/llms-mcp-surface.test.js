import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  MCP_PROTOCOL_VERSION,
  SITE_REP_MCP_TOOLS,
} from "../worker/site-rep-mcp.js";

// The live read-only MCP server at /api/mcp is Site Rep's most differentiated
// machine-readable surface, but crawlers and AI agents can only discover it
// through llms.txt. These tests pin the discovery copy to the actual server
// contract so the public description cannot drift from the implementation
// (endpoint, transport, protocol version, bearer auth, GET discovery, the
// three read-only tools, the read-scope boundary, and the explicit
// no-write/no-outbound/no-external-execution boundary).
const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");

const sectionStart = llms.indexOf("Machine-readable MCP surface for agents:");
assert.ok(sectionStart >= 0, "llms.txt must carry the MCP discovery section");
const sectionEnd = llms.indexOf("Contact:", sectionStart);
assert.ok(sectionEnd > sectionStart, "MCP section must close before the contact block");
const section = llms.slice(sectionStart, sectionEnd);

test("llms.txt names the canonical MCP endpoint, transport, and bearer auth", () => {
  assert.match(section, /\/api\/mcp/);
  assert.match(section, /Streamable HTTP JSON-RPC/);
  assert.match(section, new RegExp(MCP_PROTOCOL_VERSION.replace(".", "\\.")));
  assert.match(section, /bearer authentication/i);
});

test("llms.txt says GET discovery needs no key and tools need the account's own key", () => {
  assert.match(section, /GET request returns the live discovery payload/);
  assert.match(section, /calling the tools requires the account's own API key/);
  assert.match(section, /Access still requires the account's own API key/);
});

test("llms.txt lists exactly the three live read-only tools", () => {
  const names = SITE_REP_MCP_TOOLS.map((tool) => tool.name);
  assert.equal(names.length, 3, "manifest must keep exactly three tools");
  for (const name of names) {
    assert.match(section, new RegExp(name.replaceAll("_", "\\_")), `tool ${name} must be named`);
  }
  assert.match(section, /read-only/);
});

test("llms.txt summarizes the required scopes without claiming public access", () => {
  assert.match(section, /limited to reading the account's own bot, sources, conversations, and leads/);
  assert.match(section, /account's own API key/);
});

test("llms.txt states the no-write, no-outbound, no-external-execution boundary", () => {
  assert.match(section, /never writes/);
  assert.match(section, /never sends outbound email/);
  assert.match(section, /never writes to CRM or helpdesk systems/);
  assert.match(section, /never executes external systems/);
});

test("MCP discovery copy stays inside the public claim boundary", () => {
  for (const forbidden of [
    /autonomous/i,
    /no API key required/i,
    /public access/i,
    /MCP workflow/i,
    /workflow execution/i,
  ]) {
    assert.doesNotMatch(section, forbidden, `MCP section must not claim: ${forbidden}`);
  }
});
