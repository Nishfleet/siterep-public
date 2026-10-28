import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

async function readWorker() {
  return readFile(new URL("../worker/index.js", import.meta.url), "utf8");
}

test("the unimplemented vector and rerank retrieval layer is gone", async () => {
  const worker = await readWorker();

  for (const symbol of [
    "defaultRetrievalSettings",
    "sanitizeRetrievalSettings",
    "publicRetrievalSettings",
    "activeRetrievalPolicy",
    "answerWithRetrievalPolicy",
    "advancedEnabled",
    "fallbackReason",
    "requestedMode",
    "activeMode",
    "rerankEnabled",
    "evalProfile",
    "answer.retrieval",
    "/api/retrieval/settings",
  ]) {
    assert.ok(!worker.includes(symbol), `expected no "${symbol}" left in worker/index.js`);
  }

  assert.doesNotMatch(worker, /retrieval:/, "no retrieval-policy key may reappear under a new name");
});

test("a request to the removed retrieval-settings route falls through to the not-found response", async () => {
  const worker = await readWorker();

  assert.doesNotMatch(worker, /["'`]\/api\/retrieval\/settings["'`]/);
  assert.match(worker, /API route not found\./);
});

test("answers are produced by the lexical source search directly", async () => {
  const worker = await readWorker();

  assert.match(worker, /answerFromSources\(question, hydrated,/);
  assert.match(worker, /answerFromSources\(\s+question,\s+await hydrateSourcesForQuestion/);
});

test("the answer trace still exists and no longer carries retrieval-policy metadata", async () => {
  const worker = await readWorker();

  assert.match(worker, /function buildAnswerTrace/);
  assert.doesNotMatch(worker, /retrieval: answer\.retrieval/);
});
