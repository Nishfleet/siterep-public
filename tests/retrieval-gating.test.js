import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("retrieval settings keep lexical as the safe default", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /function defaultRetrievalSettings/);
  assert.match(worker, /mode: "lexical"/);
  assert.match(worker, /rerankEnabled: false/);
  assert.match(worker, /requireEvalPass: true/);
  assert.match(worker, /record\.retrieval = sanitizeRetrievalSettings/);
  assert.match(worker, /retrieval: publicRetrievalSettings\(bot\)/);
});

test("vector and rerank are gated behind eval policy and fail back to lexical", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /function activeRetrievalPolicy/);
  assert.match(worker, /advanced retrieval requires a passing eval profile/);
  assert.match(worker, /advanced retrieval implementation is not enabled yet/);
  assert.match(worker, /return \{ mode: "lexical", advancedEnabled: false, fallbackReason:/);
  assert.match(worker, /function answerWithRetrievalPolicy/);
  assert.match(worker, /const answer = answerFromSources\(question, sources, options\)/);
  assert.match(worker, /requestedMode/);
  assert.match(worker, /activeMode/);
  assert.match(worker, /fallbackReason/);
});

test("retrieval settings are owner-only and not a public visitor mutation", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /url\.pathname === "\/api\/retrieval\/settings"/);
  assert.match(worker, /"\/api\/retrieval\/settings"/);
  const publicRoutes = worker.slice(worker.indexOf("function isPublicApiRoute"), worker.indexOf("function isOwnerAllowedRoute"));
  assert.doesNotMatch(publicRoutes, /\/api\/retrieval\/settings/);
});
