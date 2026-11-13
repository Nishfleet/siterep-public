import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";






test("live monitor covers every public demo CTA question", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const monitor = await readFile(new URL("./siterep-live-synthetic.mjs", import.meta.url), "utf8");

  const appMatch = app.match(/const\s+publicDemoQuestions\s*=\s*(\[[^\]]+\]);/);
  assert.ok(appMatch, "publicDemoQuestions array not found in src/App.tsx");
  const appQuestions = [...appMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const workerMatch = worker.match(/PUBLIC_DEMO_WIDGET_SETTINGS\s*=.*?suggestedQuestions:\s*(\[[^\]]+\])/s);
  assert.ok(workerMatch, "PUBLIC_DEMO_WIDGET_SETTINGS.suggestedQuestions not found in worker/index.js");
  const workerQuestions = [...workerMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  assert.deepStrictEqual(appQuestions, workerQuestions);

  for (const question of appQuestions) {
    assert.ok(
      monitor.includes(question),
      `public demo CTA "${question}" is missing from the live canary`,
    );
  }

  assert.match(monitor, /"widget trust chat": 9000/);
});




test("demo-pricing citation points at a page that contains the free-trial text", async () => {
  const { PUBLIC_DEMO_SOURCES } = await import("../worker/demo-sources.js");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  const pricing = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-pricing");
  assert.ok(pricing, "demo-pricing source missing");
  assert.doesNotMatch(pricing.url, /#invitation/);

  const cited = new URL(pricing.url);
  assert.equal(cited.origin, "https://siterep.net");
  const hash = cited.hash.replace(/^#/, "");
  let surface = app;
  if (hash) {
    const section = app.match(new RegExp(`<section[^>]*\\bid="${hash}"[\\s\\S]*?</section>`));
    assert.ok(section, `cited section #${hash} is missing from the homepage`);
    surface = section[0];
  } else {
    assert.equal(cited.pathname, "/");
  }
  assert.match(surface, /50 source-backed answers/);
  assert.match(surface, /no card/i);
});

