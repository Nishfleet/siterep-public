import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Guards the demo-bot answer-quality fixes: a cited public answer must never
// be a narrated non-answer, never cite the same source twice, and the
// hydration merge must key on source identity rather than URL.

test("hydration merges by source id so same-URL sources stay distinct", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const hydrate = worker.slice(worker.indexOf("async function hydrateSourcesForQuestion"));
  const hydrateBody = hydrate.slice(0, hydrate.indexOf("\n}"));
  assert.match(hydrateBody, /const hydrationKey = \(source\) => source\.id \|\| sourceKeyForDiff\(source\)/);
  assert.doesNotMatch(hydrateBody, /\[sourceKeyForDiff\(source\), source\]/);
});

test("model-judged unsupported answers become honest refusals, not cited non-answers", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const handler = worker.slice(worker.indexOf("async function handleComposedPublicChat"));
  const handlerBody = handler.slice(0, handler.indexOf("\n}"));
  assert.match(handlerBody, /composed\.status === "composed"/);
  assert.match(handlerBody, /composed\.status === "unsupported"/);
  assert.match(handlerBody, /unknownAnswer\(/);
});

test("demo pricing answers are never handed to the compose model", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const handler = worker.slice(worker.indexOf("async function handleComposedPublicChat"));
  const handlerBody = handler.slice(0, handler.indexOf("\n}"));
  // The compose step must short-circuit when the answer cites the dedicated
  // demo pricing sources — a model rewrite drops the plan names the live
  // quote guarantees.
  assert.match(handlerBody, /isExactDemoPricingAnswer\(prep\.answer\)/);
  assert.match(handlerBody, /&& prep\.eligible/);
});

test("live monitor asserts the pricing quote keeps all four named plans verbatim", async () => {
  const monitor = await readFile(new URL("../scripts/siterep-live-synthetic.mjs", import.meta.url), "utf8");

  assert.match(monitor, /function assertQuoteNotParaphrased/);
  assert.match(monitor, /function assertPricingQuotesNamedPlans/);
  assert.match(monitor, /data\.sources\?\.\[0\]\?\.excerpt/);
  assert.match(monitor, /"Starter", "Growth", "Pro", "Agency"/);
  assert.match(monitor, /assertPricingQuotesNamedPlans\("pricing demo", data\)/);
  assert.match(monitor, /assertQuoteNotParaphrased\("natural pricing demo", data\)/);
});

test("live monitor asserts cited answers are honest and citations are unique", async () => {
  const monitor = await readFile(new URL("../scripts/siterep-live-synthetic.mjs", import.meta.url), "utf8");

  assert.match(monitor, /import \{ isNonAnswerText \} from "\.\.\/worker\/compose\.js"/);
  assert.match(monitor, /function assertHonestCitedAnswer/);
  assert.match(monitor, /cited the same source more than once/);
  assert.match(monitor, /non-answer dressed as a cited answer/);
  // All cited probes (pricing, install, and trust demo questions) go through the shared assertion.
  assert.match(monitor, /assertHonestCitedAnswer\("pricing demo", data\)/);
  assert.match(monitor, /assertHonestCitedAnswer\("install demo", data\)/);
  assert.match(monitor, /assertHonestCitedAnswer\("trust demo", data\)/);
  assert.match(monitor, /How do I install it\?/);
});

test("live monitor covers every public demo CTA question", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const monitor = await readFile(new URL("../scripts/siterep-live-synthetic.mjs", import.meta.url), "utf8");

  const appMatch = app.match(/const\s+publicDemoQuestions\s*=\s*(\[[^\]]+\]);/);
  assert.ok(appMatch, "publicDemoQuestions array not found in src/App.tsx");
  const appQuestions = [...appMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const workerMatch = worker.match(/PUBLIC_DEMO_WIDGET_SETTINGS\s*=.*?suggestedQuestions:\s*(\[[^\]]+\])/s);
  assert.ok(workerMatch, "PUBLIC_DEMO_WIDGET_SETTINGS.suggestedQuestions not found in worker/index.js");
  const workerQuestions = [...workerMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  // The homepage and the public demo bot must agree on the CTA list.
  assert.deepStrictEqual(appQuestions, workerQuestions);

  // Every public demo CTA must be exercised by at least one canary probe.
  for (const question of appQuestions) {
    assert.ok(
      monitor.includes(question),
      `public demo CTA "${question}" is missing from the live canary`,
    );
  }

  // New chat probes get a response-time budget.
  assert.match(monitor, /"widget trust chat": 9000/);
});

test("public demo bot keeps a dedicated install source for the suggested install question", async () => {
  const demoSources = await readFile(new URL("../worker/demo-sources.js", import.meta.url), "utf8");

  assert.match(demoSources, /id: "demo-install"/);
  assert.match(demoSources, /How do I install Site Rep on my website\?/);
  const installBlock = demoSources.match(/id: "demo-install"[\s\S]{0,300}?url: `([^`]+)`/);
  assert.ok(installBlock, "demo-install source url not found");
  assert.match(installBlock[1], /\/docs\/install/);
});

test("public demo what-is source cites the product definition page, not how-it-works", async () => {
  const demoSources = await readFile(new URL("../worker/demo-sources.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(demoSources, /id: "demo-what-is"/);
  const whatIsBlock = demoSources.match(/id: "demo-what-is"[\s\S]{0,400}?url: `([^`]+)`/);
  assert.ok(whatIsBlock, "demo-what-is source url not found");
  assert.doesNotMatch(whatIsBlock[1], /#how-it-works/);
  assert.match(whatIsBlock[1], /\/ai-website-chatbot-for-small-business/);

  const answerMatch = demoSources.match(/id: "demo-what-is"[\s\S]*?Answer: ([^"\\]+)/);
  assert.ok(answerMatch, "demo-what-is answer text not found");
  const answer = answerMatch[1];
  assert.match(answer, /Site Rep is a chat widget for your website/);
  assert.match(answer, /approved pages/);
  assert.match(answer, /private dashboard/);

  const buyerStart = worker.indexOf("const BUYER_INTENT_MARKDOWN = `");
  assert.ok(buyerStart >= 0, "BUYER_INTENT_MARKDOWN not found");
  const buyerEnd = worker.indexOf("\n`;", buyerStart);
  const buyer = worker.slice(buyerStart, buyerEnd);
  assert.match(buyer, /## What Site Rep does/);
  assert.match(buyer, /approved website pages/);
  assert.match(buyer, /A live website widget/);
  assert.match(buyer, /Captures lead details/);
  assert.match(buyer, /private customer dashboard/);
  assert.match(buyer, /source-backed answers/);
});

test("public demo lead-capture source cites the product page that describes lead capture, not how-it-works", async () => {
  const { PUBLIC_DEMO_SOURCES } = await import("../worker/demo-sources.js");
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const lead = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-lead-capture");
  assert.ok(lead, "demo-lead-capture source missing");
  assert.equal(lead.id, "demo-lead-capture");
  assert.doesNotMatch(lead.url, /#how-it-works/);
  assert.match(lead.url, /\/ai-website-chatbot-for-small-business/);

  // Answer text and source id stay put. Only the citation target moves.
  assert.match(lead.content, /What happens when a visitor leaves their email\?/);
  assert.match(lead.content, /captures the visitor's question and contact details as a lead/);
  assert.match(lead.content, /notifies your team/);
  assert.match(lead.content, /suggested follow-up draft/);
  assert.match(lead.content, /contacted, won, or lost/);

  const buyerStart = worker.indexOf("const BUYER_INTENT_MARKDOWN = `");
  assert.ok(buyerStart >= 0, "BUYER_INTENT_MARKDOWN not found");
  const buyerEnd = worker.indexOf("\n`;", buyerStart);
  const buyer = worker.slice(buyerStart, buyerEnd);
  assert.match(buyer, /Captures lead details when a visitor needs human follow-up/);
  assert.match(buyer, /private dashboard for leads, conversations, source gaps, and follow-up items/);
});

test("demo-pricing citation points at a page that contains the free-trial text", async () => {
  const { PUBLIC_DEMO_SOURCES } = await import("../worker/demo-sources.js");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  const pricing = PUBLIC_DEMO_SOURCES.find((source) => source.id === "demo-pricing");
  assert.ok(pricing, "demo-pricing source missing");
  assert.doesNotMatch(pricing.url, /#invitation/);

  const cited = new URL(pricing.url);
  assert.equal(cited.origin, "https://siterep.net");
  const hash = cited.hash.replace(/^#/, "");
  let surface = app;
  if (hash) {
    const section = app.match(new RegExp(`<section[^>]*\\bid="${hash}"[\\s\\S]*?</section>`));
    assert.ok(section, `cited section #${hash} is missing from the homepage`);
    surface = section[0];
  } else {
    assert.equal(cited.pathname, "/");
  }
  assert.match(surface, /50 source-backed answers/);
  assert.match(surface, /no card/i);
});

test("widget first impression is honest and visitor-voiced", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  // No fabricated source chips in the welcome bubble, ever — citations only
  // appear on real answers.
  assert.doesNotMatch(widget, /<span>Pricing<\/span><span>Security<\/span>/);
  // The status pill starts hidden and hides itself when there is nothing to say.
  assert.match(widget, /data-cr-status hidden/);
  assert.match(widget, /status\.hidden = !text/);
  // Visitor-voiced labels — visitors are not "leads" and don't run review queues.
  assert.doesNotMatch(widget, />Send lead</);
  assert.doesNotMatch(widget, />Needs review</);
  assert.match(widget, /Not helpful/);
  assert.doesNotMatch(widget, /placeholder="Work email"/);
  // One session per visit, double-submit guard, and answers announced to
  // screen readers.
  assert.match(widget, /sessionStorage\.getItem\("siterep-session"\)/);
  assert.match(widget, /submitButton\.disabled = true/);
  assert.match(widget, /aria-live="polite"/);
  assert.match(widget, /name="name" placeholder="Name" aria-label="Name"/);
  assert.match(widget, /name="email" type="email" placeholder="Email" required aria-label="Email"/);
  assert.match(widget, /textarea name="need" placeholder="What should the team follow up on\?" aria-label="What should the team follow up on\?"/);
  assert.match(widget, /\.cr-lead input\{min-height:44px\}/);
  assert.match(widget, /\.cr-lead textarea\{min-height:76px/);
  assert.match(widget, /\.cr-lead button\{min-height:44px/);
  assert.match(widget, /\.cr-close\{width:44px;height:44px/);
  assert.match(widget, /\.cr-suggestions button\{[\s\S]*?min-height:44px/);
  assert.match(widget, /\.cr-send\{width:44px;min-height:44px/);
  assert.match(widget, /@keyframes cr-launch-in\{from\{opacity:0\}to\{opacity:1\}\}/);
});
