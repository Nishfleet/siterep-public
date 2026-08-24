import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("source mutations create rollback snapshots", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /const SOURCE_SNAPSHOT_LIMIT = 3/);
  assert.match(worker, /function createSourceSnapshot/);
  assert.match(worker, /createSourceSnapshot\(bot, job\.type === "retrain"/);
  assert.match(worker, /createSourceSnapshot\(record, "Before manual source add"/);
  assert.match(worker, /createSourceSnapshot\(record, "Before URL source import"/);
  assert.match(worker, /createSourceSnapshot\(record, "Before source removal"/);
});

test("source rollback restores only restorable snapshots and keeps contents private", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /url\.pathname === "\/api\/sources\/rollback"/);
  assert.match(worker, /snapshot\.restorable === false/);
  assert.match(worker, /record\.sources = await offloadSourceContents\(botId, trimSourcesToPlan\(record, structuredClone\(snapshot\.sources\)\)\)/);
  assert.match(worker, /sourceSnapshots: \(bot\.sourceSnapshots \|\| \[\]\)\.map\(publicSourceSnapshot\)/);
  assert.doesNotMatch(worker, /function publicSourceSnapshot[\s\S]{0,500}sources:/);
});
