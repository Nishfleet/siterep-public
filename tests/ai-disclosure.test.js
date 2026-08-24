import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// A visitor must be told plainly that the thing answering is software, before
// it says anything to them. Both public answering surfaces are covered:
// the embedded widget shipped to customer sites (/widget.js) and the public
// demo chat on the homepage. The disclosure is fixed markup, not a greeting
// string, so an owner's custom welcome message can never replace or hide it.

test("embedded widget discloses AI above the first message and before any answer", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  const noteMatch = widget.match(/<p class="cr-ai-note" data-cr-ai-note>([^<]+)<\/p>/);
  assert.ok(noteMatch, "widget panel must render a static AI disclosure paragraph");
  const noteText = noteMatch[1];
  assert.match(noteText, /\bAI\b/);
  assert.match(noteText, /not a person/i);

  // The disclosure is rendered ahead of the transcript, so it is on screen the
  // moment the panel opens — before the welcome message and any answer.
  const noteIndex = widget.indexOf('<p class="cr-ai-note"');
  const bodyIndex = widget.indexOf('<div class="cr-body" data-cr-body>');
  const welcomeIndex = widget.indexOf("data-cr-welcome");
  assert.ok(noteIndex > 0 && bodyIndex > noteIndex, "disclosure must precede the transcript container");
  assert.ok(welcomeIndex > noteIndex, "disclosure must precede the welcome message");

  // Nothing rewrites it: the hook appears only in that one static paragraph,
  // so owner widget settings (title, welcome message, theme) cannot drop it.
  assert.equal((widget.match(/data-cr-ai-note/g) || []).length, 1);
  const applySettings = widget.slice(widget.indexOf("function applySettings"), widget.indexOf("function setBusy"));
  assert.doesNotMatch(applySettings, /cr-ai-note/);

  // It is styled as a visible strip rather than a screen-reader-only note.
  assert.match(widget, /\.cr-ai-note\{[^}]*\}/);
  assert.doesNotMatch(widget, /class="cr-hp"[^>]*data-cr-ai-note/);

  // The header line names the answerer as AI too, so the disclosure survives
  // even if the strip is scrolled past on a very short panel.
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

  // Rendered before the transcript, so it is read before the seeded first
  // bot message rather than after the visitor has already been answered.
  const noteIndex = chatPreview.indexOf('<p className="chat-disclosure">');
  const bodyIndex = chatPreview.indexOf('<div className="chat-body"');
  assert.ok(noteIndex > 0 && bodyIndex > noteIndex, "disclosure must precede the chat body");

  // It is not a message, so it cannot be trimmed by the message window.
  const messageWindow = chatPreview.indexOf("messages.slice(-6)");
  assert.ok(messageWindow > noteIndex);

  // Visible styling exists (not display:none, not a hidden live region).
  assert.match(styles, /\.chat-disclosure \{[^}]*\}/);
});
