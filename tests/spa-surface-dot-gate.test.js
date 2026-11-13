import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
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
    external: ["cloudflare:workers", "node:*"],
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
  const mf = new Miniflare.Miniflare(Miniflare.convertV4MiniflareOptions({
    modulesRoot: bundleDir,
    scriptPath: bundlePath,
    modules: [{ type: "ESModule", path: bundlePath }],
    compatibilityDate: "2026-05-03",
    compatibilityFlags: ["nodejs_als"],
    serviceBindings: { ASSETS: createMockAssets() },
  }));
  return mf;
}

test("runtime: dot-in-path guesses answer HTTP 404 with noindex", async () => {
  const mf = await createRuntime();
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

test("runtime: real bundled assets keep returning 200 with their original content type", async () => {
  const mf = await createRuntime();
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

test("runtime: SPA surfaces (/, /signin) still serve the shell with 200", async () => {
  const mf = await createRuntime();
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

test("runtime: HTML omits Cache-Control no-transform, so Cloudflare can compress it (#185: 30 kB became 156 kB)", async () => {
  const mf = await createRuntime();
  try {
    for (const path of ["/", "/signin"]) {
      const response = await mf.dispatchFetch("https://siterep.net" + path);
      assert.doesNotMatch(
        response.headers.get("cache-control") || "",
        /\bno-transform\b/i,
        `${path}: no-transform stops Cloudflare's edge compression, and the home page went from about 30 kB to 156 kB on the wire (#183 added it, #185 removed it).`,
      );
    }
  } finally {
    await mf.dispose();
  }
});

test("runtime: dot-less unknown paths still 404 (no regression on the existing gate)", async () => {
  const mf = await createRuntime();
  try {
    for (const path of ["/foo", "/bar/baz"]) {
      const response = await mf.dispatchFetch("https://siterep.net" + path);
      assert.equal(response.status, 404, `${path} must answer 404, got ${response.status}`);
    }
  } finally {
    await mf.dispose();
  }
});
