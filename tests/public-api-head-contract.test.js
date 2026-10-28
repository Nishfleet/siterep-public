import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// https://www.rfc-editor.org/rfc/rfc9110 makes HEAD GET without a body, so a public endpoint answers HEAD with the same status and headers as GET.

const PUBLIC_JSON_ENDPOINTS = [
  "/api/health",
  "/api/health/live",
  "/api/public/pricing",
  "/api/public/trust-status",
  "/api/public/release-status",
  "/api/public/honesty-check",
];

const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function readWorker() {
  return readFile(new URL("../worker/index.js", import.meta.url), "utf8");
}

test("every public JSON endpoint answers both GET and HEAD (HEAD is GET without a body)", async () => {
  const worker = await readWorker();

  for (const path of PUBLIC_JSON_ENDPOINTS) {
    assert.match(
      worker,
      new RegExp(`if \\(\\(request\\.method === "GET" \\|\\| request\\.method === "HEAD"\\) && [^\\n]*${escapePattern(path)}`),
      `${path} must accept GET and HEAD`,
    );
  }
});

test("ApiResponse.toResponse returns no body for HEAD but keeps the GET status", async () => {
  const worker = await readWorker();
  const toResponse = worker.slice(worker.indexOf("  toResponse(request) {"), worker.indexOf("  toResponse(request) {") + 400);
  const headFlag = /const head = request\?\.method === "HEAD";/.test(toResponse);
  assert.ok(headFlag, "toResponse must detect HEAD requests");
  assert.match(
    toResponse,
    /const body = head \|\| NULL_BODY_STATUS_CODES\.has\(this\.status\) \? null : this\.body;/,
    "toResponse must emit null body for HEAD or no-content statuses",
  );

  const passes = (worker.match(/response\.toResponse\(request\)/g) || []).length;
  assert.ok(passes >= PUBLIC_JSON_ENDPOINTS.length, `expected at least ${PUBLIC_JSON_ENDPOINTS.length} toResponse(request) calls, found ${passes}`);
});

test("the /trust page links the two machine-readable endpoints the engine flagged", async () => {
  const worker = await readWorker();
  const trustMarkdown = worker.slice(worker.indexOf("const TRUST_STATUS_MARKDOWN"), worker.indexOf("const TERMS_MARKDOWN"));
  assert.match(trustMarkdown, /\[trust status\]\(\/api\/public\/trust-status\)/, "/trust must link the machine-readable trust status");
  assert.match(trustMarkdown, /\[release status\]\(\/api\/public\/release-status\)/, "/trust must link the machine-readable release status");
});