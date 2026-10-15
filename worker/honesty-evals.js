import { applyLiveDemoPricingAnswer } from "./demo-sources.js";

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

export const SHOULD_REFUSE = [
  "can you file my taxes",
  "Can Site Rep manage my warehouse payroll?",
  "what is the weather today",
  "what is the capital of France",
  "do you integrate with Salesforce",
  "are you SOC 2 certified",
  "is there a phone app",
];

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

export function runHonestyEvals(answerFromSources, sources, pricingCatalog = null) {
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

const CITATION_URL_SUPPORT_THRESHOLD = 0.5;

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

export const PRICING_QUESTIONS = [
  "What does Site Rep cost?",
  "how much is the starter plan",
];

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
