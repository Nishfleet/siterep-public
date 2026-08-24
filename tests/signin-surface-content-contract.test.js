import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Regression coverage for the dogfood finding "Thin rendered content on /"
// (patternKey 845f5442d5a7): the rendered customer sign-in surface at
// https://siterep.net/?surface=customer (and /signin) measured only 79
// extractable words in runs/20260808T074205Z-msk2fl3n.json. The surface now
// renders a visible, page-specific section under the sign-in card explaining
// what the dashboard includes, how sign-in credentials work, and where help
// and public pages live. These tests pin that content contract so the surface
// can never silently regress to a bare sign-in card again.

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

// The visible sign-in detail block: the only `{showSignInSurface ? (` gate in
// the file (the other matches are ternary-chain continuations, not this gate).
const infoGateStart = appSource.indexOf("{showSignInSurface ? (");
assert.ok(infoGateStart >= 0, "sign-in surface gate must exist");
const infoSectionStart = appSource.indexOf(
  '<section className="signin-surface-info" aria-labelledby="signin-surface-info-heading">',
  infoGateStart,
);
assert.ok(infoSectionStart > infoGateStart, "sign-in info section must sit inside the gate");
const infoSectionEnd = appSource.indexOf("</section>\n      ) : null}", infoSectionStart);
assert.ok(infoSectionEnd > infoSectionStart, "sign-in info section must close before the gate ends");
const infoSection = appSource.slice(infoSectionStart, infoSectionEnd);

const strippedWords = (jsx) =>
  jsx
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/g, " ")
    .replace(/["“”’—–]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

test("the sign-in surface renders page-specific dashboard, sign-in, and help detail", () => {
  // Headings that answer the visitor's real questions page-specifically.
  assert.match(infoSection, /What the dashboard includes/);
  assert.match(infoSection, /Signing in/);
  assert.match(infoSection, /Help and public pages/);
  // Finished dashboard outcomes the sign-in visitor can verify later.
  assert.match(infoSection, /Leads/);
  assert.match(infoSection, /Conversations/);
  assert.match(infoSection, /Unknown questions/);
  assert.match(infoSection, /Source gaps/);
  assert.match(infoSection, /Install health/);
  assert.match(infoSection, /Private exports/);
  assert.match(infoSection, /Deletion-review requests/);
  // Where the credentials come from and what each one does.
  assert.match(infoSection, /Your Site ID and dashboard access key are in the email titled/);
  assert.match(infoSection, /one-use view link/);
  assert.match(infoSection, /read-only view/);
  // A next step to real public surfaces, including a human support address.
  assert.match(infoSection, /href="\/honesty"/);
  assert.match(infoSection, /href="\/trust"/);
  assert.match(infoSection, /href="\/docs\/install"/);
  assert.match(infoSection, /mailto:hello@siterep\.net/);
});

test("the sign-in detail is substantive, not a thin or placeholder block", () => {
  // The block alone carries more words than the whole measured page used to
  // (79): a content floor, not an exact-count gate.
  assert.ok(
    strippedWords(infoSection).length >= 120,
    `sign-in info section must carry substantive copy, found ${strippedWords(infoSection).length} words`,
  );
  // No filler, placeholder, or unresolved template tokens.
  assert.doesNotMatch(infoSection, /lorem ipsum/i);
  assert.doesNotMatch(infoSection, /TODO|PLACEHOLDER|YOUR_BOT_ID|YOUR_PUBLIC_WIDGET_KEY/i);
});

test("the sign-in detail stays truthful and free of unsupported parity claims", () => {
  // The product truth boundaries: no helpdesk, CRM, native-integration,
  // compliance, or automated-workflow promises anywhere in the sign-in copy.
  assert.doesNotMatch(infoSection, /helpdesk|full help desk/i);
  assert.doesNotMatch(infoSection, /native CRM|CRM sync/i);
  assert.doesNotMatch(infoSection, /native integration/i);
  assert.doesNotMatch(infoSection, /SOC 2|HIPAA|GDPR compliant|zero-retention/i);
  assert.doesNotMatch(infoSection, /automated workflow|workflow execution/i);
  // The access key language matches the emailed product truth and explicitly
  // says the one-use view link is never a substitute for the key.
  assert.match(infoSection, /never a\s*substitute for the key/, "the view link must be called out as no key substitute");
});

test("sign-in detail never leaks into the public marketing surface", () => {
  // The marketing branch before the sign-in gate must not render the
  // sign-in-only section.
  const marketingStart = appSource.indexOf("showPublicMarketingSurface ? (");
  assert.ok(marketingStart >= 0, "public marketing gate must exist");
  const marketingBranch = appSource.slice(marketingStart, infoGateStart);
  assert.doesNotMatch(marketingBranch, /signin-surface-info/, "public home must not render sign-in detail");
  assert.doesNotMatch(marketingBranch, /What the dashboard includes/, "public home must not render sign-in headings");
});
