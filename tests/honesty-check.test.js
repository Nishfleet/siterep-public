import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile } from "node:fs/promises";

import { answerFromSources } from "../server/search.js";
import { PUBLIC_DEMO_SOURCES, applyLiveDemoPricingAnswer } from "../worker/demo-sources.js";
import { runHonestyEvals, runPricingAccuracyEval, PRICING_QUESTIONS, citationUrlSupportsAnswer } from "../worker/honesty-evals.js";

const DEMO_SOURCES = PUBLIC_DEMO_SOURCES.map((source) => ({
  ...source,
  excerpt: source.content.slice(0, 240),
  indexedAt: "2026-05-30T00:00:00.000Z",
}));

const LIVE_PRICING_CATALOG = {
  ok: true,
  provider: "dodo",
  plans: [
    { name: "Starter", source: "dodo_checkout_preview", currency: "EUR", amountSubunits: 925, displayPrice: "€9.25" },
    { name: "Growth", source: "dodo_checkout_preview", currency: "EUR", amountSubunits: 2980, displayPrice: "€29.80" },
    { name: "Pro", source: "dodo_checkout_preview", currency: "EUR", amountSubunits: 6064, displayPrice: "€60.64" },
    { name: "Agency", source: "dodo_checkout_preview", currency: "EUR", amountSubunits: 15313, displayPrice: "€153.13" },
  ],
  generatedAt: "2026-08-21T00:00:00.000Z",
};

test("honesty page and live check endpoint are wired and discoverable", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");

  assert.match(worker, /url\.pathname === "\/api\/public\/honesty-check"/);
  assert.match(worker, /function publicHonestyCheckResponse/);
  assert.match(worker, /runHonestyEvals\(answerFromSources, publicDemoSources\(\), pricingCatalog\)/);
  assert.match(worker, /import \{ runHonestyEvals, SHOULD_ANSWER, SHOULD_REFUSE \} from "\.\/honesty-evals\.js"/);
  assert.match(worker, /policy: "Site Rep answers only from your approved sources and asks for follow-up when source backing is missing\."/);
  assert.match(worker, /guarantee: "Site Rep answers only from your approved sources and asks for follow-up when source backing is missing\."/);

  assert.match(worker, /"\/honesty": \{/);
  assert.match(worker, /<a href="\/honesty">Honesty check<\/a>/);

  assert.match(sitemap, /https:\/\/siterep\.net\/honesty/);
  assert.match(llms, /\/api\/public\/honesty-check/);
});

test("honesty-check payload never overstates: counts come from the evals, not a literal", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const fn = worker.slice(worker.indexOf("function publicHonestyCheckResponse"), worker.indexOf("\n}", worker.indexOf("function publicHonestyCheckResponse")));
  assert.match(fn, /allPass =\s*\n?\s*evals\.shouldAnswer\.passed === evals\.shouldAnswer\.total/);
  assert.match(fn, /passed: evals\.shouldAnswer\.passed/);
  assert.match(fn, /passed: evals\.shouldRefuse\.passed/);
  assert.match(fn, /pricingAccuracy: \{[\s\S]*?total: evals\.pricingAccuracy\.total/);
  assert.match(fn, /pricingSkipped \|\| evals\.pricingAccuracy\.passed === evals\.pricingAccuracy\.total/);
  assert.doesNotMatch(fn, /allPass: true/);
});

test("honesty page renders live eval pass counts, not literals, and links the machine-readable check", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));

  assert.match(worker, /function renderHonestyMarkdown\([\s\S]*?evals = runHonestyEvals\(answerFromSources, publicDemoSources\(\)\)[\s\S]*?pricingEvals = \{ total: 0, passed: 0, skipped: true \}/);

  assert.match(worker, /"\/honesty": \{[\s\S]*?markdown: renderHonestyMarkdown,/);
  assert.match(renderFn, /\$\{evals\.shouldAnswer\.passed\} of \$\{evals\.shouldAnswer\.total\}/);
  assert.match(renderFn, /\$\{evals\.shouldRefuse\.passed\} of \$\{evals\.shouldRefuse\.total\}/);

  assert.match(worker, /async function honestyTrustPageFor\(url, env, request\)/);
  assert.match(worker, /const honestyPage = await honestyTrustPageFor\(url, env, request\)/);
  const honestyFetch = worker.slice(worker.indexOf("async function honestyTrustPageFor"), worker.indexOf("\nfunction trustPageFor"));
  assert.match(honestyFetch, /await publicPricingCatalog\(env, request\)/);
  assert.match(honestyFetch, /runHonestyEvals\(answerFromSources, publicDemoSources\(\), liveCatalog\)/);
  assert.match(honestyFetch, /renderHonestyMarkdown\(evals, evals\.pricingAccuracy\)/);
  assert.match(honestyFetch, /pathname !== "\/honesty"/);
  assert.ok(
    worker.indexOf("await honestyTrustPageFor(url, env, request)") < worker.indexOf("const trustPage = trustPageFor(url)"),
    "honesty HTML must be served before the no-catalog trustPageFor fallback",
  );

  assert.match(worker, /markdown: typeof page\.markdown === "function" \? page\.markdown\(\) : page\.markdown/);

  assert.doesNotMatch(renderFn, /12 of 12|12\/12|7 of 7|7\/7/);

  assert.match(renderFn, /machine-readable \[check result\]\(\/api\/public\/honesty-check\)/);
  assert.match(worker, /api\\\/public\\\/honesty-check\|/);
});

test("the page's pass counts equal the shared evals' current report on the real demo sources", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));

  const { renderHonestyMarkdown } = new Function(
    `"use strict";\n${renderFn}\nreturn { renderHonestyMarkdown };`,
  )();

  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  const markdown = renderHonestyMarkdown(evals);

  assert.match(
    markdown,
    new RegExp(`${evals.shouldAnswer.passed} of ${evals.shouldAnswer.total} should-answer questions passed`),
    "page must show the live should-answer count from the shared evals",
  );
  assert.match(
    markdown,
    new RegExp(`${evals.shouldRefuse.passed} of ${evals.shouldRefuse.total} should-hand-off questions passed`),
    "page must show the live should-hand-off count from the shared evals",
  );
  assert.doesNotMatch(markdown, /pricing answers match the live checkout/);
  assert.match(markdown, /It is not a marketing number/);
  assert.match(markdown, /\/api\/public\/honesty-check/);
});

test("honesty page counts are derived from eval results, not literals", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));
  const { renderHonestyMarkdown } = new Function(
    `"use strict";\n${renderFn}\nreturn { renderHonestyMarkdown };`,
  )();

  const synthetic = { shouldAnswer: { passed: 1, total: 9 }, shouldRefuse: { passed: 2, total: 8 } };
  const markdown = renderHonestyMarkdown(synthetic);
  assert.match(markdown, /1 of 9 should-answer questions passed/);
  assert.match(markdown, /2 of 8 should-hand-off questions passed/);
  assert.doesNotMatch(markdown, /12 of 12|12\/12|7 of 7|7\/7/, "page text must never carry hardcoded pass counts");
});

test("honesty page trust and check-result links carry human labels, never raw paths", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));
  const { renderHonestyMarkdown } = new Function(
    `"use strict";\n${renderFn}\nreturn { renderHonestyMarkdown };`,
  )();

  const escapeHtmlFn = worker.slice(worker.indexOf("function escapeHtml"), worker.indexOf("\nfunction withVaryAccept"));
  const renderInlineHtmlFn = worker.slice(worker.indexOf("function renderInlineHtml"), worker.indexOf("\nfunction jsonLdScript"));
  const markdownBodyToHtmlFn = worker.slice(worker.indexOf("function markdownBodyToHtml"), worker.indexOf("\nfunction renderInlineHtml"));
  const { markdownBodyToHtml } = new Function(`"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\nreturn { markdownBodyToHtml };`)();

  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  const html = markdownBodyToHtml(renderHonestyMarkdown(evals));

  assert.match(html, /<a href="\/api\/public\/honesty-check">check result<\/a>/, "the check-result entry must render with a human label");
  assert.match(html, /<a href="\/api\/public\/honesty-check">Live check results<\/a>/, "the useful-links check entry must render with a human label");
  assert.match(html, /<a href="\/trust">Trust and data handling<\/a>/, "the trust entry must render with a human label");
  assert.match(html, /<a href="\/#demo">Live demo<\/a>/, "the demo entry must render with a human label");
  assert.match(html, /<a href="\/#public-pricing">Start free with 50 source-backed answers, no card<\/a>/, "the free-start entry must render with a human label");
  assert.doesNotMatch(html, /<a href="\/api\/public\/honesty-check">\/api\/public\/honesty-check<\/a>/, "the check link text must never be the raw URL");
  assert.doesNotMatch(html, /<a href="\/trust">\/trust<\/a>/, "the trust link text must never be the raw path");
  assert.doesNotMatch(html, /<a href="\/#demo">\/#demo<\/a>/, "the demo link text must never be the raw path");
  assert.doesNotMatch(html, /<a href="\/#public-pricing">\/#public-pricing<\/a>/, "the free-start link text must never be the raw path");
});

test("runPricingAccuracyEval reports skipped when the catalog is missing or not ok", () => {
  const skippedNull = runPricingAccuracyEval(null);
  assert.equal(skippedNull.skipped, true);
  assert.equal(skippedNull.total, 0);
  assert.equal(skippedNull.passed, 0);

  const skippedFalse = runPricingAccuracyEval({ ok: false, plans: [] });
  assert.equal(skippedFalse.skipped, true);

  const skippedNoLive = runPricingAccuracyEval({ ok: true, plans: [] });
  assert.equal(skippedNoLive.skipped, true);

  const skippedStatic = runPricingAccuracyEval({
    ok: true,
    plans: [{ name: "Starter", source: "razorpay-env", displayPrice: "€9.25" }],
  });
  assert.equal(skippedStatic.skipped, true);
});

test("runPricingAccuracyEval passes when the live catalog resolves every named plan", () => {
  const result = runPricingAccuracyEval(LIVE_PRICING_CATALOG);
  assert.equal(result.skipped, false);
  assert.equal(result.total, PRICING_QUESTIONS.length);
  assert.equal(result.passed, PRICING_QUESTIONS.length);
  assert.equal(result.failedQuestions.length, 0);
  assert.equal(result.livePlanCount, 4);
});

test("runHonestyEvals stays backward-compatible: no catalog => pricing dimension skipped", () => {
  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  assert.equal(evals.pricingAccuracy.skipped, true);
  assert.equal(evals.pricingAccuracy.total, 0);
  assert.equal(evals.pricingAccuracy.passed, 0);
  assert.ok(evals.shouldAnswer.total > 0);
  assert.ok(evals.shouldRefuse.total > 0);
});

test("runHonestyEvals wires pricing accuracy when a live catalog is provided", () => {
  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES, LIVE_PRICING_CATALOG);
  assert.equal(evals.pricingAccuracy.skipped, false);
  assert.equal(evals.pricingAccuracy.passed, evals.pricingAccuracy.total);
});

test("honesty page renders pricing-accuracy count and market evidence when catalog is live", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));
  const { renderHonestyMarkdown } = new Function(
    `"use strict";\n${renderFn}\nreturn { renderHonestyMarkdown };`,
  )();

  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES, LIVE_PRICING_CATALOG);
  const pricingEvals = evals.pricingAccuracy;
  const markdown = renderHonestyMarkdown(evals, pricingEvals);

  assert.match(
    markdown,
    new RegExp(`${pricingEvals.passed} of ${pricingEvals.total} pricing answers match the live checkout`),
    "page must show the pricing-accuracy pass count when the catalog is live",
  );
  assert.match(markdown, /## Pricing accuracy/, "page must render the pricing-accuracy section when not skipped");
  assert.match(markdown, /54\.5%/);
  assert.match(markdown, /Automate to Profit, August 2026/);
  assert.match(markdown, /live Dodo checkout preview/);
});

test("honesty page omits pricing mention when the pricing dimension is skipped", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));
  const { renderHonestyMarkdown } = new Function(
    `"use strict";\n${renderFn}\nreturn { renderHonestyMarkdown };`,
  )();

  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  const markdown = renderHonestyMarkdown(evals, { total: 0, passed: 0, skipped: true });

  assert.doesNotMatch(markdown, /pricing answers match the live checkout/, "page must not mention pricing when skipped");
  assert.doesNotMatch(markdown, /## Pricing accuracy/, "page must not render the pricing section when skipped");
  assert.doesNotMatch(markdown, /54\.5%/, "page must not cite the market evidence when skipped");
});

test("/api/public/honesty-check response always includes the pricingAccuracy field", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const fn = worker.slice(worker.indexOf("function publicHonestyCheckResponse"), worker.indexOf("\n}", worker.indexOf("function publicHonestyCheckResponse")));
  assert.match(fn, /pricingAccuracy: \{[\s\S]*?total: evals\.pricingAccuracy\.total,[\s\S]*?passed: evals\.pricingAccuracy\.passed,[\s\S]*?skipped: evals\.pricingAccuracy\.skipped/);
  assert.match(fn, /try \{[\s\S]*?pricingCatalog = await publicPricingCatalog\(env, request\)[\s\S]*?\} catch \{[\s\S]*?pricingCatalog = null/);
});

test("citationUrlSupportsAnswer passes when the cited URL has no homepage fragment (standalone pages are out of scope)", () => {
  assert.equal(citationUrlSupportsAnswer({ url: "https://siterep.net/terms", content: "cancel refund subscription billing" }), true);
  assert.equal(citationUrlSupportsAnswer({ url: "https://siterep.net/docs/install", content: "paste snippet script wordpress" }), true);
});

test("citationUrlSupportsAnswer passes when the cited section contains the answer's key nouns", () => {
  const planFeatures = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-plan-features");
  assert.equal(citationUrlSupportsAnswer(planFeatures), true);
});

test("citationUrlSupportsAnswer fails when the cited section lacks the answer's key nouns", () => {
  const cancelRefund = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-cancel-refund");
  const wrongUrl = { ...cancelRefund, url: "https://siterep.net/#invitation" };
  assert.equal(citationUrlSupportsAnswer(wrongUrl), false);
});

test("citationUrlSupportsAnswer fails closed when the fragment is unknown", () => {
  const cancelRefund = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-cancel-refund");
  const unknownFragment = { ...cancelRefund, url: "https://siterep.net/#no-such-section" };
  assert.equal(citationUrlSupportsAnswer(unknownFragment), false);
});

test("starter-plan honesty citation uses the live #public-pricing source", () => {
  const result = applyLiveDemoPricingAnswer(
    "how much is the starter plan",
    answerFromSources("how much is the starter plan", DEMO_SOURCES),
    LIVE_PRICING_CATALOG,
  );
  assert.equal(result.unknown, false);
  assert.equal(result.sources[0].id, "demo-starter-pricing");
  assert.match(result.sources[0].url, /#public-pricing$/);
  assert.equal(citationUrlSupportsAnswer(result.sources[0]), true);
  assert.match(result.answer, /€9\.25/);
});

test("buy-next honesty citation points at #how-it-works and backs the answer", () => {
  const result = answerFromSources("I want to buy this for my bakery website, what do I do next?", DEMO_SOURCES);
  assert.equal(result.unknown, false);
  assert.equal(result.sources[0].id, "demo-buy-next");
  assert.match(result.sources[0].url, /#how-it-works$/);
  assert.equal(citationUrlSupportsAnswer(result.sources[0]), true);
});

test("runHonestyEvals citations all pass against the live demo sources", () => {
  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES, LIVE_PRICING_CATALOG);
  assert.equal(evals.citations.total, 11);
  assert.equal(evals.citations.passed, evals.citations.total, "every citation must be backed by its URL");
  assert.deepEqual(evals.citations.misCited, []);
});

test("runHonestyEvals citation count drops when a cited source's URL lacks the answer text", () => {
  const baseline = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  assert.equal(baseline.citations.total, 11);
  assert.equal(baseline.citations.passed, baseline.citations.total, "baseline citations must all pass");

  const tampered = DEMO_SOURCES.map((source) =>
    source.id === "demo-cancel-refund" ? { ...source, url: "https://siterep.net/#invitation" } : source,
  );
  const result = runHonestyEvals(answerFromSources, tampered);
  assert.ok(result.citations.passed < result.citations.total, "passed must drop below total after the wrong-URL injection");
  assert.ok(result.citations.passed < baseline.citations.passed, "passed must drop below the baseline after the injection");
  assert.ok(result.citations.misCited.includes("ok how do i cancel if i dont like it"), "the cancel citation must be flagged as mis-cited");
});

test("honesty-check workflow runs the live check file from a live scheduled step", async () => {
  const workflow = await readFile(new URL("../.github/workflows/honesty-check.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:\n\s+- cron:/, "honesty-check.yml must keep its schedule trigger");
  assert.match(
    workflow,
    /run: \|\n\s+set -euo pipefail\n\s+node --test tests\/honesty-live\.check\.js/,
    "a live run step must invoke tests/honesty-live.check.js",
  );
});

test("the honesty live check file exists", async () => {
  await assert.doesNotReject(
    access(new URL("./honesty-live.check.js", import.meta.url)),
    "tests/honesty-live.check.js is missing",
  );
});

test("pricing-stamp-freshness workflow runs the stamp check from a live scheduled step", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pricing-stamp-freshness.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:\n\s+- cron:/, "pricing-stamp-freshness.yml must keep its schedule trigger");
  assert.match(
    workflow,
    /run: \|\n\s+set -euo pipefail\n\s+node --test tests\/pricing-stamp-freshness\.check\.js/,
    "a live run step must set pipefail and invoke tests/pricing-stamp-freshness.check.js",
  );
  assert.match(
    workflow,
    /continue-on-error: true/,
    "the check step must keep continue-on-error so the failure opens an issue instead of a red job",
  );
  assert.match(
    workflow,
    /if: steps\.check\.outcome == 'failure'/,
    "the follow-up steps must gate on outcome, not conclusion (continue-on-error reports success)",
  );
});

test("the pricing stamp freshness check file exists", async () => {
  await assert.doesNotReject(
    access(new URL("./pricing-stamp-freshness.check.js", import.meta.url)),
    "tests/pricing-stamp-freshness.check.js is missing",
  );
});
