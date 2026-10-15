import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("follow-up queue CSV sourceStatus reports source backing, not the follow-up state", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const csvSection = worker.slice(worker.indexOf('url.pathname === "/api/export/follow-up-queue.csv"'));
  assert.match(csvSection, /customerSourceStatus\(item\)/);
  assert.doesNotMatch(csvSection, /customerFollowUpStatus\(item\),\n\s+customerFollowUpStatus\(item\)/);

  const sourceStatusFn = worker.slice(worker.indexOf("function customerSourceStatus"), worker.indexOf("function publicNotificationFor"));
  assert.match(sourceStatusFn, /Existing source needs strengthening/);
  assert.match(sourceStatusFn, /Missing source/);
  assert.match(sourceStatusFn, /sourceTitles/);
});

test("follow-up queue CSV keeps a distinct followUpState column", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const csvSection = worker.slice(worker.indexOf('url.pathname === "/api/export/follow-up-queue.csv"'));
  assert.match(csvSection, /"followUpState"/);
  assert.match(csvSection, /"sourceStatus"/);
  assert.match(csvSection, /customerFollowUpStatus\(item\)/);
});
