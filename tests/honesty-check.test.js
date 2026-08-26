import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { answerFromSources } from "../server/search.js";
import { PUBLIC_DEMO_SOURCES } from "../worker/demo-sources.js";
import { runHonestyEvals, runPricingAccuracyEval, PRICING_QUESTIONS, citationUrlSupportsAnswer } from "../worker/honesty-evals.js";

// The demo source shape the Worker's publicDemoSources() feeds the evals with:
// retrieval only reads content/excerpt/title/url/id, so this mirrors it (same
// mapping as tests/demo-refusal-evals.test.js).
const DEMO_SOURCES = PUBLIC_DEMO_SOURCES.map((source) => ({
  ...source,
  excerpt: source.content.slice(0, 240),
  indexedAt: "2026-05-30T00:00:00.000Z",
}));

// A catalog shape that mirrors `publicPricingCatalog`'s success payload with
// every named plan resolved via the live Dodo checkout preview. Used to drive
// the pricing-accuracy eval through its non-skipped path in tests.
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

  // Endpoint: routed top-level (before the coordinator), runs the SHARED evals
  // against the live demo sources — not a hardcoded marketing number.
  assert.match(worker, /url\.pathname === "\/api\/public\/honesty-check"/);
  assert.match(worker, /function publicHonestyCheckResponse/);
  assert.match(worker, /runHonestyEvals\(answerFromSources, publicDemoSources\(\), pricingCatalog\)/);
  assert.match(worker, /import \{ runHonestyEvals, SHOULD_ANSWER, SHOULD_REFUSE \} from "\.\/honesty-evals\.js"/);
  assert.match(worker, /policy: "Site Rep answers only from your approved sources and asks for follow-up when source backing is missing\."/);
  assert.match(worker, /guarantee: "Site Rep answers only from your approved sources and asks for follow-up when source backing is missing\."/);

  // Page registered and cross-linked.
  assert.match(worker, /"\/honesty": \{/);
  assert.match(worker, /<a href="\/honesty">Honesty check<\/a>/);

  // Discovery surfaces.
  assert.match(sitemap, /https:\/\/siterep\.net\/honesty/);
  assert.match(llms, /\/api\/public\/honesty-check/);
});

test("honesty-check payload never overstates: counts come from the evals, not a literal", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const fn = worker.slice(worker.indexOf("function publicHonestyCheckResponse"), worker.indexOf("\n}", worker.indexOf("function publicHonestyCheckResponse")));
  // allPass is derived from the eval result, and passed counts come from evals.
  assert.match(fn, /allPass =\s*\n?\s*evals\.shouldAnswer\.passed === evals\.shouldAnswer\.total/);
  assert.match(fn, /passed: evals\.shouldAnswer\.passed/);
  assert.match(fn, /passed: evals\.shouldRefuse\.passed/);
  // Pricing-accuracy dimension is reported and gates allPass when present.
  assert.match(fn, /pricingAccuracy: \{[\s\S]*?total: evals\.pricingAccuracy\.total/);
  assert.match(fn, /pricingSkipped \|\| evals\.pricingAccuracy\.passed === evals\.pricingAccuracy\.total/);
  // No hardcoded "all pass" / fake totals.
  assert.doesNotMatch(fn, /allPass: true/);
});

test("honesty page renders live eval pass counts, not literals, and links the machine-readable check", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));

  // The page counts come from the SAME shared evals and demo sources the API
  // endpoint runs — not a second, hand-rolled calculation and not literals.
  assert.match(worker, /function renderHonestyMarkdown\([\s\S]*?evals = runHonestyEvals\(answerFromSources, publicDemoSources\(\)\)[\s\S]*?pricingEvals = \{ total: 0, passed: 0, skipped: true \}/);

  // The /honesty trust page is served through the renderer, and the renderer
  // interpolates the eval result fields for both counts.
  assert.match(worker, /"\/honesty": \{[\s\S]*?markdown: renderHonestyMarkdown,/);
  assert.match(renderFn, /\$\{evals\.shouldAnswer\.passed\} of \$\{evals\.shouldAnswer\.total\}/);
  assert.match(renderFn, /\$\{evals\.shouldRefuse\.passed\} of \$\{evals\.shouldRefuse\.total\}/);

  // The /honesty HTML fetch path must pass the live checkout catalog into the
  // renderer (same catalog the JSON check uses). Calling renderHonestyMarkdown
  // with no args defaults pricingEvals to skipped and omits the third count.
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

  // Other trust pages still render per request through trustPageFor.
  assert.match(worker, /markdown: typeof page\.markdown === "function" \? page\.markdown\(\) : page\.markdown/);

  // No hardcoded current counts anywhere in the page copy.
  assert.doesNotMatch(renderFn, /12 of 12|12\/12|7 of 7|7\/7/);

  // The page links the machine-readable check, and the trust-page HTML
  // renderer auto-links that path so the link is clickable on the live page.
  assert.match(renderFn, /machine-readable \[check result\]\(\/api\/public\/honesty-check\)/);
  assert.match(worker, /api\\\/public\\\/honesty-check\|/);
});

test("the page's pass counts equal the shared evals' current report on the real demo sources", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));

  // Run the Worker's own renderer (extracted verbatim) over the exact eval run
  // the endpoint performs: same shared function, same demo sources.
  const { renderHonestyMarkdown } = new Function(
    `"use strict";\n${renderFn}\nreturn { renderHonestyMarkdown };`,
  )();

  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  // Pricing is omitted from the default render (no catalog -> skipped).
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
  // Default (skipped) render omits pricing mention.
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

  // Feed the page renderer an eval result that is NOT all-pass: the rendered
  // copy must track the eval object exactly, proving the numbers are derived
  // rather than baked-in marketing figures.
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

  // Run the page through the Worker's own markdown -> HTML pipeline (the exact
  // functions that serve the trust pages) so the assertions hold against
  // emitted HTML, not the raw markdown source.
  const escapeHtmlFn = worker.slice(worker.indexOf("function escapeHtml"), worker.indexOf("\nfunction withVaryAccept"));
  const renderInlineHtmlFn = worker.slice(worker.indexOf("function renderInlineHtml"), worker.indexOf("\nfunction jsonLdScript"));
  const markdownBodyToHtmlFn = worker.slice(worker.indexOf("function markdownBodyToHtml"), worker.indexOf("\nfunction renderInlineHtml"));
  const { markdownBodyToHtml } = new Function(`"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\nreturn { markdownBodyToHtml };`)();

  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  const html = markdownBodyToHtml(renderHonestyMarkdown(evals));

  // The machine-readable check and trust page entries carry human labels while
  // keeping the full href — the raw developer path is never the visible text.
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

// --- Pricing-accuracy dimension ------------------------------------------------

test("runPricingAccuracyEval reports skipped when the catalog is missing or not ok", () => {
  const skippedNull = runPricingAccuracyEval(null);
  assert.equal(skippedNull.skipped, true);
  assert.equal(skippedNull.total, 0);
  assert.equal(skippedNull.passed, 0);

  const skippedFalse = runPricingAccuracyEval({ ok: false, plans: [] });
  assert.equal(skippedFalse.skipped, true);

  const skippedNoLive = runPricingAccuracyEval({ ok: true, plans: [] });
  assert.equal(skippedNoLive.skipped, true);

  // Also: catalog ok but only razorpay-env plans (not live checkout) -> skipped.
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
  // Existing dimensions unchanged.
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

  // Live sentence carries the third count.
  assert.match(
    markdown,
    new RegExp(`${pricingEvals.passed} of ${pricingEvals.total} pricing answers match the live checkout`),
    "page must show the pricing-accuracy pass count when the catalog is live",
  );
  // Pricing-accuracy section with market evidence is present and sourced.
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
  // Explicitly pass a skipped pricing evals object — same shape the
  // endpoint emits when the catalog fetch fails.
  const markdown = renderHonestyMarkdown(evals, { total: 0, passed: 0, skipped: true });

  assert.doesNotMatch(markdown, /pricing answers match the live checkout/, "page must not mention pricing when skipped");
  assert.doesNotMatch(markdown, /## Pricing accuracy/, "page must not render the pricing section when skipped");
  assert.doesNotMatch(markdown, /54\.5%/, "page must not cite the market evidence when skipped");
});

test("/api/public/honesty-check response always includes the pricingAccuracy field", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const fn = worker.slice(worker.indexOf("function publicHonestyCheckResponse"), worker.indexOf("\n}", worker.indexOf("function publicHonestyCheckResponse")));
  assert.match(fn, /pricingAccuracy: \{[\s\S]*?total: evals\.pricingAccuracy\.total,[\s\S]*?passed: evals\.pricingAccuracy\.passed,[\s\S]*?skipped: evals\.pricingAccuracy\.skipped/);
  // The catalog fetch is wrapped so a checkout outage never breaks the endpoint.
  assert.match(fn, /try \{[\s\S]*?pricingCatalog = await publicPricingCatalog\(env, request\)[\s\S]*?\} catch \{[\s\S]*?pricingCatalog = null/);
});

// --- Citation URL backing dimension --------------------------------------------
// The citation dimension must drop (passed < total) when a cited source's URL
// points at a homepage section whose rendered text does not contain the
// answer's key nouns. This is the detector that makes wrong-page citations
// (#61 free-trial->#invitation, #65 lead-capture->#how-it-works,
// #67 starter-price->#invitation) report as failed instead of passed.

test("citationUrlSupportsAnswer passes when the cited URL has no homepage fragment (standalone pages are out of scope)", () => {
  // /terms and /docs/install are standalone pages, not homepage sections — the
  // detector does not verify their rendered text, so they pass on id alone.
  assert.equal(citationUrlSupportsAnswer({ url: "https://siterep.net/terms", content: "cancel refund subscription billing" }), true);
  assert.equal(citationUrlSupportsAnswer({ url: "https://siterep.net/docs/install", content: "paste snippet script wordpress" }), true);
});

test("citationUrlSupportsAnswer passes when the cited section contains the answer's key nouns", () => {
  // demo-plan-features cites #public-pricing, whose rendered text contains the
  // plan names and feature nouns the answer recites.
  const planFeatures = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-plan-features");
  assert.equal(citationUrlSupportsAnswer(planFeatures), true);
});

test("citationUrlSupportsAnswer fails when the cited section lacks the answer's key nouns", () => {
  // Point the cancellation source at #invitation (the start form). The start
  // form's rendered text contains none of the cancel/refund/subscription/
  // billing nouns the answer recites, so the citation is not backed.
  const cancelRefund = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-cancel-refund");
  const wrongUrl = { ...cancelRefund, url: "https://siterep.net/#invitation" };
  assert.equal(citationUrlSupportsAnswer(wrongUrl), false);
});

test("citationUrlSupportsAnswer fails closed when the fragment is unknown", () => {
  // A fragment that does not map to a known homepage section cannot be
  // verified, so the citation fails rather than silently passing.
  const cancelRefund = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-cancel-refund");
  const unknownFragment = { ...cancelRefund, url: "https://siterep.net/#no-such-section" };
  assert.equal(citationUrlSupportsAnswer(unknownFragment), false);
});

test("runHonestyEvals citation count drops when a cited source's URL lacks the answer text", () => {
  // Baseline: the real demo sources already report passed < total because two
  // citations point demo-get-started at #invitation, which lacks the
  // checkout/pricing/setup nouns the answer recites.
  const baseline = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  assert.ok(baseline.citations.passed < baseline.citations.total, "baseline citations must already drop below total");
  assert.equal(baseline.citations.total, 9);
  assert.equal(baseline.citations.passed, 7);

  // Inject a wrong URL into demo-cancel-refund (point it at #invitation). The
  // cancellation answer's key nouns are not on the start form, so that
  // citation now also fails and the passed count drops further.
  const tampered = DEMO_SOURCES.map((source) =>
    source.id === "demo-cancel-refund" ? { ...source, url: "https://siterep.net/#invitation" } : source,
  );
  const result = runHonestyEvals(answerFromSources, tampered);
  assert.ok(result.citations.passed < result.citations.total, "passed must drop below total after the wrong-URL injection");
  assert.ok(result.citations.passed < baseline.citations.passed, "passed must drop below the baseline after the injection");
  assert.ok(result.citations.misCited.includes("ok how do i cancel if i dont like it"), "the cancel citation must be flagged as mis-cited");
});
