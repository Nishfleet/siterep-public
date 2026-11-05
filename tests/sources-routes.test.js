import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { handleSourcesRoutes } from "../worker/routes/sources.js";

test("handleApi delegates the sources route group instead of rebuilding it", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const sources = await readFile(new URL("../worker/routes/sources.js", import.meta.url), "utf8");

  assert.match(worker, /import \{ handleSourcesRoutes \} from "\.\/routes\/sources\.js";/);
  assert.match(worker, /if \(await handleSourcesRoutes\(request, response, url, \{[\s\S]*?\}\)\) \{\s+return;\s+\}/);

  assert.doesNotMatch(worker, /sourceDraftForQuestion\(question, bot, unknown\)/);
  assert.doesNotMatch(worker, /"Before manual source add"/);
  assert.doesNotMatch(worker, /function sanitizeSourceType/);

  assert.match(sources, /export async function handleSourcesRoutes\(request, response, url, deps\)/);
  assert.equal([...sources.matchAll(/url\.pathname === "\/api\/sources(\/[a-z-]+)?"/g)].length, 10);
  assert.doesNotMatch(sources, /\bfetch\(/);
});

test("sources route group falls through for paths it does not own", async () => {
  const response = {};
  assert.equal(await handleSourcesRoutes({ method: "POST" }, response, { pathname: "/api/sources/unknown" }, {}), false);
  assert.equal(await handleSourcesRoutes({ method: "GET" }, response, { pathname: "/api/sources" }, {}), false);
  assert.equal(await handleSourcesRoutes({ method: "POST" }, response, { pathname: "/api/quality/run" }, {}), false);
});

test("manual source add validates the title before touching storage", async () => {
  const sends = [];
  const handled = await handleSourcesRoutes({ method: "POST" }, {}, { pathname: "/api/sources" }, {
    readJson: async () => ({ title: "ab", content: "x".repeat(60) }),
    sendJson: (response, status, body) => sends.push({ status, body }),
  });

  assert.equal(handled, true);
  assert.deepEqual(sends.map((send) => send.status), [400]);
  assert.match(sends[0].body.error, /title/i);
});

test("source draft route answers with guidance from the injected draft builder", async () => {
  const sends = [];
  const handled = await handleSourcesRoutes({ method: "POST" }, {}, { pathname: "/api/sources/draft" }, {
    readJson: async () => ({ botId: "bot-1", question: "Do you ship to Canada?" }),
    readStore: async () => ({ bots: { "bot-1": { botId: "bot-1", unknowns: [] } } }),
    sourceDraftForQuestion: (question) => ({ title: "Shipping", question, guidance: ["cite a real page"], content: "" }),
    sendJson: (response, status, body) => sends.push({ status, body }),
  });

  assert.equal(handled, true);
  assert.deepEqual(sends.map((send) => send.status), [200]);
  assert.equal(sends[0].body.title, "Shipping");
  assert.equal(sends[0].body.question, "Do you ship to Canada?");
});

test("manual source add route keeps the full update path", async () => {
  const sources = await readFile(new URL("../worker/routes/sources.js", import.meta.url), "utf8");

  assert.match(sources, /if \(title\.length < 3\)/);
  assert.match(sources, /id: uniqueSourceId\(record\.sources \|\| \[\], title\)/);
  assert.match(sources, /createSourceSnapshot\(record, "Before manual source add", \{ title \}\)/);
  assert.match(sources, /await replaceSourceLedgerRecords\(botId, bot\.sources \|\| \[\]\)/);
  assert.match(sources, /sendJson\(response, 200, toPublicBot\(bot\)\)/);
});
