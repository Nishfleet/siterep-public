import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("public demo chat announces new bot answers without making the whole chat live", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  const chatPreview = app.slice(app.indexOf("function ChatPreview"), app.indexOf("function SiteRepConsolePreview"));

  assert.match(chatPreview, /role="status" aria-live="polite"/);
  assert.match(chatPreview, /aria-atomic="true"/);
  assert.match(chatPreview, /position: "absolute"/);
  assert.match(chatPreview, /whiteSpace: "nowrap"/);
  assert.match(chatPreview, /announcedMessageIdRef\.current === null/);
  assert.match(chatPreview, /setLiveAnnouncement\(lastBotMessage\.text\)/);
  assert.doesNotMatch(chatPreview, /<div className="chat-body"[^>]*aria-live="polite">/);
  assert.match(chatPreview, /event\.key === "Enter"/);
});
