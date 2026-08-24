import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// The real embedded widget should feel as alive as the homepage demo — a
// lightweight, accessibility-respecting warmth pass (no logic changes).
test("widget has a CSS warmth pass with a reduced-motion guard", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  assert.match(widget, /animation:cr-launch-in/);
  assert.match(widget, /animation:cr-msg-in/);
  assert.match(widget, /animation:cr-pulse/);
  assert.match(widget, /@keyframes cr-launch-in/);
  assert.match(widget, /@keyframes cr-msg-in/);
  assert.match(widget, /@keyframes cr-pulse/);
  // Honors prefers-reduced-motion.
  assert.match(widget, /@media\(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important/);
  // Docs Mode and the citation drawer are first-class behavior, so the
  // lightweight budget moves up but still prevents accidental bundle creep.
  // 36,800: the lead form's visitor-check gate (lead submit must block until
  // the Turnstile token exists, matching the chat path) added ~360 bytes.
  assert.ok(Buffer.byteLength(widget, "utf8") <= 36_800);
});
