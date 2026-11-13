import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";




test("WordPress plugin Stable tag matches the PHP header Version", async () => {
  const readme = await readFile(new URL("../wordpress-plugin/siterep/readme.txt", import.meta.url), "utf8");
  const php = await readFile(new URL("../wordpress-plugin/siterep/siterep.php", import.meta.url), "utf8");

  const stable = readme.match(/^Stable tag:\s*(\S+)/m);
  const version = php.match(/^\s*\*\s*Version:\s*(\S+)/m);
  assert.ok(stable, "readme.txt must declare Stable tag");
  assert.ok(version, "siterep.php must declare Version");
  assert.equal(stable[1], version[1]);
});
