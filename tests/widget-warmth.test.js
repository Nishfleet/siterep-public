import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("widget has a CSS warmth pass with a reduced-motion guard", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  assert.match(widget, /animation:cr-launch-in/);
  assert.match(widget, /animation:cr-msg-in/);
  assert.match(widget, /animation:cr-pulse/);
  assert.match(widget, /@keyframes cr-launch-in/);
  assert.match(widget, /@keyframes cr-msg-in/);
  assert.match(widget, /@keyframes cr-pulse/);
  assert.match(widget, /@media\(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important/);
  assert.ok(Buffer.byteLength(widget, "utf8") <= 36_800);
});
