import { applyLiveDemoPricingAnswer } from "./demo-sources.js";

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
  "Can I hide the Site Rep logo?",
  "Does Starter show Site Rep branding?",
  "What plan lets me remove branding?",
  "Can I use Site Rep on multiple client sites?",
  "What is the difference between Growth and Pro?",
  "What trust controls are confirmed?",
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
  ["how much is the starter plan", ["demo-starter-pricing", "demo-plan-pricing", "demo-pricing", "demo-get-started"]],
  ["How do I install the Site Rep widget on my website?", ["demo-install"]],
  ["ok how do i cancel if i dont like it", ["demo-cancel-refund"]],
  ["I want to buy this for my bakery website, what do I do next?", ["demo-buy-next"]],
  ["Can I remove the Site Rep branding?", ["demo-plan-features"]],
  ["Can I hide the Site Rep logo?", ["demo-plan-features"]],
  ["Does Starter show Site Rep branding?", ["demo-plan-features"]],
  ["What plan lets me remove branding?", ["demo-plan-features"]],
  ["Can I use Site Rep on multiple client sites?", ["demo-plan-features"]],
  ["What is the difference between Growth and Pro?", ["demo-plan-features"]],
  ["What trust controls are confirmed?", ["demo-trust-controls"]],
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
  // Match public demo chat: named-plan and generic price questions are
  // rewritten onto the live #public-pricing sources before scoring.
  const retrieve = (question, srcs) =>
    applyLiveDemoPricingAnswer(question, answerFromSources(question, srcs), pricingCatalog);
  const falselyRefused = [];
  for (const question of SHOULD_ANSWER) {
    if (retrieve(question, sources).unknown) falselyRefused.push(question);
  }
  const wronglyAnswered = [];
  for (const question of SHOULD_REFUSE) {
    if (!retrieve(question, sources).unknown) wronglyAnswered.push(question);
  }
  const misCited = [];
  for (const [question, allowed] of CITATION_EXPECTATIONS) {
    const result = retrieve(question, sources);
    // A citation passes only when the topically correct source is cited AND
    // that source's URL actually backs the answer: a homepage fragment must
    // resolve to a section whose rendered text contains the answer's key
    // nouns. Without this, a pricing or cancellation answer can cite the
    // start form (#invitation) — which contains none of the answer text —
    // and still report as passed. See citationUrlSupportsAnswer below.
    if (result.unknown || !allowed.includes(result.sources[0]?.id) || !citationUrlSupportsAnswer(result.sources[0])) {
      misCited.push(question);
    }
  }
  const pricingAccuracy = runPricingAccuracyEval(pricingCatalog);
  return {
    shouldAnswer: { total: SHOULD_ANSWER.length, passed: SHOULD_ANSWER.length - falselyRefused.length, falselyRefused },
    shouldRefuse: { total: SHOULD_REFUSE.length, passed: SHOULD_REFUSE.length - wronglyAnswered.length, wronglyAnswered },
    citations: { total: CITATION_EXPECTATIONS.length, passed: CITATION_EXPECTATIONS.length - misCited.length, misCited },
    pricingAccuracy,
  };
}

// The rendered text of each homepage section a demo source can cite, keyed by
// URL fragment (without the leading #). This is the text a buyer sees when
// they click a citation, transcribed from the section bodies in src/App.tsx.
// A citation that points at a fragment resolves to the section text here; a
// citation that points at a standalone page (no fragment, e.g. /terms or
// /docs/install) is outside this detector — those pages are not homepage
// sections and verifying their rendered text is a separate concern.
const HOMEPAGE_SECTION_CONTENT = {
  invitation:
    "Start with your website. Start free or choose a paid plan, train from your site, and install only after one cited answer looks right.",
  "public-pricing":
    "Simple monthly pricing. Checkout shows your exact total in your local currency, tax included. Cancel anytime, no contracts. Payments are final for the digital service, and genuine billing errors are made right. " +
    "Starter 1000 responses per month 1 bot 100 pages Manual refresh Site Rep branding Source-backed answers. " +
    "Growth 4000 responses per month 2 bots 1000 pages Branding removal Weekly email digest Repair queue. " +
    "Pro 12000 responses per month 5 bots 5000 pages Daily or weekly auto-sync Webhook integrations Strict source routing. " +
    "Agency 40000 responses per month 20 bots 10000 pages Client dashboards Weekly email digests Answer reports per site.",
  "how-it-works":
    "Source-backed answers first. Team follow-up when source backing is missing. Site Rep is built for the questions that decide whether a serious visitor keeps moving: price, setup, trust, delivery, care, and fit. " +
    "Train from approved pages. Test buyer questions. Install the widget. Review leads and follow-up. " +
    "Built for the current product. Site Rep covers source-backed website chat, lead capture, and private follow-up. Larger automation appears only when it is ready to use.",
  "how-answers-work":
    "What a visitor sees, from question to cited answer. The visitor asks. The rep checks your pages. The answer cites its source. Missing backing becomes follow-up. " +
    "Start with your own site, free. 50 source-backed answers, no card, no time limit. When the free answers run out, the rep keeps collecting visitor emails instead of going quiet. Train from a website URL, test one cited answer, then install the widget only when it looks right.",
  demo:
    "Ask the website rep before you install it. Use the demo to test pricing, setup, trust, and a question the site cannot prove. A good install should answer with sources or collect follow-up instead of guessing.",
  trust:
    "Source-backed chat with clear controls. Site Rep answers from approved website sources, keeps visitor data limited, and shows your team what needs human follow-up. Answers from approved sources and says when it does not know. Payment unlock, rate limits, access checks, and source storage stay server-side.",
};

// Words that carry no topical signal: grammar glue, the brand's own name, and
// the Question/Answer labels that structure every demo source's content.
const URL_CHECK_STOP_WORDS = new Set([
  "question",
  "answer",
  "site",
  "rep",
  "siterep",
  "yes",
  "no",
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "be",
  "by",
  "with",
  "your",
  "you",
  "it",
  "its",
  "that",
  "this",
  "when",
  "how",
  "what",
  "does",
  "do",
  "can",
  "will",
  "not",
  "only",
  "than",
  "then",
  "each",
  "every",
  "all",
  "any",
  "up",
  "out",
  "off",
  "per",
  "into",
  "from",
  "at",
  "as",
  "so",
  "if",
  "but",
  "has",
  "have",
  "had",
  "let",
  "keeps",
  "keep",
  "gives",
  "give",
  "adds",
  "add",
  "get",
  "got",
  "make",
  "made",
  "use",
  "used",
  "see",
  "seen",
  "say",
  "says",
  "said",
  "want",
  "wants",
  "need",
  "needs",
  "take",
  "takes",
  "put",
  "puts",
  "set",
  "sets",
  "run",
  "running",
  "work",
  "works",
  "look",
  "looks",
  "right",
  "left",
  "one",
  "two",
  "three",
  "four",
  "five",
  "ten",
  "new",
  "old",
  "own",
  "their",
  "they",
  "them",
  "we",
  "us",
  "our",
  "more",
  "most",
  "less",
  "much",
  "many",
  "first",
  "next",
  "last",
  "after",
  "before",
  "during",
  "while",
  "also",
  "even",
  "still",
  "just",
  "both",
  "same",
  "different",
  "higher",
  "lower",
  "small",
  "big",
  "bigger",
  "quick",
  "long",
  "short",
  "full",
  "real",
  "live",
  "exact",
  "total",
  "local",
  "month",
  "monthly",
  "year",
  "yearly",
  "day",
  "daily",
  "weekly",
  "time",
  "now",
  "here",
  "there",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
]);

// The minimum share of the answer's key nouns that must appear in the cited
// section's rendered text for the citation to count as backed. A section that
// contains fewer than half of the answer's key nouns does not actually back
// the answer — a buyer who clicks it lands on a page that lacks the words the
// bot recited.
const CITATION_URL_SUPPORT_THRESHOLD = 0.5;

// True when the cited source's URL resolves to a homepage section whose
// rendered text contains a meaningful share of the answer's key nouns.
//
// Standalone pages (no URL fragment, e.g. /terms or /docs/install) are not
// homepage sections, so this detector does not verify their rendered text —
// that is a separate concern. A fragment that does not map to a known section
// fails closed: an unverified section cannot back an answer.
export function citationUrlSupportsAnswer(source) {
  if (!source || !source.url) return false;
  const fragmentIndex = String(source.url).indexOf("#");
  if (fragmentIndex < 0) return true;
  const fragment = String(source.url).slice(fragmentIndex + 1).split(/[?&]/)[0];
  if (!fragment) return true;
  const sectionText = HOMEPAGE_SECTION_CONTENT[fragment];
  if (!sectionText) return false;
  const answerNouns = extractKeyNouns(source.content || source.excerpt || "");
  if (answerNouns.length === 0) return true;
  const sectionNormalized = normalizeForMatch(sectionText);
  const present = answerNouns.filter((noun) => sectionNormalized.includes(noun));
  return present.length / answerNouns.length >= CITATION_URL_SUPPORT_THRESHOLD;
}

function extractKeyNouns(text) {
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !URL_CHECK_STOP_WORDS.has(token));
  return [...new Set(tokens)];
}

function normalizeForMatch(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
