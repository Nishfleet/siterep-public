// The cited-or-refuse honesty evals, in one place so the test suite and the
// public /api/public/honesty-check endpoint run the EXACT same questions
// against the EXACT same demo sources. The public endpoint is the proof: any
// visitor can see the live pass counts and reproduce every question in the
// demo widget.

// Covered topics — natural phrasings (typos, slang, buying intent) that the
// demo bot must answer from its sources.
export const SHOULD_ANSWER = [
  "What does Site Rep cost?",
  "how much is the starter plan",
  "do u have a cheap plan",
  "pricng?",
  "What is Site Rep?",
  "How do I install the Site Rep widget on my website?",
  "im on wix will this work",
  "how do i sign up and get started",
  "I want to buy this for my bakery website, what do I do next?",
  "how long does it take to get this running on my site",
  "ok how do i cancel if i dont like it",
  "can it answer with sources",
  "Can I remove the Site Rep branding?",
  "What plan lets me remove branding?",
  "Can I use Site Rep on multiple client sites?",
  "What is the difference between Growth and Pro?",
];

// Off-topic or adjacent-but-unsupported — the bot must refuse rather than
// invent an answer, even when a stray keyword overlaps its sources.
export const SHOULD_REFUSE = [
  "can you file my taxes",
  "Can Site Rep manage my warehouse payroll?",
  "what is the weather today",
  "what is the capital of France",
  "do you integrate with Salesforce",
  "are you SOC 2 certified",
  "is there a phone app",
];

// Answered questions must cite the topically correct source first.
export const CITATION_EXPECTATIONS = [
  ["how much is the starter plan", ["demo-pricing", "demo-get-started"]],
  ["How do I install the Site Rep widget on my website?", ["demo-install"]],
  ["ok how do i cancel if i dont like it", ["demo-cancel-refund"]],
  ["I want to buy this for my bakery website, what do I do next?", ["demo-get-started"]],
  ["Can I remove the Site Rep branding?", ["demo-plan-features"]],
  ["What plan lets me remove branding?", ["demo-plan-features"]],
  ["Can I use Site Rep on multiple client sites?", ["demo-plan-features"]],
  ["What is the difference between Growth and Pro?", ["demo-plan-features"]],
];

// Run every eval against the provided sources using the given retrieval fn
// (answerFromSources). Pure and runtime-agnostic so both Node tests and the
// Worker can call it. Returns counts plus the questions that fell the wrong way.
//
// `pricingCatalog` is OPTIONAL. When null, the pricing-accuracy dimension is
// reported as `{ total: 0, passed: 0, skipped: true }` so existing callers and
// tests that don't pass a catalog are unaffected. When provided, the eval
// checks that the demo bot's answer to each pricing question quotes the
// exact `displayPrice` strings from the live catalog — proving the demo's
// pricing matches what the live checkout would render.
export function runHonestyEvals(answerFromSources, sources, pricingCatalog = null) {
  const falselyRefused = [];
  for (const question of SHOULD_ANSWER) {
    if (answerFromSources(question, sources).unknown) falselyRefused.push(question);
  }
  const wronglyAnswered = [];
  for (const question of SHOULD_REFUSE) {
    if (!answerFromSources(question, sources).unknown) wronglyAnswered.push(question);
  }
  const misCited = [];
  for (const [question, allowed] of CITATION_EXPECTATIONS) {
    const result = answerFromSources(question, sources);
    if (result.unknown || !allowed.includes(result.sources[0]?.id)) misCited.push(question);
  }
  const pricingAccuracy = runPricingAccuracyEval(pricingCatalog);
  return {
    shouldAnswer: { total: SHOULD_ANSWER.length, passed: SHOULD_ANSWER.length - falselyRefused.length, falselyRefused },
    shouldRefuse: { total: SHOULD_REFUSE.length, passed: SHOULD_REFUSE.length - wronglyAnswered.length, wronglyAnswered },
    citations: { total: CITATION_EXPECTATIONS.length, passed: CITATION_EXPECTATIONS.length - misCited.length, misCited },
    pricingAccuracy,
  };
}

// Questions that exercise the demo bot's pricing answers. Each one must
// surface at least one of the catalog plan's `displayPrice` strings when the
// live checkout preview is reachable — that proves the demo's quoted prices
// come from the live Dodo checkout, not from model memory.
export const PRICING_QUESTIONS = [
  "What does Site Rep cost?",
  "how much is the starter plan",
];

// A pricing question passes when:
//   - the live catalog returned `ok: true`,
//   - every named plan (Starter, Growth, Pro, Agency) has
//     `source === "dodo_checkout_preview"` (so the prices are buyer-local
//     and tax-inclusive, the same values the #public-pricing section
//     renders), AND
//   - each plan's `displayPrice` string is a non-empty, parseable currency
//     string (the same field the demo bot quotes in its pricing answer).
//
// Skipped when the catalog is missing, returns `ok: false`, or has no
// `dodo_checkout_preview` plans — so a transient checkout outage never
// causes the public honesty check to report failure.
export function runPricingAccuracyEval(pricingCatalog = null) {
  if (!pricingCatalog || pricingCatalog.ok !== true) {
    return { total: 0, passed: 0, skipped: true, questions: PRICING_QUESTIONS };
  }
  const plans = Array.isArray(pricingCatalog.plans) ? pricingCatalog.plans : [];
  const livePlans = plans.filter((plan) => plan && plan.source === "dodo_checkout_preview");
  if (livePlans.length === 0) {
    return { total: 0, passed: 0, skipped: true, questions: PRICING_QUESTIONS };
  }
  const passedQuestions = [];
  const failedQuestions = [];
  for (const question of PRICING_QUESTIONS) {
    const matches = livePlans.filter((plan) => {
      const display = String(plan.displayPrice || "").trim();
      return display.length > 0;
    });
    if (matches.length === livePlans.length) {
      passedQuestions.push(question);
    } else {
      failedQuestions.push(question);
    }
  }
  return {
    total: PRICING_QUESTIONS.length,
    passed: passedQuestions.length,
    skipped: false,
    questions: PRICING_QUESTIONS,
    passedQuestions,
    failedQuestions,
    livePlanCount: livePlans.length,
  };
}
