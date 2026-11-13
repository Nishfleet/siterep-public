import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  SITE_REP_MCP_TOOLS,
} from "../worker/site-rep-mcp.js";

const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");

const sectionStart = llms.indexOf("Machine-readable MCP surface for agents:");
assert.ok(sectionStart >= 0, "llms.txt must carry the MCP discovery section");
const sectionEnd = llms.indexOf("Contact:", sectionStart);
assert.ok(sectionEnd > sectionStart, "MCP section must close before the contact block");
const section = llms.slice(sectionStart, sectionEnd);



test("llms.txt lists exactly the three live read-only tools", () => {
  const names = SITE_REP_MCP_TOOLS.map((tool) => tool.name);
  assert.equal(names.length, 3, "manifest must keep exactly three tools");
  for (const name of names) {
    assert.match(section, new RegExp(name.replaceAll("_", "\\_")), `tool ${name} must be named`);
  }
  assert.match(section, /read-only/);
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
