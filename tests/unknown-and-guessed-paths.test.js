import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

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

  for (const [guess, target] of Object.entries(GUESSED_ALIASES)) {
    assert.ok(worker.includes(`"${guess}": "${target}"`), `${guess} must alias ${target}`);
  }

  for (const guess of Object.keys(GUESSED_ALIASES)) {
    assert.doesNotMatch(worker, new RegExp(`"${guess}": \\{`), `${guess} must not become a duplicate registered page`);
  }
});

test("every guessed alias target is a real working surface", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /params\.get\("surface"\) === "free-start"/, "the SPA must open the signup flow from the /?surface=free-start entry");
  assert.match(app, /normalizedPath === "\/signin"/, "the SPA must count /signin as the sign-in entry");
  assert.match(app, /surfaceParams\.get\("surface"\) === "customer"/, "the SPA must count /?surface=customer as the sign-in entry");
  assert.match(app, /id="public-pricing"/, "the SPA must render the public pricing section the alias points at");
  assert.match(app, /id="demo"/, "the SPA must render the live demo section the alias points at");
  assert.match(worker, /"\/docs\/install": \{/, "/docs/install must stay a registered TRUST_PAGES entry");
});

test("unknown dot-less paths return a real 404 instead of the SPA shell", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /if \(\(request\.method === "GET" \|\| request\.method === "HEAD"\) && !isSpaSurfaceRequest\(url\)\)/, "the 404 gate must exist for GET and HEAD");
  assert.ok(worker.indexOf("return notFoundResponse(request);") < worker.indexOf("env.ASSETS.fetch(request)"), "the 404 gate must run before the SPA soft-fallback");
  assert.match(worker, /status: 404/, "the unknown-path response must carry a real 404 status");

  assert.match(worker, /function isMarketingPageRequest\(url\)/, "a homepage-markdown resolver must exist");
  assert.match(worker, /pathname === "\/" \|\| pathname === "\/index\.html"/, "the markdown branch must only answer for the real homepage");
});

test("the 404 page hands lost visitors to the free-start surface with a human label", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const notFound = worker.slice(worker.indexOf("function notFoundResponse"), worker.indexOf("function withSecurityHeaders"));
  assert.match(notFound, /href="\/\?surface=free-start"/, "the 404 page must link the durable free-start entry");
  assert.doesNotMatch(notFound, /href="\/\?surface=free-start">\/\?surface=free-start<\/a>/, "the 404 page must not render the raw /?surface=free-start as link text");
  assert.match(notFound, /href="\/\?surface=free-start">start free with 50 source-backed answers<\/a>/, "the 404 page free-start anchor must carry a human label");
});

test("real SPA surfaces and file requests still reach the SPA fallback", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /const SPA_SURFACE_PATHS = new Set\(\["\/", "\/signin", "\/admin"\]\)/, "/, /signin and /admin must stay served by the SPA");
  assert.doesNotMatch(worker, /lastSegment\.includes\("\."\)/, "the over-permissive dot rule must be removed");
  assert.match(worker, /const WORKER_FILE_EXTENSIONS = new Set\(/, "a precise file-extension allow-list must exist");
  assert.match(worker, /const WORKER_STATIC_PREFIXES = \[?["']\/assets\/["'].*["']\/widget-["'].*["']\/icons\/["']/, "the static-prefix allow-list must cover /assets/, /widget- and /icons/");
  assert.match(worker, /function isAssetsSpaFallback\(url, response\)/, "the ASSETS SPA-fallback detector must exist so allowed-extension guesses still 404");
});
