import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const HIGH_INTENT_ALIASES = Object.freeze({
  "/signup": "/?surface=free-start",
  "/login": "/signin",
  "/pricing": "/#public-pricing",
  "/docs": "/docs/install",
});

test("high-intent guessed URLs redirect to real product surfaces instead of soft-falling to the homepage", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  for (const [guess, target] of Object.entries(HIGH_INTENT_ALIASES)) {
    assert.ok(worker.includes(`"${guess}": "${target}"`), `${guess} must alias ${target}`);
  }

  assert.match(worker, /const aliasTarget = comparisonAliasFor\(url\) \|\| highIntentAliasFor\(url\)/, "the fetch path must resolve both alias maps");
  assert.match(worker, /if \(request\.method === "GET" \|\| request\.method === "HEAD"\)/, "the alias redirect must apply to GET and HEAD");
  assert.match(worker, /withSecurityHeaders\(Response\.redirect\(new URL\(aliasTarget, url\)\.toString\(\), 301\)\)/, "the alias must 301 to the canonical surface on the same origin");
  assert.ok(worker.indexOf("const aliasTarget = comparisonAliasFor(url)") < worker.indexOf("const trustPage = trustPageFor(url)"), "the alias redirect must run before the trust page lookup");

  assert.match(worker, /function highIntentAliasFor\(url\)/, "a high-intent alias resolver must exist");
  assert.match(worker, /pathname\.replace\(\/\\\/\+\$\/, ""\) \|\| "\/"/, "the resolver must normalize trailing slashes before matching");
});

test("every high-intent alias target is a real working surface", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");

  assert.match(app, /params\.get\("surface"\) === "free-start"/, "the SPA must open the signup flow from the /?surface=free-start entry");
  assert.match(app, /setFreeStartOpen\(true\)/, "the free-start entry must open the signup modal");

  assert.match(app, /normalizedPath === "\/signin" \|\| surfaceParams\.get\("surface"\) === "customer"/, "the SPA must count /signin as the sign-in entry");

  assert.match(app, /<section className="pricing public-pricing" id="public-pricing"/, "the SPA must render the public pricing section the alias points at");

  assert.match(worker, /"\/docs\/install": \{/, "/docs/install must stay a registered TRUST_PAGES entry");
  assert.match(sitemap, /https:\/\/siterep\.net\/docs\/install/, "/docs/install must stay in the sitemap");
  assert.match(llms, /\/docs\/install/, "/docs/install must stay listed in llms.txt");

  for (const guess of Object.keys(HIGH_INTENT_ALIASES)) {
    assert.doesNotMatch(worker, new RegExp(`"${guess}": \\{`), `${guess} must not become a duplicate registered page`);
  }
});
