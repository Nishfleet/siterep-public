import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("WordPress plugin injects the supported widget contract", async () => {
  const php = await readFile(new URL("../wordpress-plugin/siterep/siterep.php", import.meta.url), "utf8");

  // Loads the real widget from the canonical origin via data- attributes
  // (the CMS-resilient form widget.js reads from document.currentScript).
  assert.match(php, /SITEREP_WIDGET_SRC', 'https:\/\/siterep\.net\/widget\.js'/);
  assert.match(php, /data-bot-id="%s"/);
  assert.match(php, /data-public-key="%s"/);
  assert.match(php, /defer><\/script>/);
});

test("WordPress plugin follows WordPress security defaults", async () => {
  const php = await readFile(new URL("../wordpress-plugin/siterep/siterep.php", import.meta.url), "utf8");

  // No direct file access; capability check on the settings page.
  assert.match(php, /if \( ! defined\( 'ABSPATH' \) \)/);
  assert.match(php, /current_user_can\( 'manage_options' \)/);
  // Settings API (nonce via settings_fields) + a sanitize callback.
  assert.match(php, /settings_fields\( 'siterep' \)/);
  assert.match(php, /'sanitize_callback' => 'siterep_sanitize_settings'/);
  assert.match(php, /preg_replace\( '\/\[\^a-zA-Z0-9_-\]\/'/);
  // Output is escaped.
  assert.match(php, /esc_attr\( \$bot_id \)/);
  assert.match(php, /esc_attr\( \$public_key \)/);
  // The widget key is documented as non-secret (domain-locked), so storing it is fine.
  assert.match(php, /domain-locked/i);
});

test("WordPress plugin ships a valid WordPress.org readme", async () => {
  const readme = await readFile(new URL("../wordpress-plugin/siterep/readme.txt", import.meta.url), "utf8");

  assert.match(readme, /^=== Site Rep/);
  assert.match(readme, /Stable tag: 1\.0\.0/);
  assert.match(readme, /License: GPLv2 or later/);
  // Sets the honest expectation that a Site Rep account is required.
  assert.match(readme, /You need a Site Rep account/);
});

test("WordPress plugin Stable tag matches the PHP header Version", async () => {
  const readme = await readFile(new URL("../wordpress-plugin/siterep/readme.txt", import.meta.url), "utf8");
  const php = await readFile(new URL("../wordpress-plugin/siterep/siterep.php", import.meta.url), "utf8");

  const stable = readme.match(/^Stable tag:\s*(\S+)/m);
  const version = php.match(/^\s*\*\s*Version:\s*(\S+)/m);
  assert.ok(stable, "readme.txt must declare Stable tag");
  assert.ok(version, "siterep.php must declare Version");
  assert.equal(stable[1], version[1]);
});
