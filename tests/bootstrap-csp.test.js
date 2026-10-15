import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const script = viteConfig.match(/const BOOTSTRAP_SCRIPT =\s*'([^']+)';/)?.[1];

test("the inline bootstrap script is allowed by the CSP in both header sources", () => {
  assert.ok(script, "BOOTSTRAP_SCRIPT literal not found in vite.config.ts");
  const hash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
  for (const file of ["../public/_headers", "../worker/index.js"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(source.includes(hash), `${file} script-src is missing ${hash}`);
  }
});
