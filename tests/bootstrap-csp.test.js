import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { widgetPreviewCsp } from "../worker/widget-preview-csp.js";

const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const script = viteConfig.match(/const BOOTSTRAP_SCRIPT =\s*'([^']+)';/)?.[1];
const previewPage = readFileSync(new URL("../public/widget-test.html", import.meta.url), "utf8");
const previewScript = previewPage.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const workerSource = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
const baseCsp = workerSource.match(/"content-security-policy":\s*"([^"]+)"/)?.[1];
const declaredPreviewHash = workerSource.match(/WIDGET_PREVIEW_INLINE_SCRIPT_HASH = "([^"]+)"/)?.[1];

test("the inline bootstrap script is allowed by the CSP in both header sources", () => {
  assert.ok(script, "BOOTSTRAP_SCRIPT literal not found in vite.config.ts");
  const hash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
  for (const file of ["../public/_headers", "../worker/index.js"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(source.includes(hash), `${file} script-src is missing ${hash}`);
  }
});

test("the install preview page keeps exactly one inline script", () => {
  assert.equal(
    (previewPage.match(/<script/g) || []).length,
    1,
    "public/widget-test.html must keep one plain inline script, so its hash stays the only script it needs",
  );
});

test("the preview CSP allows the hash of the script public/widget-test.html actually serves", () => {
  assert.ok(previewScript, "inline script not found in public/widget-test.html");
  assert.ok(baseCsp, "the base content-security-policy literal was not found in worker/index.js");
  assert.ok(declaredPreviewHash, "WIDGET_PREVIEW_INLINE_SCRIPT_HASH was not found in worker/index.js");
  const servedHash = `sha256-${createHash("sha256").update(previewScript).digest("base64")}`;
  assert.equal(
    declaredPreviewHash,
    servedHash,
    "worker/index.js allows a different inline script than public/widget-test.html serves: the preview renders an empty widget",
  );
  const previewCsp = widgetPreviewCsp(baseCsp, declaredPreviewHash);
  assert.ok(
    previewCsp.includes(`'${servedHash}'`),
    `the preview script-src does not allow ${servedHash}`,
  );
});

test("only the install preview page may be framed, and only by this origin", () => {
  assert.match(baseCsp ?? "", /frame-ancestors 'none'/);
  const previewCsp = widgetPreviewCsp(baseCsp, declaredPreviewHash);
  assert.match(previewCsp, /frame-ancestors 'self'/);
  assert.doesNotMatch(previewCsp, /frame-ancestors 'none'/);
  assert.match(workerSource, /headers\.set\("x-frame-options", "SAMEORIGIN"\)/);
  assert.match(workerSource, /headers\.set\("x-robots-tag", "noindex"\)/);
});
