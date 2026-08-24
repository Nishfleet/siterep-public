import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { answerFromSources, candidateSourcesForQuestion } from "../server/search.js";

const pricingSource = {
  id: "pricing",
  title: "Pricing",
  url: "https://example.com/pricing",
  excerpt: "Starter is $9/month and includes 1,000 AI responses.",
  content: "Starter is $9/month and includes 1,000 AI responses. Growth is $29/month for higher volume.",
  indexedAt: "2026-05-03T00:00:00.000Z",
};

test("answers with a cited supporting source sentence", () => {
  const result = answerFromSources("What does it cost?", [pricingSource]);

  assert.equal(result.unknown, false);
  assert.match(result.answer, /\$9\/month/);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].title, "Pricing");
});

test("never cites the same source twice when the pool contains duplicate entries", () => {
  // Regression: a URL-keyed hydration merge used to collapse distinct sources
  // sharing a URL into one source repeated N times, producing triplicate
  // citations in the public demo bot's payload.
  const result = answerFromSources("What does it cost?", [pricingSource, { ...pricingSource }, { ...pricingSource }]);

  assert.equal(result.unknown, false);
  const ids = result.sources.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["pricing"]);
});

test("duplicate entries do not crowd out a distinct relevant source", () => {
  const installSource = {
    id: "install",
    title: "Installing the widget",
    url: "https://example.com/pricing",
    excerpt: "Copy one small script snippet and paste it before the closing body tag.",
    content:
      "Question: How do I install the widget on my website?\nAnswer: Copy one small script snippet and paste it into your site before the closing body tag. The dashboard confirms when the widget is live.",
    indexedAt: "2026-05-03T00:00:00.000Z",
  };
  const result = answerFromSources("How do I install the widget on my website?", [
    pricingSource,
    { ...pricingSource },
    installSource,
  ]);

  assert.equal(result.unknown, false);
  assert.match(result.answer, /script snippet/i);
  assert.equal(result.sources[0].id, "install");
  const ids = result.sources.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("refuses unrelated questions instead of inventing", () => {
  const result = answerFromSources("Do you support quantum payroll?", [pricingSource]);

  assert.equal(result.unknown, true);
  assert.equal(result.sources.length, 0);
  assert.match(result.answer, /don't have that answer yet/i);
});

test("refuses brand-name questions when only the product name matches", () => {
  const result = answerFromSources("Can Site Rep manage my warehouse payroll?", [
    {
      id: "site-rep-pricing",
      title: "Site Rep pricing",
      url: "https://siterep.net/#pricing",
      excerpt: "Site Rep pricing is loaded from the live checkout preview.",
      content:
        "Site Rep pricing is loaded from the live checkout preview. The Starter setup includes one bot, one allowed install domain, and source-backed replies.",
      indexedAt: "2026-05-23T00:00:00.000Z",
    },
  ]);

  assert.equal(result.unknown, true);
  assert.equal(result.sources.length, 0);
  assert.match(result.answer, /don't have that answer yet/i);
});

test("refuses title-only matches when source content does not support the answer", () => {
  const result = answerFromSources("What does it cost?", [
    {
      id: "pricing-title-only",
      title: "Pricing",
      url: "https://example.com/pricing",
      excerpt: "Our team works with small businesses and replies quickly.",
      content: "Our team works with small businesses and replies quickly.",
      indexedAt: "2026-05-03T00:00:00.000Z",
    },
  ]);

  assert.equal(result.unknown, true);
  assert.equal(result.sources.length, 0);
});

test("uses source content previews for R2-backed candidate selection", () => {
  const r2BackedSource = {
    ...pricingSource,
    content: "",
    contentPreview: pricingSource.content,
    contentR2Key: "bots/demo/sources/pricing.txt",
    contentStored: "r2",
  };

  const candidates = candidateSourcesForQuestion("What does it cost?", [r2BackedSource]);
  const result = answerFromSources("What does it cost?", [r2BackedSource]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contentR2Key, "bots/demo/sources/pricing.txt");
  assert.equal(result.unknown, false);
  assert.match(result.answer, /\$9\/month/);
  assert.equal(result.sources[0].contentPreview, undefined);
});

test("answers from the answer side of imported Q&A sources", () => {
  const result = answerFromSources("What is your refund policy?", [
    {
      id: "faq-import",
      title: "Imported FAQ",
      url: "upload://faq.csv",
      excerpt: "Imported FAQ migration source.",
      content: [
        "Topic: Billing",
        "Question: What is your refund policy?",
        "Answer: Customers can request a refund within 14 days when the setup has not been completed.",
        "Source URL: https://example.com/refunds",
      ].join("\n"),
      indexedAt: "2026-05-31T00:00:00.000Z",
    },
  ]);

  assert.equal(result.unknown, false);
  assert.match(result.answer, /Customers can request a refund within 14 days/);
  assert.doesNotMatch(result.answer, /Question:/);
});

test("public widget has no canned answer fallback", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  assert.doesNotMatch(widget, /Offline fallback/i);
  assert.doesNotMatch(widget, /answers\.find/i);
  assert.doesNotMatch(widget, /Starter is \$9\/month/i);
  assert.match(widget, /I cannot reach the indexed sources right now, so I will not guess/);
});

test("recovers a one-letter typo in a content word", () => {
  const result = answerFromSources("what does it costt?", [pricingSource]);

  assert.equal(result.unknown, false);
  assert.match(result.answer, /\$9\/month/);
});

test("short follow-ups borrow context from the previous question", () => {
  const followUp = answerFromSources("how much is that?", [pricingSource], {
    recentQuestions: ["What does it cost?"],
  });
  const tellMeMore = answerFromSources("tell me more", [pricingSource], {
    recentQuestions: ["What does it cost?"],
  });
  const vagueAboutThat = answerFromSources("what about that?", [pricingSource], {
    recentQuestions: ["What does it cost?"],
  });
  const vagueHowAboutIt = answerFromSources("how about it?", [pricingSource], {
    recentQuestions: ["What does it cost?"],
  });
  const cold = answerFromSources("how much is that?", [pricingSource]);

  assert.equal(followUp.unknown, false);
  assert.match(followUp.answer, /\$9\/month/);
  assert.equal(tellMeMore.unknown, false);
  assert.match(tellMeMore.answer, /\$9\/month/);
  assert.equal(vagueAboutThat.unknown, false);
  assert.match(vagueAboutThat.answer, /\$9\/month/);
  assert.equal(vagueHowAboutIt.unknown, false);
  assert.match(vagueHowAboutIt.answer, /\$9\/month/);
  assert.equal(cold.unknown, true);
});

test("distinct short questions do not borrow context from the previous topic", () => {
  const result = answerFromSources("Can it file my taxes?", [pricingSource], {
    recentQuestions: ["What does it cost?"],
  });
  const concreteTellMeMore = answerFromSources("tell me more about taxes", [pricingSource], {
    recentQuestions: ["What does it cost?"],
  });

  assert.equal(result.unknown, true);
  assert.equal(result.sources.length, 0);
  assert.equal(concreteTellMeMore.unknown, true);
  assert.equal(concreteTellMeMore.sources.length, 0);
});

test("answers continue into the adjacent sentence when on topic", () => {
  const result = answerFromSources("What does it cost?", [pricingSource]);

  // Both the Starter and Growth pricing sentences are on topic and adjacent.
  assert.match(result.answer, /\$9\/month/);
  assert.match(result.answer, /\$29\/month/);
});

test("one stray body-word hit refuses instead of answering off topic", () => {
  const result = answerFromSources("What is your refund policy?", [
    {
      id: "about",
      title: "About our team",
      url: "https://example.com/about",
      excerpt: "We are a small team that loves what we do.",
      content: "Our internal policy is to reply to every customer within one business day.",
      indexedAt: "2026-05-03T00:00:00.000Z",
    },
  ]);

  assert.equal(result.unknown, true);
  assert.equal(result.sources.length, 0);
});
