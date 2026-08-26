import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Scout 2026-08-11 (risk: amber, traction, parity-risk): unknown and guessed
// paths still silently soft-fell to the homepage SPA with HTTP 200 — and
// text/markdown crawlers got the homepage markdown for any dot-less URL. A
// soft-200 for a URL that does not exist reads as a real page to search
// engines and directory crawlers. These tests pin the expanded high-intent
// alias map, the unknown-path 404 gate, and that the real SPA surfaces and
// file requests still reach the SPA/ASSETS fallback unchanged.

const GUESSED_ALIASES = Object.freeze({
  "/signup": "/?surface=free-start",
  "/register": "/?surface=free-start",
  "/sign-up": "/?surface=free-start",
  "/start": "/?surface=free-start",
  "/start-free": "/?surface=free-start",
  "/get-started": "/?surface=free-start",
  "/login": "/signin",
  "/log-in": "/signin",
  "/sign-in": "/signin",
  "/app": "/?surface=customer",
  "/dashboard": "/?surface=customer",
  "/pricing": "/#public-pricing",
  "/plans": "/#public-pricing",
  "/demo": "/#demo",
  "/docs": "/docs/install",
  "/install": "/docs/install",
});

test("every remaining high-intent guessed path 301s to one canonical surface", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  // The alias map: every common guess points at exactly one working surface.
  for (const [guess, target] of Object.entries(GUESSED_ALIASES)) {
    assert.ok(worker.includes(`"${guess}": "${target}"`), `${guess} must alias ${target}`);
  }

  // The aliases are never registered as duplicate content pages.
  for (const guess of Object.keys(GUESSED_ALIASES)) {
    assert.doesNotMatch(worker, new RegExp(`"${guess}": \\{`), `${guess} must not become a duplicate registered page`);
  }
});

test("every guessed alias target is a real working surface", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  // signup family -> /?surface=free-start opens the no-card signup modal.
  assert.match(app, /params\.get\("surface"\) === "free-start"/, "the SPA must open the signup flow from the /?surface=free-start entry");
  // signin family -> /signin is the SPA sign-in surface.
  assert.match(app, /normalizedPath === "\/signin"/, "the SPA must count /signin as the sign-in entry");
  // account family -> /?surface=customer is the SPA sign-in entry.
  assert.match(app, /surfaceParams\.get\("surface"\) === "customer"/, "the SPA must count /?surface=customer as the sign-in entry");
  // pricing family -> the live public pricing section exists.
  assert.match(app, /id="public-pricing"/, "the SPA must render the public pricing section the alias points at");
  // demo -> the live demo section exists.
  assert.match(app, /id="demo"/, "the SPA must render the live demo section the alias points at");
  // docs family -> /docs/install stays a registered trust page.
  assert.match(worker, /"\/docs\/install": \{/, "/docs/install must stay a registered TRUST_PAGES entry");
});

test("unknown dot-less paths return a real 404 instead of the SPA shell", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  // The gate answers GET/HEAD for any non-SPA, non-file path, before the
  // ASSETS soft-fallback would serve the homepage shell.
  assert.match(worker, /if \(\(request\.method === "GET" \|\| request\.method === "HEAD"\) && !isSpaSurfaceRequest\(url\)\)/, "the 404 gate must exist for GET and HEAD");
  assert.ok(worker.indexOf("return notFoundResponse(request);") < worker.indexOf("env.ASSETS.fetch(request)"), "the 404 gate must run before the SPA soft-fallback");
  assert.match(worker, /status: 404/, "the unknown-path response must carry a real 404 status");

  // The homepage markdown branch must no longer answer for unknown paths.
  assert.match(worker, /function isMarketingPageRequest\(url\)/, "a homepage-markdown resolver must exist");
  assert.match(worker, /pathname === "\/" \|\| pathname === "\/index\.html"/, "the markdown branch must only answer for the real homepage");
});

test("the 404 page hands lost visitors to the free-start surface with a human label", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const notFound = worker.slice(worker.indexOf("function notFoundResponse"), worker.indexOf("function withSecurityHeaders"));
  // The dead-URL page must still hand visitors to the no-card signup entry —
  // the same durable /?surface=free-start surface the comparison pages link.
  assert.match(notFound, /href="\/\?surface=free-start"/, "the 404 page must link the durable free-start entry");
  // ...with a human label, never the raw developer path as visible link text
  // (the same human-label rule the /vs pages and buyer page follow).
  assert.doesNotMatch(notFound, /href="\/\?surface=free-start">\/\?surface=free-start<\/a>/, "the 404 page must not render the raw /?surface=free-start as link text");
  assert.match(notFound, /href="\/\?surface=free-start">start free with 50 source-backed answers<\/a>/, "the 404 page free-start anchor must carry a human label");
});

test("real SPA surfaces and file requests still reach the SPA fallback", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /const SPA_SURFACE_PATHS = new Set\(\["\/", "\/signin", "\/admin"\]\)/, "/, /signin and /admin must stay served by the SPA");
  // The over-permissive `lastSegment.includes(".")` rule is gone, replaced by
  // a precise file-extension allow-list plus a static-prefix allow-list so
  // dot-in-path guesses (/foo.com, /pricing.pdf) hit the 404 gate instead of
  // leaking through to the SPA shell.
  assert.doesNotMatch(worker, /lastSegment\.includes\("\."\)/, "the over-permissive dot rule must be removed");
  assert.match(worker, /const WORKER_FILE_EXTENSIONS = new Set\(/, "a precise file-extension allow-list must exist");
  assert.match(worker, /const WORKER_STATIC_PREFIXES = \[?["']\/assets\/["'].*["']\/widget-["'].*["']\/icons\/["']/, "the static-prefix allow-list must cover /assets/, /widget- and /icons/");
  assert.match(worker, /function isAssetsSpaFallback\(url, response\)/, "the ASSETS SPA-fallback detector must exist so allowed-extension guesses still 404");
});
