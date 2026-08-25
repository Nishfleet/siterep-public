import assert from "node:assert/strict";
import { test } from "node:test";

import { answerFromSources, publicSource } from "../server/search.js";
import {
  PUBLIC_DEMO_SOURCES,
  isNamedStarterPriceQuestion,
  isPricingQuestion,
  planPricesAnswerFor,
  planPricingSource,
  starterPriceAnswerFor,
  starterPricingSource,
  isExactDemoPricingAnswer,
} from "../worker/demo-sources.js";
import { SHOULD_ANSWER, SHOULD_REFUSE, CITATION_EXPECTATIONS, runHonestyEvals } from "../worker/honesty-evals.js";

// Retrieval evals against the REAL public demo sources. The 2026-06-12 audit
// found ~47% of natural should-answer phrasings were falsely refused by an
// over-strict relevance gate (including "how much is the starter plan" and
// both buying-intent questions). These evals pin both directions: covered
// topics must answer, off-topic and adjacent-but-unsupported must refuse.
// The question sets are shared with the public /api/public/honesty-check
// endpoint so the live proof runs exactly what CI runs.

const DEMO_SOURCES = PUBLIC_DEMO_SOURCES.map((source) => ({
  ...source,
  excerpt: source.content.slice(0, 240),
  indexedAt: "2026-05-30T00:00:00.000Z",
}));

test("the shared honesty evals all pass against the real demo sources", () => {
  const result = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  assert.deepEqual(result.shouldAnswer.falselyRefused, [], "falsely refused covered topics");
  assert.deepEqual(result.shouldRefuse.wronglyAnswered, [], "wrongly answered unsupported questions");
  assert.deepEqual(result.citations.misCited, [], "mis-cited answered questions");
  assert.equal(result.shouldAnswer.passed, result.shouldAnswer.total);
  assert.equal(result.shouldRefuse.passed, result.shouldRefuse.total);
});

test("demo bot answers natural phrasings of every covered topic", () => {
  const failures = [];
  for (const question of SHOULD_ANSWER) {
    const result = answerFromSources(question, DEMO_SOURCES);
    if (result.unknown) failures.push(question);
  }
  assert.deepEqual(failures, [], `falsely refused: ${failures.join(" | ")}`);
});

test("demo bot refuses off-topic and adjacent-but-unsupported questions", () => {
  const failures = [];
  for (const question of SHOULD_REFUSE) {
    const result = answerFromSources(question, DEMO_SOURCES);
    if (!result.unknown) failures.push(`${question} -> [${result.sources[0]?.id}] ${result.answer.slice(0, 80)}`);
  }
  assert.deepEqual(failures, [], `wrongly answered: ${failures.join(" | ")}`);
});

test("answered questions cite the topically right source first", () => {
  const expectations = [
    ["how much is the starter plan", new Set(["demo-pricing", "demo-get-started"])],
    ["How do I install the Site Rep widget on my website?", new Set(["demo-install"])],
    ["ok how do i cancel if i dont like it", new Set(["demo-cancel-refund"])],
    ["I want to buy this for my bakery website, what do I do next?", new Set(["demo-get-started"])],
  ];
  for (const [question, allowed] of expectations) {
    const result = answerFromSources(question, DEMO_SOURCES);
    assert.equal(result.unknown, false, `refused: ${question}`);
    assert.ok(allowed.has(result.sources[0].id), `${question} cited ${result.sources[0].id}, expected one of ${[...allowed].join(", ")}`);
  }
});

test("plan-differentiator questions from the homepage are answered with a cited source", () => {
  const questions = [
    "Can I remove the Site Rep branding?",
    "What plan lets me remove branding?",
    "Can I use Site Rep on multiple client sites?",
    "What is the difference between Growth and Pro?",
  ];
  for (const question of questions) {
    const result = answerFromSources(question, DEMO_SOURCES);
    assert.equal(result.unknown, false, `refused: ${question}`);
    assert.ok(result.sources.length > 0, `${question} returned no sources`);
    assert.equal(result.sources[0].id, "demo-plan-features", `${question} cited ${result.sources[0]?.id}, expected demo-plan-features`);
  }
});

// Named-plan exact-price path: the live demo worker answers named Starter
// price-intent questions from a dedicated "Starter pricing" source built from
// the country-aware Dodo checkout preview amount the public pricing/checkout
// surface already renders. These tests pin that path (and the honest
// fallback) at the retrieval level with the real demo sources.

function demoSourcesWithStarterAnswer(answerText) {
  return [starterPricingSource(answerText), ...DEMO_SOURCES];
}

test("only named Starter price-intent questions trigger the exact-price path", () => {
  const shouldTrigger = [
    "What does Starter cost?",
    "what does starter cost per month",
    "how much is the starter plan",
    "how much does the starter plan cost",
    "what's the starter price",
    "starter pricing",
    "is starter worth it",
  ];
  const mustNotTrigger = [
    "What does Site Rep cost?",
    "what does the starter plan include",
    "can the starter plan handle 5,000 pages",
    "does the starter plan support wordpress",
    "how much is the growth plan",
    "can you file my taxes",
    "",
  ];
  for (const question of shouldTrigger) {
    assert.equal(isNamedStarterPriceQuestion(question), true, `should trigger: ${question}`);
  }
  for (const question of mustNotTrigger) {
    assert.equal(isNamedStarterPriceQuestion(question), false, `must not trigger: ${question}`);
  }
});

test("named Starter price questions return the live localized tax-inclusive amount", () => {
  // The exact shape publicPricingCatalog returns for a live Dodo checkout
  // preview — localized to the buyer and tax-inclusive. The amount below is a
  // fixture, not a hardcoded product price: the answer must echo exactly what
  // the pricing surface renders for the same request.
  const liveStarterPlan = {
    name: "Starter",
    currency: "USD",
    amountSubunits: 1200,
    displayPrice: "$12.00",
    source: "dodo_checkout_preview",
  };
  const answerText = starterPriceAnswerFor(liveStarterPlan);
  assert.match(answerText, /\$12\.00/);
  assert.match(answerText, /per month, tax included/);
  const sources = demoSourcesWithStarterAnswer(answerText);
  const failures = [];
  for (const question of ["What does Starter cost?", "how much is the starter plan", "what's the starter price", "how much does starter cost per month"]) {
    const result = answerFromSources(question, sources);
    if (result.unknown) {
      failures.push(`${question} -> refused`);
    } else if (!/\$12\.00/.test(result.answer)) {
      failures.push(`${question} -> [${result.answer.slice(0, 80)}]`);
    }
  }
  assert.deepEqual(failures, [], `exact-price path failed: ${failures.join(" | ")}`);
  const result = answerFromSources("What does Starter cost?", sources);
  assert.equal(result.sources[0].id, "demo-starter-pricing", "exact-price answer must cite the Starter pricing source");
  assert.match(result.sources[0].url, /siterep\.net\/#invitation/);
});

test("unavailable live price falls back honestly instead of inventing an amount", () => {
  // The static USD plan anchor (plan-fallback), static env amounts, and empty
  // plans are never the buyer's truth — all must produce the honest fallback.
  const fallbackAnswers = [
    starterPriceAnswerFor({ name: "Starter", source: "plan-fallback", currency: "USD", amountSubunits: 900, displayPrice: "$9.00" }),
    starterPriceAnswerFor({ name: "Starter", source: "razorpay-env", currency: "USD", amountSubunits: 900, displayPrice: "$9.00" }),
    starterPriceAnswerFor({ name: "Starter", source: "dodo-preview-unavailable" }),
    starterPriceAnswerFor({}),
  ];
  for (const answerText of fallbackAnswers) {
    assert.match(answerText, /hello@siterep\.net/, "fallback must keep the email path");
    assert.match(answerText, /checkout/i, "fallback must point at live checkout");
    assert.doesNotMatch(answerText, /[$€£₹]\s?\d|\d+\s?(?:\/|per)\s?month/i, "fallback must never state an amount");
  }
  const sources = demoSourcesWithStarterAnswer(starterPriceAnswerFor({}));
  const failures = [];
  for (const question of ["What does Starter cost?", "how much is the starter plan", "what's the starter price"]) {
    const result = answerFromSources(question, sources);
    if (result.unknown) {
      failures.push(`${question} -> refused`);
    } else if (/[$€£₹]\s?\d/.test(result.answer)) {
      failures.push(`${question} -> invented an amount: [${result.answer.slice(0, 80)}]`);
    } else if (!/hello@siterep\.net/.test(result.answer)) {
      failures.push(`${question} -> [${result.answer.slice(0, 80)}]`);
    }
  }
  assert.deepEqual(failures, [], `unavailable fallback failed: ${failures.join(" | ")}`);
  const result = answerFromSources("What does Starter cost?", sources);
  assert.equal(result.unknown, false);
  assert.match(result.answer, /hello@siterep\.net/);
  assert.match(result.answer, /checkout/i);
  assert.doesNotMatch(result.answer, /[$€£₹]\s?\d/);
  assert.equal(result.sources[0].id, "demo-starter-pricing");
});

test("static demo sources never hardcode a currency amount", () => {
  const pricingContent = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-pricing").content;
  assert.doesNotMatch(pricingContent, /[$€£₹]\s?\d|\d+\s?(?:\/|per)\s?month/i);
  // Every demo source stays free of stated currency amounts too.
  for (const source of PUBLIC_DEMO_SOURCES) {
    assert.doesNotMatch(source.content, /[$€£₹]\s?\d/, `${source.id} hardcodes a currency amount`);
  }
});

// Generic pricing questions ("What does it cost?") quote the four named-plan
// prices the live #public-pricing section renders on the same page. These
// tests pin the detection, the live-price answer, and the honest fallback at
// the retrieval level with the real demo sources.

function demoSourcesWithPlanPrices(answerText) {
  return [planPricingSource(answerText), ...DEMO_SOURCES];
}

test("only generic pricing questions trigger the four-plan-price path", () => {
  const shouldTrigger = [
    "What does it cost?",
    "What does Site Rep cost?",
    "how much does it cost",
    "how much is site rep",
    "do u have a cheap plan",
    "what's the price",
    "is it affordable",
  ];
  const mustNotTrigger = [
    "What does Starter cost?",
    "how much is the growth plan",
    "what does the starter plan include",
    "can the starter plan handle 5,000 pages",
    "is there a free trial",
    "how much is the free trial",
    "can you file my taxes",
    "what is the weather today",
    "",
  ];
  for (const question of shouldTrigger) {
    assert.equal(isPricingQuestion(question), true, `should trigger: ${question}`);
  }
  for (const question of mustNotTrigger) {
    assert.equal(isPricingQuestion(question), false, `must not trigger: ${question}`);
  }
});

test("generic pricing questions quote the four live named-plan prices", () => {
  // The exact shape publicPricingCatalog returns for live Dodo checkout
  // previews — localized to the buyer and tax-inclusive. The amounts below are
  // fixtures, not hardcoded product prices: the answer must echo exactly what
  // the #public-pricing surface renders for the same request.
  const livePlans = [
    { name: "Starter", currency: "EUR", amountSubunits: 925, displayPrice: "€9.25", source: "dodo_checkout_preview" },
    { name: "Growth", currency: "EUR", amountSubunits: 2980, displayPrice: "€29.80", source: "dodo_checkout_preview" },
    { name: "Pro", currency: "EUR", amountSubunits: 6064, displayPrice: "€60.64", source: "dodo_checkout_preview" },
    { name: "Agency", currency: "EUR", amountSubunits: 15313, displayPrice: "€153.13", source: "dodo_checkout_preview" },
  ];
  const answerText = planPricesAnswerFor(livePlans);
  assert.match(answerText, /Starter €9\.25/);
  assert.match(answerText, /Growth €29\.80/);
  assert.match(answerText, /Pro €60\.64/);
  assert.match(answerText, /Agency €153\.13/);
  assert.match(answerText, /per month, tax included/);
  const sources = demoSourcesWithPlanPrices(answerText);
  const failures = [];
  for (const question of ["What does it cost?", "how much does it cost", "do u have a cheap plan"]) {
    const result = answerFromSources(question, sources);
    if (result.unknown) {
      failures.push(`${question} -> refused`);
    } else if (!/€9\.25/.test(result.answer) || !/€153\.13/.test(result.answer)) {
      failures.push(`${question} -> [${result.answer.slice(0, 80)}]`);
    }
  }
  assert.deepEqual(failures, [], `four-plan-price path failed: ${failures.join(" | ")}`);
  const result = answerFromSources("What does it cost?", sources);
  assert.equal(result.sources[0].id, "demo-plan-pricing", "pricing answer must cite the Plan pricing source");
  assert.match(result.sources[0].url, /siterep\.net\/#public-pricing/);
});

test("unavailable live plan prices fall back honestly instead of inventing amounts", () => {
  // A single unset plan, the static USD plan anchor, or empty plans are never
  // the buyer's truth — all must produce the honest fallback.
  const fallbackAnswers = [
    planPricesAnswerFor([
      { name: "Starter", currency: "EUR", amountSubunits: 925, displayPrice: "€9.25", source: "dodo_checkout_preview" },
      { name: "Growth", currency: "EUR", amountSubunits: 2980, displayPrice: "€29.80", source: "dodo_checkout_preview" },
      { name: "Pro", currency: "EUR", amountSubunits: 6064, displayPrice: "€60.64", source: "dodo_checkout_preview" },
      { name: "Agency", currency: "", amountSubunits: 0, displayPrice: "Contact us", source: "dodo-preview-unavailable" },
    ]),
    planPricesAnswerFor([
      { name: "Starter", source: "plan-fallback", currency: "USD", amountSubunits: 900, displayPrice: "$9.00" },
      { name: "Growth", source: "plan-fallback", currency: "USD", amountSubunits: 2900, displayPrice: "$29.00" },
      { name: "Pro", source: "plan-fallback", currency: "USD", amountSubunits: 5900, displayPrice: "$59.00" },
      { name: "Agency", source: "plan-fallback", currency: "USD", amountSubunits: 14900, displayPrice: "$149.00" },
    ]),
    planPricesAnswerFor([]),
    planPricesAnswerFor(),
  ];
  for (const answerText of fallbackAnswers) {
    assert.match(answerText, /hello@siterep\.net/, "fallback must keep the email path");
    assert.match(answerText, /checkout/i, "fallback must point at live checkout");
    assert.doesNotMatch(answerText, /[$€£₹]\s?\d|\d+\s?(?:\/|per)\s?month/i, "fallback must never state an amount");
  }
  const sources = demoSourcesWithPlanPrices(planPricesAnswerFor([]));
  const failures = [];
  for (const question of ["What does it cost?", "how much does it cost", "do u have a cheap plan"]) {
    const result = answerFromSources(question, sources);
    if (result.unknown) {
      failures.push(`${question} -> refused`);
    } else if (/[$€£₹]\s?\d/.test(result.answer)) {
      failures.push(`${question} -> invented an amount: [${result.answer.slice(0, 80)}]`);
    } else if (!/hello@siterep\.net/.test(result.answer)) {
      failures.push(`${question} -> [${result.answer.slice(0, 80)}]`);
    }
  }
  assert.deepEqual(failures, [], `unavailable fallback failed: ${failures.join(" | ")}`);
  const result = answerFromSources("What does it cost?", sources);
  assert.equal(result.unknown, false);
  assert.match(result.answer, /hello@siterep\.net/);
  assert.match(result.answer, /checkout/i);
  assert.doesNotMatch(result.answer, /[$€£₹]\s?\d/);
  assert.equal(result.sources[0].id, "demo-plan-pricing");
});

// The demo pricing answers are final copy: the compose step must never
// paraphrase them, because a warm rewrite drops the plan names the live quote
// guarantees. The guard keys on the dedicated pricing source the answer cites.

test("pricing answers built from the dedicated pricing sources are flagged exact", () => {
  const asAnswer = (source) => ({ sources: [publicSource(source)] });
  assert.equal(isExactDemoPricingAnswer(asAnswer(planPricingSource(planPricesAnswerFor([])))), true);
  assert.equal(isExactDemoPricingAnswer(asAnswer(starterPricingSource(starterPriceAnswerFor({})))), true);
  assert.equal(isExactDemoPricingAnswer(asAnswer(planPricingSource("x"))), true);
  assert.equal(isExactDemoPricingAnswer(asAnswer(starterPricingSource("x"))), true);
  // The dedicated source objects themselves are not answer shapes.
  assert.equal(isExactDemoPricingAnswer(planPricingSource("x")), false);
});

test("answers from any other source are not treated as exact demo pricing quotes", () => {
  const OTHER = { id: "demo-install", title: "Installing the widget", url: "https://siterep.net/#how-it-works", excerpt: "How do I install Site Rep?", content: "Question: How do I install Site Rep?\nAnswer: One script snippet." };
  assert.equal(isExactDemoPricingAnswer({}), false);
  assert.equal(isExactDemoPricingAnswer(null), false);
  assert.equal(isExactDemoPricingAnswer({ sources: [] }), false);
  assert.equal(isExactDemoPricingAnswer({ sources: [OTHER] }), false);
  assert.equal(isExactDemoPricingAnswer({ sources: [{ id: "demo-pricing" }] }), false);
});
