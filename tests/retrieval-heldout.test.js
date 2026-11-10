import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PUBLIC_DEMO_SOURCES } from "../worker/demo-sources.js";

const CATEGORIES = ["short", "long", "misspelled", "no-answer"];

test("the held-out retrieval eval fixture parses, has 40+ grounded cases, and covers the required question shapes", async () => {
  const raw = await readFile(
    new URL("./fixtures/retrieval-heldout.json", import.meta.url),
    "utf8",
  );
  const fixture = JSON.parse(raw);
  assert.ok(Array.isArray(fixture.cases), "fixture must hold a cases array");

  const cases = fixture.cases;
  assert.ok(cases.length >= 40, `expected at least 40 held-out cases, got ${cases.length}`);

  const demoIds = new Set(PUBLIC_DEMO_SOURCES.map((source) => source.id));
  const seenCategories = new Set();
  const targeted = new Set();
  for (const item of cases) {
    assert.ok(item && typeof item.question === "string" && item.question.trim().length > 0,
      `case ${item && item.id} must carry a question`);
    assert.ok(Array.isArray(item.expectedSourceIds),
      `case ${item.id} must list expectedSourceIds`);
    for (const id of item.expectedSourceIds) {
      assert.ok(demoIds.has(id), `case ${item.id} expects source id "${id}" that is not in worker/demo-sources.js`);
      targeted.add(id);
    }
    assert.ok(CATEGORIES.includes(item.category),
      `case ${item.id} must be one of ${CATEGORIES.join(", ")}`);
    seenCategories.add(item.category);
  }

  for (const category of CATEGORIES) {
    assert.ok(seenCategories.has(category), `held-out eval must cover ${category} questions`);
  }
  for (const source of PUBLIC_DEMO_SOURCES) {
    assert.ok(targeted.has(source.id), `no held-out case targets demo source ${source.id}`);
  }
});
