import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Dogfood finding 1435d8dfcbe7 (run 20260816T013000Z): the SEO Fix Kit engine
// probes page links with HEAD first and only falls back to GET for 403/405.
// The two machine-readable links on /trust — /api/public/trust-status and
// /api/public/release-status — only answered GET, so HEAD returned 404 and the
// trust page reported "Broken internal links". RFC 9110: HEAD is GET without a
// body, so public endpoints must answer HEAD with the same status and headers.

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
    // The guard must route HEAD straight to the same handler instead of
    // letting it fall through to the /api/ 404 or the unknown-path gate.
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

  // Each public handler must hand its request to toResponse so the body is
  // dropped for HEAD (plain toResponse() without the request would leak a body).
  const passes = (worker.match(/response\.toResponse\(request\)/g) || []).length;
  assert.ok(passes >= PUBLIC_JSON_ENDPOINTS.length, `expected at least ${PUBLIC_JSON_ENDPOINTS.length} toResponse(request) calls, found ${passes}`);
});

test("the /trust page links the two machine-readable endpoints the engine flagged", async () => {
  const worker = await readWorker();
  const trustMarkdown = worker.slice(worker.indexOf("const TRUST_STATUS_MARKDOWN"), worker.indexOf("const TERMS_MARKDOWN"));
  assert.match(trustMarkdown, /\[trust status\]\(\/api\/public\/trust-status\)/, "/trust must link the machine-readable trust status");
  assert.match(trustMarkdown, /\[release status\]\(\/api\/public\/release-status\)/, "/trust must link the machine-readable release status");
});