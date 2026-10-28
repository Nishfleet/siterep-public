import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const MONTHS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};
const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December)";
const CHECKED_IN = new RegExp(`checked in ${MONTH} (\\d{4})`, "g");
const AS_OF = new RegExp(`as of ${MONTH} (\\d{4})`, "gi");
const VS_LEAVES = ["/vs/customgpt", "/vs/chatbase", "/vs/intercom-fin", "/vs/tidio-lyro", "/vs/webspeaker", "/vs/chatling"];

export async function collectPricingStamps() {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");

  const extractBlock = (startNeedle, endNeedles) => {
    const start = worker.indexOf(startNeedle);
    assert.ok(start >= 0, `${startNeedle} must exist`);
    let end = worker.length;
    for (const needle of endNeedles) {
      const idx = worker.indexOf(needle, start + startNeedle.length);
      if (idx >= 0 && idx < end) end = idx;
    }
    return worker.slice(start, end);
  };
  const escapeHtmlFn = extractBlock("function escapeHtml", ["\nfunction withVaryAccept"]);
  const renderInlineHtmlFn = extractBlock("function renderInlineHtml", ["\nfunction jsonLdScript"]);
  const markdownBodyToHtmlFn = extractBlock("function markdownBodyToHtml", ["\nfunction renderInlineHtml"]);
  const { markdownBodyToHtml } = new Function(`"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\nreturn { markdownBodyToHtml };`)();

  const registeredLeaves = [...worker.matchAll(/"(\/vs\/[^"]+)": \{/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(registeredLeaves)].sort(), [...VS_LEAVES].sort(), "every registered /vs/<competitor> leaf must be in the stamp set");

  const stamps = [];
  for (const path of VS_LEAVES) {
    const entryStart = worker.indexOf(`"${path}": {`);
    assert.ok(entryStart >= 0, `${path} must be a registered TRUST_PAGES entry`);
    const nameMatch = worker.slice(entryStart, entryStart + 800).match(/markdown:\s*(VS_\w+_MARKDOWN)/);
    assert.ok(nameMatch, `${path} must point at a VS_*_MARKDOWN constant`);
    const html = markdownBodyToHtml(extractBlock(`const ${nameMatch[1]} = \``, ["\n`;"]));

    const checked = [...html.matchAll(CHECKED_IN)];
    assert.ok(checked.length >= 1, `${path} must render a "checked in <Month YYYY>" stamp`);
    const [, checkedMonth, checkedYear] = checked[0];
    for (const extra of checked.slice(1)) {
      assert.equal(`${extra[1]} ${extra[2]}`, `${checkedMonth} ${checkedYear}`, `${path} must not mix checked-in months`);
    }
    const asOf = [...html.matchAll(AS_OF)];
    assert.ok(asOf.length >= 1, `${path} must render an "as of <Month YYYY>" stamp`);
    for (const match of asOf) {
      assert.equal(`${match[1]} ${match[2]}`, `${checkedMonth} ${checkedYear}`, `${path} in-body "as of" stamp must match the pricing-note month`);
    }

    const loc = `https://siterep.net${path}`;
    const lastmodMatch = sitemap.match(new RegExp(`<loc>${loc.replaceAll(".", "\\.")}</loc>\\s*<lastmod>(\\d{4})-(\\d{2})-\\d{2}</lastmod>`));
    assert.ok(lastmodMatch, `${path} must have a sitemap lastmod`);
    stamps.push({
      path,
      month: MONTHS[checkedMonth],
      year: Number(checkedYear),
      lastmod: { year: Number(lastmodMatch[1]), month: Number(lastmodMatch[2]) },
    });
  }
  return stamps;
}
