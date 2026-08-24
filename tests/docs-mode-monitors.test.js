import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("launch monitor checks Docs Mode install docs and citation metadata", async () => {
  const monitor = await readFile(new URL("../scripts/siterep-live-synthetic.mjs", import.meta.url), "utf8");

  assert.match(monitor, /"docs install": 3000/);
  assert.match(monitor, /"vs hub": 3000/);
  assert.match(monitor, /\/docs\/install/);
  assert.match(monitor, /not directly installable/);
  assert.match(monitor, /citation was missing a title/);
  assert.match(monitor, /citation was missing a URL or file label/);
  assert.match(monitor, /citation was missing an excerpt/);
  assert.match(monitor, /widget config missing source manifest summary/);
  assert.match(monitor, /widget config abuse protection should be present and off by default/);
});

test("launch monitor pins per-page sitemap lastmod floors so stale deploys fail loudly", async () => {
  const monitor = await readFile(new URL("../scripts/siterep-live-synthetic.mjs", import.meta.url), "utf8");

  // The sitemap probe must exist and run against /sitemap.xml.
  assert.match(monitor, /await probe\("sitemap", "\/sitemap\.xml"/);
  assert.match(monitor, /assertSitemapFreshness\("sitemap", body\)/);

  // Per-page floors: lastmod tracks real content change, so privacy
  // legitimately stays at 2026-08-03 while terms moved to 2026-08-22.
  // These exact pins keep the monitor contract from silently weakening.
  assert.match(monitor, /"\/": "2026-08-09"/);
  assert.match(monitor, /"\/ai-website-chatbot-for-small-business": "2026-08-09"/);
  assert.match(monitor, /"\/privacy": "2026-08-03"/);
  assert.match(monitor, /"\/terms": "2026-08-22"/);
  assert.match(monitor, /"\/trust": "2026-08-11"/);
  assert.match(monitor, /"\/honesty": "2026-08-22"/);
  assert.match(monitor, /"\/docs\/install": "2026-08-11"/);
  assert.match(monitor, /"\/vs": "2026-08-21"/);
  assert.match(monitor, /"\/vs\/customgpt": "2026-08-11"/);
  assert.match(monitor, /{ label: "vs hub", path: "\/vs" }/);
  assert.match(monitor, /"\/vs\/chatbase": "2026-08-11"/);
  assert.match(monitor, /"\/vs\/intercom-fin": "2026-08-11"/);
  assert.match(monitor, /"\/vs\/tidio-lyro": "2026-08-11"/);

  // The guard must fail on stale dates and on missing pinned URLs.
  assert.match(monitor, /advertises stale lastmod dates/);
  assert.match(monitor, /is missing pinned URLs/);
});

test("widget host smoke covers docs render, hotkey, citations, lead linkage, mobile, and overlays", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const smoke = await readFile(new URL("../scripts/siterep-widget-host-smoke.mjs", import.meta.url), "utf8");

  assert.equal(pkg.scripts["smoke:widget-host"], "node scripts/siterep-widget-host-smoke.mjs");
  assert.match(smoke, /Example Docs/);
  assert.match(smoke, /host-overlay/);
  assert.match(smoke, /access-control-allow-origin/);
  assert.match(smoke, /method\(\) === "OPTIONS"/);
  assert.match(smoke, /Ask AI/);
  assert.match(smoke, /Meta\+K/);
  assert.match(smoke, /Control\+K/);
  assert.match(smoke, /How do I install it\?/);
  assert.match(smoke, /Used 1 source/);
  assert.match(smoke, /https:\/\/siterep\.net\/docs\/install/);
  assert.match(smoke, /Can it file my taxes\?/);
  assert.match(smoke, /Lead capture did not preserve conversation linkage/);
  assert.match(smoke, /width: 390, height: 844/);
  assert.match(smoke, /Docs Mode panel escaped viewport/);
  assert.match(smoke, /docs-mode-desktop\.png/);
  assert.match(smoke, /docs-mode-mobile\.png/);
});
