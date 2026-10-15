import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKER_PATH = join(REPO_ROOT, "worker", "index.js");

const DOT_GATE_PATHS = [
  "/foo.com",
  "/ads/google.com",
  "/competitors.com",
  "/pricing.pdf",
  "/robots.json",
  "/foo.test.png",
];

const REAL_FILE_PATHS = [
  "/widget.js",
  "/favicon.svg",
  "/sitemap.xml",
  "/llms.txt",
  "/robots.txt",
  "/apple-touch-icon.png",
  "/widget-test.html",
  "/google09c83c25dc2473f7.html",
];

const EXPECTED_CONTENT_TYPE = {
  "/widget.js": "text/javascript",
  "/favicon.svg": "image/svg+xml",
  "/sitemap.xml": "application/xml",
  "/llms.txt": "text/plain",
  "/robots.txt": "text/plain",
  "/apple-touch-icon.png": "image/png",
  "/widget-test.html": "text/html",
  "/google09c83c25dc2473f7.html": "text/html",
};

test("the over-permissive dot rule is replaced by a precise file-detection rule", async () => {
  const worker = await readFile(WORKER_PATH, "utf8");

  assert.doesNotMatch(worker, /lastSegment\.includes\("\."\)/, "the over-permissive dot rule must be removed");

  assert.match(worker, /const WORKER_FILE_EXTENSIONS = new Set\(/, "WORKER_FILE_EXTENSIONS allow-list must exist");
  for (const ext of ["svg", "png", "jpg", "jpeg", "webp", "ico", "gif", "css", "js", "mjs", "map", "json", "xml", "txt", "pdf", "webmanifest", "wasm"]) {
    assert.ok(worker.includes(`"${ext}"`), `extension ${ext} must be in the allow-list`);
  }

  assert.match(worker, /const WORKER_STATIC_PREFIXES = \[/, "WORKER_STATIC_PREFIXES allow-list must exist");
  for (const prefix of ["/assets/", "/widget-", "/icons/"]) {
    assert.ok(worker.includes(`"${prefix}"`), `static prefix ${prefix} must be in the allow-list`);
  }

  assert.match(worker, /const ext = lastSegment\.slice\(dotIndex \+ 1\)\.toLowerCase\(\);/, "the last segment extension must be parsed and lower-cased");
  assert.match(worker, /return WORKER_FILE_EXTENSIONS\.has\(ext\);/, "isSpaSurfaceRequest must gate on the extension allow-list");
});

test("an ASSETS SPA-fallback detector converts missing-file soft-200s into real 404s", async () => {
  const worker = await readFile(WORKER_PATH, "utf8");

  assert.match(worker, /function isAssetsSpaFallback\(url, response\)/, "isAssetsSpaFallback must exist");
  assert.match(worker, /if \(isAssetsSpaFallback\(url, response\)\) \{\s*return notFoundResponse\(request\);/, "the SPA-fallback detector must convert the soft-200 into a 404 before returning");

  assert.match(worker, /if \(SPA_SURFACE_PATHS\.has\(pathname\)\) return false;/, "SPA surfaces must be excluded from the fallback detector");
  assert.match(worker, /return ext !== "html" && ext !== "htm";/, "real .html files must be excluded from the fallback detector");
});

test("the 404 gate still runs before the ASSETS soft-fallback", async () => {
  const worker = await readFile(WORKER_PATH, "utf8");
  const gateIndex = worker.indexOf("!isSpaSurfaceRequest(url))");
  const assetsIndex = worker.indexOf("env.ASSETS.fetch(request)");
  assert.ok(gateIndex > -1 && assetsIndex > -1, "both the gate and the ASSETS fetch must exist");
  assert.ok(gateIndex < assetsIndex, "the 404 gate must run before the ASSETS soft-fallback");
});

async function buildWorkerBundle() {
  const { build } = await import("esbuild");
  const out = await build({
    entryPoints: [WORKER_PATH],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "neutral",
    write: false,
    outfile: "worker-bundle.mjs",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

function createMockAssets() {
  const publicDir = join(REPO_ROOT, "public");
  const shellHtml = readFileSync(join(REPO_ROOT, "index.html"), "utf8");
  const contentTypeByExt = {
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".ico": "image/x-icon", ".gif": "image/gif", ".css": "text/css",
    ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json",
    ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain",
    ".pdf": "application/pdf", ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm", ".html": "text/html", ".htm": "text/html",
  };
  return function mockAssets(request) {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (rel === "") rel = "index.html";
    const candidate = normalize(join(publicDir, rel));
    if (candidate.startsWith(publicDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const body = readFileSync(candidate);
      const contentType = contentTypeByExt[extname(candidate).toLowerCase()] || "application/octet-stream";
      return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": contentType } });
    }
    return new Response(request.method === "HEAD" ? null : shellHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

async function createRuntime() {
  const [Miniflare, bundled] = await Promise.all([import("miniflare"), buildWorkerBundle()]);
  const bundleDir = join(tmpdir(), "siterep-dot-gate-" + process.pid);
  mkdirSync(bundleDir, { recursive: true });
  const bundlePath = join(bundleDir, "worker-bundle.mjs");
  writeFileSync(bundlePath, bundled);
  const mf = new Miniflare.Miniflare({
    modulesRoot: bundleDir,
    scriptPath: bundlePath,
    modules: [{ type: "ESModule", path: bundlePath }],
    compatibilityDate: "2026-05-03",
    serviceBindings: { ASSETS: createMockAssets() },
  });
  return mf;
}

test("runtime: dot-in-path guesses answer HTTP 404 with noindex", async (t) => {
  let mf;
  try {
    mf = await createRuntime();
  } catch (error) {
    t.skip(`runtime gate unavailable: ${error && error.message ? error.message : error}`);
    return;
  }
  try {
    for (const path of DOT_GATE_PATHS) {
      const response = await mf.dispatchFetch("https://siterep.net" + path);
      const body = await response.text();
      assert.equal(response.status, 404, `${path} must answer 404, got ${response.status}`);
      assert.match(body, /<meta name="robots" content="noindex"/, `${path} 404 body must carry noindex`);
    }
  } finally {
    await mf.dispose();
  }
});

test("runtime: real bundled assets keep returning 200 with their original content type", async (t) => {
  let mf;
  try {
    mf = await createRuntime();
  } catch (error) {
    t.skip(`runtime gate unavailable: ${error && error.message ? error.message : error}`);
    return;
  }
  try {
    for (const path of REAL_FILE_PATHS) {
      const response = await mf.dispatchFetch("https://siterep.net" + path);
      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
      assert.equal(response.status, 200, `${path} must answer 200, got ${response.status}`);
      assert.equal(contentType, EXPECTED_CONTENT_TYPE[path], `${path} must keep its content type ${EXPECTED_CONTENT_TYPE[path]}, got ${contentType}`);
    }
  } finally {
    await mf.dispose();
  }
});

test("runtime: SPA surfaces (/, /signin) still serve the shell with 200", async (t) => {
  let mf;
  try {
    mf = await createRuntime();
  } catch (error) {
    t.skip(`runtime gate unavailable: ${error && error.message ? error.message : error}`);
    return;
  }
  try {
    for (const path of ["/", "/signin"]) {
      const response = await mf.dispatchFetch("https://siterep.net" + path);
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      assert.equal(response.status, 200, `${path} must answer 200, got ${response.status}`);
      assert.ok(contentType.includes("text/html"), `${path} must serve the HTML shell, got ${contentType}`);
    }
  } finally {
    await mf.dispose();
  }
});

test("runtime: dot-less unknown paths still 404 (no regression on the existing gate)", async (t) => {
  let mf;
  try {
    mf = await createRuntime();
  } catch (error) {
    t.skip(`runtime gate unavailable: ${error && error.message ? error.message : error}`);
    return;
  }
  try {
    for (const path of ["/foo", "/bar/baz"]) {
      const response = await mf.dispatchFetch("https://siterep.net" + path);
      assert.equal(response.status, 404, `${path} must answer 404, got ${response.status}`);
    }
  } finally {
    await mf.dispose();
  }
});
