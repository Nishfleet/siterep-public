import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const script = viteConfig.match(/const BOOTSTRAP_SCRIPT =\s*'([^']+)';/)?.[1];
const previewPage = readFileSync(new URL("../public/widget-test.html", import.meta.url), "utf8");
const previewScript = previewPage.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const workerSource = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");

test("the inline bootstrap script is allowed by the CSP in both header sources", () => {
  assert.ok(script, "BOOTSTRAP_SCRIPT literal not found in vite.config.ts");
  const hash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
  for (const file of ["../public/_headers", "../worker/index.js"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(source.includes(hash), `${file} script-src is missing ${hash}`);
  }
});

test("the install preview inline script is allowed by the preview CSP", () => {
  assert.ok(previewScript, "inline script not found in public/widget-test.html");
  const hash = `sha256-${createHash("sha256").update(previewScript).digest("base64")}`;
  assert.ok(
    workerSource.includes(hash),
    `worker/index.js install-preview script-src is missing ${hash}: the preview page will render an empty widget`,
  );
});

test("only the install preview page may be framed, and only by this origin", () => {
  assert.match(workerSource, /"content-security-policy":\s*"[^"]*frame-ancestors 'none'/);
  assert.match(
    workerSource,
    /\.replace\("frame-ancestors 'none'", "frame-ancestors 'self'"\)/,
    "the install preview CSP must relax frame-ancestors to 'self'",
  );
  assert.match(workerSource, /headers\.set\("x-frame-options", "SAMEORIGIN"\)/);
});
