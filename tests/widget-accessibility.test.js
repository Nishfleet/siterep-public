import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("embedded widget announces new bot answers without making the whole transcript live", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  assert.doesNotMatch(widget, /data-cr-body[^>]*aria-live=/);
  assert.match(
    widget,
    /<div class="cr-body" data-cr-body>\s*<div class="cr-hp" data-cr-announcer role="status" aria-live="polite" aria-atomic="true"><\/div>/,
  );
  assert.match(
    widget,
    /\.cr-hp\{position:absolute!important;left:-9999px!important;opacity:0!important;pointer-events:none!important\}/,
  );
  const askFlow = widget.slice(widget.indexOf("async function askQuestion"), widget.indexOf("async function findAnswer"));
  assert.match(
    askFlow,
    /append\("bot", answer\.text, answer\.sources, answer\.lead, answer\.conversationId, answer\.mode\);\s*announcer\.textContent = answer\.text;/,
  );
  assert.equal((widget.match(/announcer\.textContent =/g) || []).length, 1);
  assert.match(widget, /event\.key === "Enter"/);
});
