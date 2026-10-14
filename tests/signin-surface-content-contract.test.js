import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

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
  assert.match(infoSection, /What the dashboard includes/);
  assert.match(infoSection, /Signing in/);
  assert.match(infoSection, /Help and public pages/);
  assert.match(infoSection, /Leads/);
  assert.match(infoSection, /Conversations/);
  assert.match(infoSection, /Unknown questions/);
  assert.match(infoSection, /Source gaps/);
  assert.match(infoSection, /Install health/);
  assert.match(infoSection, /Private exports/);
  assert.match(infoSection, /Deletion-review requests/);
  assert.match(infoSection, /Your Site ID and dashboard access key are in the email titled/);
  assert.match(infoSection, /one-use view link/);
  assert.match(infoSection, /read-only view/);
  assert.match(infoSection, /href="\/honesty"/);
  assert.match(infoSection, /href="\/trust"/);
  assert.match(infoSection, /href="\/docs\/install"/);
  assert.match(infoSection, /mailto:hello@siterep\.net/);
});

test("the sign-in detail is substantive, not a thin or placeholder block", () => {
  assert.ok(
    strippedWords(infoSection).length >= 120,
    `sign-in info section must carry substantive copy, found ${strippedWords(infoSection).length} words`,
  );
  assert.doesNotMatch(infoSection, /lorem ipsum/i);
  assert.doesNotMatch(infoSection, /TODO|PLACEHOLDER|YOUR_BOT_ID|YOUR_PUBLIC_WIDGET_KEY/i);
});

test("the sign-in detail stays truthful and free of unsupported parity claims", () => {
  assert.doesNotMatch(infoSection, /helpdesk|full help desk/i);
  assert.doesNotMatch(infoSection, /native CRM|CRM sync/i);
  assert.doesNotMatch(infoSection, /native integration/i);
  assert.doesNotMatch(infoSection, /SOC 2|HIPAA|GDPR compliant|zero-retention/i);
  assert.doesNotMatch(infoSection, /automated workflow|workflow execution/i);
  assert.match(infoSection, /never a\s*substitute for the key/, "the view link must be called out as no key substitute");
});

test("sign-in detail never leaks into the public marketing surface", () => {
  const marketingStart = appSource.indexOf("showPublicMarketingSurface ? (");
  assert.ok(marketingStart >= 0, "public marketing gate must exist");
  const marketingBranch = appSource.slice(marketingStart, infoGateStart);
  assert.doesNotMatch(marketingBranch, /signin-surface-info/, "public home must not render sign-in detail");
  assert.doesNotMatch(marketingBranch, /What the dashboard includes/, "public home must not render sign-in headings");
});
