// Curated knowledge for the public demo bot (site-rep-demo). These are the
// only sources the homepage demo can cite — keep them in sync with live
// product truth. tests/demo-refusal-evals.test.js runs the retrieval evals
// (should-answer vs should-refuse) against exactly this content.
const PUBLIC_SITE_URL = "https://siterep.net";

// Named-plan price questions: the demo bot answers "What does Starter cost?"
// (and natural variants) with the exact live localized, tax-inclusive amount
// the pricing/checkout surface renders — but ONLY when a trustworthy current
// price resolves for the same request. The detection demands both "starter"
// AND a real price-intent word, so "what does the starter plan include" or
// "can the starter plan handle 5,000 pages" never trigger the price answer,
// and the generic "What does Site Rep cost?" keeps its checkout-explaining
// answer. See starterPriceAnswerFor below for the trust rule.
const STARTER_PRICE_INTENT = /\b(?:cost|costs|pricing|price|priced|fee|fees|charge|charges|much|worth|expensive|cheap|affordable|subscription)\b/i;

export function isNamedStarterPriceQuestion(question) {
  const value = String(question || "");
  if (!value || !/\bstarter\b/i.test(value)) return false;
  return STARTER_PRICE_INTENT.test(value);
}

// A price is the buyer's truth ONLY when it came from the live checkout
// preview: localized to the buyer, tax-inclusive, with a real amount and
// currency (source "dodo_checkout_preview"). Everything else — unset plans,
// the static USD plan anchor ("plan-fallback"), or static env amounts that
// are not buyer-localized and tax-inclusive — must fall back to the honest
// checkout/email path. Never hardcode a currency amount here: the only
// amount that can appear comes from the plan's live displayPrice.
export function starterPriceAnswerFor(plan = {}) {
  const displayPrice = String(plan.displayPrice || "").trim();
  const trustworthy =
    plan.source === "dodo_checkout_preview" &&
    String(plan.currency || "").trim().length > 0 &&
    Number.isFinite(Number(plan.amountSubunits)) &&
    Number(plan.amountSubunits) > 0 &&
    displayPrice.length > 0;
  if (!trustworthy) return starterPriceUnavailableAnswer();
  return `The Starter plan costs ${displayPrice} per month, tax included — the exact live checkout total in your local currency. Start setup at live checkout to see the same total before you pay.`;
}

export function starterPriceUnavailableAnswer() {
  return "The live local cost for the Starter plan is not confirmed right now — checkout preview pricing is unavailable. Start setup at live checkout to see the exact total in your currency, tax included, before you pay, or email hello@siterep.net so the Starter total can be confirmed before payment.";
}

// The dedicated source the demo bot cites for named-plan price answers. Its
// title carries "starter" and "pricing" and its content carries the answer
// verbatim, so lexical retrieval ranks it first for natural named-plan
// phrasings ("how much is the starter plan", "what's the starter price") and
// the citation points at the live pricing surface. Built per request from
// the live checkout preview; never stored on the demo bot record.
export function starterPricingSource(answerText) {
  return {
    id: "demo-starter-pricing",
    title: "Starter pricing",
    url: `${PUBLIC_SITE_URL}/#invitation`,
    excerpt: String(answerText || ""),
    content: `Question: What does Starter cost?\nAnswer: ${String(answerText || "")}`,
    sourceType: "manual",
    status: "indexed",
    indexedAt: "2026-05-30T00:00:00.000Z",
  };
}

// Generic pricing questions ("What does it cost?", "how much does Site Rep
// cost", "do you have a cheap plan") ask about the overall cost of Site Rep
// rather than one named plan. The demo bot answers these by quoting the four
// named-plan prices the live #public-pricing section renders on the same page
// — but ONLY when a trustworthy current price resolves for every plan. The
// detection demands a real price-intent word and rejects any question that
// names a specific plan (those use the exact-price path) or asks about the
// free trial (which keeps its own answer).
const PRICING_INTENT = /\b(?:cost|costs|costing|pricing|price|priced|prices|fee|fees|charge|charges|much|worth|expensive|cheap|affordable|subscription)\b/i;
const NAMED_PLAN = /\b(?:starter|growth|pro|agency)\b/i;
const FREE_TRIAL = /\b(?:free trial|free start|trial)\b/i;

export function isPricingQuestion(question) {
  const value = String(question || "");
  if (!value || !PRICING_INTENT.test(value)) return false;
  if (NAMED_PLAN.test(value)) return false;
  if (FREE_TRIAL.test(value)) return false;
  return true;
}

// A plan price is the buyer's truth ONLY when it came from the live checkout
// preview: localized to the buyer, tax-inclusive, with a real amount and
// currency (source "dodo_checkout_preview"). Everything else — unset plans,
// the static USD plan anchor ("plan-fallback"), or static env amounts that are
// not buyer-localized and tax-inclusive — must fall back to the honest
// checkout/email path. Never hardcode a currency amount here: the only amounts
// that can appear come from each plan's live displayPrice, the same values the
// #public-pricing section renders on the page.
export function planPricesAnswerFor(plans = []) {
  const named = ["Starter", "Growth", "Pro", "Agency"];
  const priced = named.map((name) => plans.find((plan) => plan.name === name)).filter(Boolean);
  const allTrustworthy =
    priced.length === named.length &&
    priced.every((plan) => {
      const displayPrice = String(plan.displayPrice || "").trim();
      return (
        plan.source === "dodo_checkout_preview" &&
        String(plan.currency || "").trim().length > 0 &&
        Number.isFinite(Number(plan.amountSubunits)) &&
        Number(plan.amountSubunits) > 0 &&
        displayPrice.length > 0
      );
    });
  if (!allTrustworthy) return planPricesUnavailableAnswer();
  const quoted = priced.map((plan) => `${plan.name} ${plan.displayPrice}`).join(", ");
  return `${quoted} per month, tax included — the exact live checkout totals in your local currency. Start setup at live checkout to see the same totals before you pay.`;
}

export function planPricesUnavailableAnswer() {
  return "The live local totals for the plans are not confirmed right now — checkout preview pricing is unavailable. Start setup at live checkout to see the exact totals in your currency, tax included, before you pay, or email hello@siterep.net so the totals can be confirmed before payment.";
}

// The dedicated source the demo bot cites for generic pricing answers. Its
// title carries "pricing" and its content carries the answer verbatim, so
// lexical retrieval ranks it first for natural phrasings ("what does it
// cost", "how much is site rep") and the citation points at the live
// #public-pricing surface on the same page. Built per request from the live
// checkout preview; never stored on the demo bot record.
export function planPricingSource(answerText) {
  return {
    id: "demo-plan-pricing",
    title: "Plan pricing",
    url: `${PUBLIC_SITE_URL}/#public-pricing`,
    excerpt: String(answerText || ""),
    content: `Question: What does it cost?\nAnswer: ${String(answerText || "")}`,
    sourceType: "manual",
    status: "indexed",
    indexedAt: "2026-05-30T00:00:00.000Z",
  };
}

// These dedicated pricing sources carry exact live-checkout quotes the
// retrieval layer built one sentence at a time ("Starter €9.25, Growth €29.80,
// Pro €60.64, Agency €153.13 per month, tax included — ..." or the honest
// checkout/email fallback). The compose step must never paraphrase them: a
// warm rewrite drops the plan names the quote guarantees. When an answer
// cites either source, its text is final and ships verbatim.
export function isExactDemoPricingAnswer(answer) {
  const id = String(answer?.sources?.[0]?.id || "");
  return id === "demo-plan-pricing" || id === "demo-starter-pricing";
}

export const PUBLIC_DEMO_SOURCES = Object.freeze([
  {
    id: "demo-pricing",
    title: "Pricing",
    url: `${PUBLIC_SITE_URL}/#invitation`,
    content:
      "Question: How much does Site Rep cost?\nAnswer: Checkout shows the exact Site Rep total in your local currency, tax included, before you pay. Starter includes 1 bot, 100 pages, and 1,000 source-backed replies each month; Growth, Pro, and Agency add higher limits. If the live local total is not available for a plan, Site Rep asks you to email hello@siterep.net so the total can be confirmed before payment.\n\nQuestion: Is there a free trial?\nAnswer: Site Rep has a no-card Free start with 50 source-backed answers. When those answers are used up, the rep keeps capturing visitor emails, and you can upgrade from live checkout pricing to switch answering back on. There are no contracts — every paid plan is month to month and you can cancel anytime before the next renewal. If you see a billing error after signing up, email hello@siterep.net and we will make it right.",
  },
  {
    id: "demo-what-is",
    title: "What Site Rep does",
    url: `${PUBLIC_SITE_URL}/#how-it-works`,
    content:
      "Question: What is Site Rep?\nAnswer: Site Rep is a chat widget for your website that answers visitor questions using only your own approved pages, shows the source behind every answer, says when your pages do not cover something, and captures the visitor's email as a lead so you can follow up. You see every question, answer, and lead in a private dashboard.",
  },
  {
    id: "demo-install",
    title: "Installing the widget",
    url: `${PUBLIC_SITE_URL}/#how-it-works`,
    content:
      "Question: How do I install Site Rep on my website?\nAnswer: After your site is scanned, you copy one small script snippet and paste it into your site before the closing body tag. On WordPress use a header-footer or custom-HTML block, on Wix use Settings then Custom Code, on Squarespace use Settings, Advanced, Code Injection, and on Shopify edit the theme.liquid layout. The dashboard confirms when the widget is live on your domain.",
  },
  {
    id: "demo-get-started",
    title: "Getting started",
    url: `${PUBLIC_SITE_URL}/#invitation`,
    content:
      "Question: How do I sign up and get started?\nAnswer: Click Start setup on siterep.net, enter your website address and email, and review the live checkout price for the plan you want. Free start needs no card; paid setup unlocks only after server-verified payment. Your dashboard opens with access details emailed to you.\n\nQuestion: I want to buy this for my website. What do I do next?\nAnswer: Choose a plan at live checkout, then train the rep from your site pages, test a few buyer questions, and paste the widget snippet on your site after review.\n\nQuestion: How long does it take to get this running on my site?\nAnswer: Setup is designed to be quick: train the rep from your pages, review cited answers, copy the snippet, and paste it before the closing body tag. The dashboard confirms when the widget is installed on your domain.\n\nQuestion: Will this work on my website platform?\nAnswer: Yes — the widget is one small script snippet that works on any website where you can add custom code, including WordPress, Wix, Squarespace, Shopify, and hand-built sites.",
  },
  {
    id: "demo-cancel-refund",
    title: "Cancellation and refunds",
    url: `${PUBLIC_SITE_URL}/terms`,
    content:
	      "Question: Can I cancel my subscription anytime?\nAnswer: Yes. Every plan is a monthly subscription you can cancel anytime. Use the billing portal when it is linked to your account, or email hello@siterep.net for cancellation and billing requests. Your service stays active until the end of the paid period.\n\nQuestion: What is the refund policy?\nAnswer: All purchases are final — Site Rep is a digital product delivered immediately, so payments are non-refundable. There are no contracts, so you control your spend by cancelling anytime before the next renewal. If there is a genuine billing error, such as a double charge, email hello@siterep.net and we will make it right.",
  },
  {
    id: "demo-source-proof",
    title: "How answers stay honest",
    url: `${PUBLIC_SITE_URL}/trust`,
    content:
      "Question: How is Site Rep different from other website chatbots?\nAnswer: Site Rep only answers from your approved website content and cites the exact source page under every answer. When your pages do not cover a question, it says so and offers to collect the visitor's email instead of inventing an answer. Every unanswered question lands in your private dashboard so you can add the missing page and close the gap.",
  },
  {
    id: "demo-lead-capture",
    title: "Lead capture",
    url: `${PUBLIC_SITE_URL}/#how-it-works`,
    content:
      "Question: What happens when a visitor leaves their email?\nAnswer: Site Rep captures the visitor's question and contact details as a lead, notifies your team, and keeps the full conversation in your private dashboard with a suggested follow-up draft. You can mark each lead contacted, won, or lost.",
  },
  {
    id: "demo-plan-features",
    title: "Plan features and limits",
    url: `${PUBLIC_SITE_URL}/#public-pricing`,
    content:
      "Question: Can I remove the Site Rep branding?\nAnswer: Yes. The Starter plan keeps Site Rep branding on. Growth, Pro, and Agency let you remove Site Rep branding.\n\nQuestion: What plan lets me remove branding?\nAnswer: Growth, Pro, and Agency let you remove Site Rep branding. Starter keeps branding on.\n\nQuestion: Can I use Site Rep on multiple client sites?\nAnswer: Agency is for up to 50 client sites with the highest limits. Starter is for one site, Growth for up to three sites, and Pro for up to ten sites.\n\nQuestion: What is the difference between Growth and Pro?\nAnswer: Growth gives you 2 bots, 1000 pages, and 4000 source-backed replies each month. Pro gives you 5 bots, 5000 pages, and 12000 replies for busier sites. Both can remove Site Rep branding.\n\nQuestion: What are the plan limits?\nAnswer: Starter includes 1 bot, 100 pages, and 1000 source-backed replies. Growth adds 2 bots, 1000 pages, and 4000 replies plus removable branding. Pro adds 5 bots, 5000 pages, and 12000 replies. Agency adds 20 bots, 10000 pages, and 40000 replies for up to 50 client sites.",
  },
]);
