import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// The public homepage hero is the buyer's first rendered screen, so its copy
// must carry product-verifiable specifics instead of generic marketing words:
// what Site Rep does, for whom, how source citations work, what happens when
// a source cannot prove an answer, and the free first-value path. These tests
// pin those specifics and guard the claim boundary so the first screen cannot
// drift back into generic or unsupported language.
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

const heroParagraphStart = app.indexOf("Site Rep answers sales and service questions from approved sources and shows the exact source page");
assert.ok(heroParagraphStart >= 0, "public hero paragraph anchor must exist");
const heroParagraphEnd = app.indexOf("</p>", heroParagraphStart);
assert.ok(heroParagraphEnd > heroParagraphStart, "public hero paragraph must close");
const heroParagraph = app.slice(heroParagraphStart, heroParagraphEnd);

const heroChipsStart = app.indexOf('["Source-backed answers only"');
assert.ok(heroChipsStart >= 0, "public hero trust-row chips anchor must exist");
const heroChipsEnd = app.indexOf("])", heroChipsStart);
assert.ok(heroChipsEnd > heroChipsStart, "public hero trust-row chips must close");
const heroChips = app.slice(heroChipsStart, heroChipsEnd);

const freeStartModalStart = app.indexOf("function FreeStartModal(");
assert.ok(freeStartModalStart >= 0, "free-start modal anchor must exist");
const freeStartModalEnd = app.indexOf("function CheckoutModal(", freeStartModalStart);
assert.ok(freeStartModalEnd > freeStartModalStart, "free-start modal must close before the checkout modal");
const freeStartModal = app.slice(freeStartModalStart, freeStartModalEnd);

test("hero names what it does, for whom, and how citations work", () => {
  assert.match(heroParagraph, /small business sites/);
  assert.match(heroParagraph, /answers sales and service questions from approved sources/);
  assert.match(heroParagraph, /exact source page under every answer/);
});

test("hero states the missing-source follow-up outcome instead of guessing", () => {
  assert.match(heroParagraph, /does not prove the answer/);
  assert.match(heroParagraph, /private follow-up queue/);
  assert.match(heroParagraph, /refuses to guess|instead of guessing/);
  assert.doesNotMatch(heroParagraph, /guesses|invents|hallucinat/i);
});

test("buyer question coverage stays visible on the public home", () => {
  const demoCopyStart = app.indexOf("Use the demo to test pricing, setup, trust");
  assert.ok(demoCopyStart >= 0, "public demo coverage line must exist");
  assert.match(app.slice(demoCopyStart, demoCopyStart + 200), /pricing, setup, trust, and a question the site cannot prove/);
});

test("hero chips name only product-verified facts", () => {
  assert.match(heroChips, /Source-backed answers only/);
  assert.match(heroChips, /Private follow-up queue/);
  assert.match(heroChips, /50 free answers/);
});

test("free-answer count in the hero matches the actual free-start offer", () => {
  const modalCap = freeStartModal.match(/(\d+) source-backed answers free/);
  const heroCap = heroChips.match(/(\d+) free answers/);
  assert.ok(modalCap, "free-start modal must state the free answer cap");
  assert.ok(heroCap, "hero chip must state a free answer count");
  assert.equal(heroCap[1], modalCap[1], "hero free-answer count must match the free-start offer");
});

test("free-start dialog submit button matches the no-time-limit offer", () => {
  // The dialog's central trust line is "no card, no time limit"; a "trial"
  // label on the very button that completes the signup would imply a
  // time-limited evaluation and undercut that promise. The submit action must
  // name the free start, and no "trial" token may appear anywhere in the
  // dialog (button, heading, or body copy).
  assert.match(freeStartModal, /Start free — no card/, "dialog heading must name the no-card free start");
  assert.match(freeStartModal, /No credit card\. No time limit\./, "dialog must keep the no-time-limit promise");
  assert.match(freeStartModal, /\{saving \? "Setting up your rep" : "Start free"\}/, "submit button must say Start free (never Start free trial)");
  assert.doesNotMatch(freeStartModal, /trial/i, "free-start dialog must not say 'trial' next to the no-time-limit promise");
});

test("hero stays inside the public claim boundary", () => {
  for (const forbidden of [
    /fastest|smartest|best.?in|#1|world.?class/i,
    /guarantee|\bunlimited\b/i,
    /helpdesk|CRM|compliance|native integration/i,
    /Slack|Intercom|Zendesk|WhatsApp|HubSpot/i,
    /automated (ticket|workflow)|automation/i,
  ]) {
    assert.doesNotMatch(heroParagraph, forbidden, `hero paragraph must not claim: ${forbidden}`);
    assert.doesNotMatch(heroChips, forbidden, `hero chips must not claim: ${forbidden}`);
  }
});

test("hero keeps the free first-value path actions", () => {
  const heroActionsStart = app.indexOf('className="primary-button" type="button" onClick={() => setFreeStartOpen(true)}');
  assert.ok(heroActionsStart >= 0, "public hero free-start action must exist");
  const heroActions = app.slice(heroActionsStart, heroActionsStart + 600);
  assert.match(heroActions, /Start free/);
  assert.match(heroActions, /See plans/);
});

test("hero See plans shows the public pricing section instead of opening checkout", () => {
  const seePlansStart = app.indexOf("See plans");
  assert.ok(seePlansStart >= 0, "hero See plans control must exist");
  const seePlansButton = app.slice(Math.max(0, seePlansStart - 200), seePlansStart);
  assert.match(seePlansButton, /onClick=\{focusPublicPricing\}/, "See plans must open the public pricing section, not checkout");
  assert.doesNotMatch(seePlansButton, /onClick=\{\(\) => openCheckout\(\)\}/, "See plans must not open paid checkout");
  const focusPricingStart = app.indexOf("function focusPublicPricing(");
  assert.ok(focusPricingStart >= 0, "focusPublicPricing helper must exist");
  const focusPricing = app.slice(focusPricingStart, focusPricingStart + 400);
  assert.match(focusPricing, /getElementById\("public-pricing"\)/, "focusPublicPricing must scroll the public pricing section into view");
});
