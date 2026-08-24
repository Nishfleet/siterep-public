import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// The follow-up-queue CSV export promises a per-item sourceStatus column:
// whether the question is backed by an approved source or still missing one.
// A column that duplicated the follow-up state ("Waiting for source update")
// would make the export say nothing about source backing at all.
test("follow-up queue CSV sourceStatus reports source backing, not the follow-up state", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  // The CSV row builder must ask a distinct source-status helper for the
  // sourceStatus column, never the same follow-up state function twice.
  const csvSection = worker.slice(worker.indexOf('url.pathname === "/api/export/follow-up-queue.csv"'));
  assert.match(csvSection, /customerSourceStatus\(item\)/);
  assert.doesNotMatch(csvSection, /customerFollowUpStatus\(item\),\n\s+customerFollowUpStatus\(item\)/);

  // The helper must distinguish existing-but-weak sources from missing ones.
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
