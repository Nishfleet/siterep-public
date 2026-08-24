import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Guards the embedded widget's screen-reader announcement: only a newly
// completed bot answer may be announced, exactly once, without making the
// whole transcript region live and noisy.

test("embedded widget announces new bot answers without making the whole transcript live", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  // The full transcript container has no live semantics anymore.
  assert.doesNotMatch(widget, /data-cr-body[^>]*aria-live=/);
  // A dedicated polite atomic status region is seeded empty inside the
  // transcript, so the welcome message and suggestions stay quiet.
  assert.match(
    widget,
    /<div class="cr-body" data-cr-body>\s*<div class="cr-hp" data-cr-announcer role="status" aria-live="polite" aria-atomic="true"><\/div>/,
  );
  // The region uses the widget's existing visually-hidden utility class, so
  // sighted layout and behavior are unchanged.
  assert.match(
    widget,
    /\.cr-hp\{position:absolute!important;left:-9999px!important;opacity:0!important;pointer-events:none!important\}/,
  );
  // Only a newly completed bot answer feeds the region: the ask flow assigns
  // it right after the bot message is appended, and nowhere else in the file
  // assigns to it (user messages, typing, suggestions, sources, and lead
  // controls never touch it).
  const askFlow = widget.slice(widget.indexOf("async function askQuestion"), widget.indexOf("async function findAnswer"));
  assert.match(
    askFlow,
    /append\("bot", answer\.text, answer\.sources, answer\.lead, answer\.conversationId, answer\.mode\);\s*announcer\.textContent = answer\.text;/,
  );
  assert.equal((widget.match(/announcer\.textContent =/g) || []).length, 1);
  // Keyboard sending stays intact.
  assert.match(widget, /event\.key === "Enter"/);
});
