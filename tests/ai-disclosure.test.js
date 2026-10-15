import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("embedded widget discloses AI above the first message and before any answer", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  const noteMatch = widget.match(/<p class="cr-ai-note" data-cr-ai-note>([^<]+)<\/p>/);
  assert.ok(noteMatch, "widget panel must render a static AI disclosure paragraph");
  const noteText = noteMatch[1];
  assert.match(noteText, /\bAI\b/);
  assert.match(noteText, /not a person/i);

  const noteIndex = widget.indexOf('<p class="cr-ai-note"');
  const bodyIndex = widget.indexOf('<div class="cr-body" data-cr-body>');
  const welcomeIndex = widget.indexOf("data-cr-welcome");
  assert.ok(noteIndex > 0 && bodyIndex > noteIndex, "disclosure must precede the transcript container");
  assert.ok(welcomeIndex > noteIndex, "disclosure must precede the welcome message");

  assert.equal((widget.match(/data-cr-ai-note/g) || []).length, 1);
  const applySettings = widget.slice(widget.indexOf("function applySettings"), widget.indexOf("function setBusy"));
  assert.doesNotMatch(applySettings, /cr-ai-note/);

  assert.match(widget, /\.cr-ai-note\{[^}]*\}/);
  assert.doesNotMatch(widget, /class="cr-hp"[^>]*data-cr-ai-note/);

  assert.match(widget, /· AI answers with sources/);
  assert.match(widget, /"Open Site Rep AI assistant"/);
});

test("public demo chat discloses AI above the first message", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  const chatPreview = app.slice(app.indexOf("function ChatPreview"), app.indexOf("function SiteRepConsolePreview"));

  const noteMatch = chatPreview.match(/<p className="chat-disclosure">\s*([^<]+?)\s*<\/p>/);
  assert.ok(noteMatch, "ChatPreview must render a static AI disclosure paragraph");
  assert.match(noteMatch[1], /\bAI\b/);
  assert.match(noteMatch[1], /not a person/i);

  const noteIndex = chatPreview.indexOf('<p className="chat-disclosure">');
  const bodyIndex = chatPreview.indexOf('<div className="chat-body"');
  assert.ok(noteIndex > 0 && bodyIndex > noteIndex, "disclosure must precede the chat body");

  const messageWindow = chatPreview.indexOf("messages.slice(-6)");
  assert.ok(messageWindow > noteIndex);

  assert.match(styles, /\.chat-disclosure \{[^}]*\}/);
});
