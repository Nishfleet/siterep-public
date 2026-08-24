import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("worker routes API writes through a Durable Object coordinator", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /export class CiteRepCoordinator extends DurableObject/);
  assert.match(worker, /CITEREP_COORDINATOR\.getByName\("global-store"\)\.fetch\(request\)/);
  assert.match(worker, /serializedWrites:\s*true/);
  assert.match(worker, /storage:\s*"durable-object"/);
});

test("fast health is served before the Durable Object queue", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const fetchHandler = worker.slice(worker.indexOf("async fetch(request, env, ctx)"), worker.indexOf("async scheduled(event, env, ctx)"));
  const fastHealthIndex = fetchHandler.indexOf('url.pathname === "/api/health/live"');
  const routeApiIndex = fetchHandler.indexOf("routeApiToCoordinator(request, env, ctx)");

  assert.ok(fastHealthIndex > -1, "fast liveness route must exist in the top-level Worker fetch handler.");
  assert.ok(routeApiIndex > -1, "API routes still need the Durable Object coordinator.");
  assert.ok(fastHealthIndex < routeApiIndex, "fast liveness must not wait behind the Durable Object queue.");
  assert.match(worker, /url\.pathname === "\/api\/health\/deep"/);
  assert.match(worker, /const store = await readStore\(\)/);
});

test("wrangler config binds the Durable Object with a SQLite migration", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

  assert.deepEqual(config.durable_objects?.bindings?.[0], {
    name: "CITEREP_COORDINATOR",
    class_name: "CiteRepCoordinator",
  });
  assert.equal(config.migrations?.[0]?.tag, "v1-citerep-coordinator");
  assert.deepEqual(config.migrations?.[0]?.new_sqlite_classes, ["CiteRepCoordinator"]);
});
