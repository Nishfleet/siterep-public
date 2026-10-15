import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("persisted visitor fields are length-capped", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /name: String\(body\.name \|\| existing\?\.name \|\| "Website visitor"\)\.trim\(\)\.slice\(0, 200\)/);
  assert.match(worker, /need: String\(body\.need \|\| existing\?\.need \|\| "Asked a buying question"\)\.trim\(\)\.slice\(0, 2000\)/);
  assert.match(worker, /source: String\(body\.source \|\| existing\?\.source \|\| "Widget"\)\.slice\(0, 80\)/);
  assert.equal((worker.match(/question = String\(question \|\| ""\)\.slice\(0, 2000\)/g) || []).length, 2);
});

test("conversation ids carry jitter so same-millisecond answers don't collide", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const convoJitter = worker.match(/id: Date\.now\(\) \+ Math\.floor\(Math\.random\(\) \* 1000\),\n\s*question,/g) || [];
  assert.equal(convoJitter.length, 2);
});
