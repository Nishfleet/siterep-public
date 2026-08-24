import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Guards the public demo chat's screen-reader announcement: new answers must
// be announced to assistive tech without making the whole chat region noisy.

test("public demo chat announces new bot answers without making the whole chat live", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  const chatPreview = app.slice(app.indexOf("function ChatPreview"), app.indexOf("function SiteRepConsolePreview"));

  // A dedicated polite live region lives inside the message body.
  assert.match(chatPreview, /role="status" aria-live="polite"/);
  assert.match(chatPreview, /aria-atomic="true"/);
  // It is visually hidden inline so sighted layout and behavior are unchanged.
  assert.match(chatPreview, /position: "absolute"/);
  assert.match(chatPreview, /whiteSpace: "nowrap"/);
  // Only the newest bot answer is fed into the hidden region, and only once per
  // new message id, so previous messages are never re-announced.
  assert.match(chatPreview, /announcedMessageIdRef\.current === null/);
  assert.match(chatPreview, /setLiveAnnouncement\(lastBotMessage\.text\)/);
  // The whole message body is NOT the live region.
  assert.doesNotMatch(chatPreview, /<div className="chat-body"[^>]*aria-live="polite">/);
  // Keyboard sending stays intact.
  assert.match(chatPreview, /event\.key === "Enter"/);
});
