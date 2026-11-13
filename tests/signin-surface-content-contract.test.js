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

test("the sign-in detail stays truthful and free of unsupported parity claims", () => {
  assert.doesNotMatch(infoSection, /helpdesk|full help desk/i);
  assert.doesNotMatch(infoSection, /native CRM|CRM sync/i);
  assert.doesNotMatch(infoSection, /native integration/i);
  assert.doesNotMatch(infoSection, /SOC 2|HIPAA|GDPR compliant|zero-retention/i);
  assert.doesNotMatch(infoSection, /automated workflow|workflow execution/i);
  assert.match(infoSection, /never a\s*substitute for the key/, "the view link must be called out as no key substitute");
});

