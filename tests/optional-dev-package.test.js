import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import { skipReasonIfPackageMissing } from "./optional-dev-package.js";

test("skipReasonIfPackageMissing skips a package that is not installed", () => {
  const reason = skipReasonIfPackageMissing("siterep-definitely-not-installed-package");
  assert.equal(typeof reason, "string");
  assert.match(reason, /siterep-definitely-not-installed-package/);
  assert.match(reason, /not installed/);
});

test("skipReasonIfPackageMissing does not skip an installed package", () => {
  assert.equal(skipReasonIfPackageMissing("fflate"), undefined);
});

test("playwright stays a declared devDependency so CI npm ci still installs it", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(typeof pkg.devDependencies?.playwright, "string");
  assert.match(pkg.devDependencies.playwright, /^\^?\d/);
});

test("tests that import playwright skip via skipReasonIfPackageMissing", async () => {
  const dir = new URL("./", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".test.js"));
  const offenders = [];
  for (const file of files) {
    const source = await readFile(new URL(file, dir), "utf8");
    if (!/\bimport\(\s*["']playwright["']\s*\)|\bfrom\s+["']playwright["']/.test(source)) {
      continue;
    }
    if (!source.includes("skipReasonIfPackageMissing")) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `playwright-using tests must skip via skipReasonIfPackageMissing when the package is absent: ${offenders.join(", ")}`,
  );
});
