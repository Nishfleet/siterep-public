import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

const teaserStart = appSource.indexOf("function PublicTeaser");
const teaserEnd = appSource.indexOf("function ChatPreview");
assert.ok(teaserStart >= 0, "PublicTeaser must exist");
assert.ok(teaserEnd > teaserStart, "PublicTeaser must close before ChatPreview");
const teaser = appSource.slice(teaserStart, teaserEnd);

const sectionStart = teaser.indexOf('<section className="public-detail-section" id="how-answers-work"');
const sectionEnd = teaser.indexOf('<section className="interest-section" id="invitation"');
assert.ok(sectionStart >= 0, "answer-path section must exist in the public teaser");
assert.ok(sectionEnd > sectionStart, "answer-path section must sit before the invitation section");
const answerPathSection = teaser.slice(sectionStart, sectionEnd);

const dataStart = teaser.indexOf("const answerPath = [");
const answerPathDataEnd = teaser.indexOf("const whoItIsFor = [");
const whoItIsForDataEnd = teaser.indexOf("const comparisonLinks = [");
assert.ok(dataStart >= 0 && answerPathDataEnd > dataStart, "answer-path data array must exist");
assert.ok(whoItIsForDataEnd > answerPathDataEnd, "who-it-is-for data array must exist");
const answerPathData = teaser.slice(dataStart, answerPathDataEnd);
const whoItIsForData = teaser.slice(answerPathDataEnd, whoItIsForDataEnd);
const answerPathCopy = `${answerPathData}\n${whoItIsForData}\n${answerPathSection}`;

const countWords = (text) => (text.match(/[A-Za-z0-9'’$%.-]+/g) || []).length;

test("answer-path section answers what the product is, who it is for, how citations work, weak-source behavior, and the next step", () => {
  assert.match(answerPathCopy, /What a visitor sees, from question to cited answer/);
  assert.match(answerPathCopy, /The visitor asks/);
  assert.match(answerPathCopy, /The rep checks your pages/);
  assert.match(answerPathCopy, /looks only inside the pages you approved and indexed/);
  assert.match(answerPathCopy, /The answer cites its source/);
  assert.match(answerPathCopy, /names the page it came from/);
  assert.match(answerPathCopy, /open that page to check the answer/);
  assert.match(answerPathCopy, /same citation appears in your private dashboard/);
  assert.match(answerPathCopy, /Missing backing becomes follow-up/);
  assert.match(answerPathCopy, /says it does not know/);
  assert.match(answerPathCopy, /follow-up queue with a suggested source title/);
  assert.match(answerPathCopy, /Small business sites/);
  assert.match(answerPathCopy, /Sales and service teams/);
  assert.match(answerPathCopy, /Agencies with client sites/);
  assert.match(answerPathCopy, /Start with your own site, free/);
  assert.match(answerPathCopy, /50 source-backed answers, no card, no time limit/);
  assert.match(answerPathCopy, /Lock the install domain, paste the script, and verify one live ping/);
});

test("answer-path section stays inside the supported-claim boundary", () => {
  const copy = answerPathCopy;
  assert.doesNotMatch(copy, /fastest|smartest|best in|number one/i);
  assert.doesNotMatch(copy, /\$\s?\d/);
  assert.doesNotMatch(copy, /helpdesk|ticket automation|native CRM|compliance|integration/i);
  assert.doesNotMatch(copy, /refus/i);
  assert.doesNotMatch(copy, /proof[- ]gap|unverified claims|workspace|pilot/i);
  assert.doesNotMatch(copy, /AI responses/i);
});

test("answer-path section keeps meaningful page-specific detail", () => {
  const prose = answerPathCopy.replace(/<[^>]+>/g, " ");
  assert.ok(
    countWords(prose) >= 120,
    `answer-path section must carry at least 120 words of visible detail (currently ${countWords(prose)})`,
  );
  assert.equal((answerPathData.match(/^ {4}\["/gm) || []).length, 4);
  assert.equal((whoItIsForData.match(/^ {4}\["/gm) || []).length, 3);
});

test("answer-path section placement keeps the earlier public sections above it", () => {
  assert.ok(
    teaser.indexOf('id="public-pricing"') < teaser.indexOf('id="how-it-works"'),
    "pricing must stay above the setup-detail section",
  );
  assert.ok(teaser.indexOf('id="how-it-works"') < sectionStart, "answer path must follow the setup-detail section");
  assert.ok(sectionEnd < teaser.indexOf('id="invitation"'), "answer path must sit before the invitation section");
});
