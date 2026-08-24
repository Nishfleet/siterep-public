import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Regression coverage for the buyer-intent conversion path: the Worker-served
// page at /ai-website-chatbot-for-small-business previously rendered with zero
// free-start / pricing / demo / sign-in controls. These tests pin that the
// page's product entries survive markdown -> HTML as REAL anchors (native
// navigation, no SPA hydration required) and that the page's honesty copy
// survives the same render.

// Product entries must render with their full href as the anchor target and a
// human label as the visible text. Raw path strings are never the visible CTA
// text — a developer URL as a clickable label is activation friction for a
// first-time buyer (same rule the /vs pages' free-start CTA already follows).
const PRODUCT_ENTRY_LINKS = [
  { href: "/?surface=free-start", label: "Start free" },
  { href: "/#public-pricing", label: "public pricing" },
  { href: "/#demo", label: "live demo" },
  { href: "/?surface=customer", label: "sign in" },
];

const workerSource = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

const extractBlock = (startNeedle, endNeedles) => {
  const start = workerSource.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} must exist`);
  let end = workerSource.length;
  for (const needle of endNeedles) {
    const idx = workerSource.indexOf(needle, start + startNeedle.length);
    if (idx >= 0 && idx < end) end = idx;
  }
  return workerSource.slice(start, end);
};

// Run the Worker's own markdown -> HTML pipeline (the exact functions that
// serve the trust pages) so the assertions hold against emitted HTML, not the
// raw markdown source.
const escapeHtmlFn = extractBlock("function escapeHtml", ["\nfunction withVaryAccept"]);
const renderInlineHtmlFn = extractBlock("function renderInlineHtml", ["\nfunction jsonLdScript"]);
const markdownBodyToHtmlFn = extractBlock("function markdownBodyToHtml", ["\nfunction renderInlineHtml"]);
const { markdownBodyToHtml } = new Function(`"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\nreturn { markdownBodyToHtml };`)();

test("buyer-intent page renders visible product-entry controls as real anchors", () => {
  const markdown = extractBlock("const BUYER_INTENT_MARKDOWN = `", ["\n`;"]);
  const html = markdownBodyToHtml(markdown);

  // The conversion section is a visible heading in the served HTML.
  const sectionStart = html.indexOf("<h2>Try Site Rep free</h2>");
  assert.ok(sectionStart >= 0, "buyer-intent page must render a Try Site Rep free section");

  // Every product entry is a real anchor whose href is the full entry URL —
  // activation works through native link semantics without SPA hydration,
  // and the visible text is a human label, never the raw URL string.
  for (const { href, label } of PRODUCT_ENTRY_LINKS) {
    assert.ok(
      html.includes(`<a href="${href}">${label}</a>`),
      `buyer-intent page must render ${href} as a real product-entry anchor`,
    );
  }

  // The section linkifies exactly the product entries — no partial `/` link
  // residue (which would silently drop a query or fragment on click).
  const section = html.slice(sectionStart, html.indexOf("<h2>Useful links</h2>", sectionStart));
  assert.equal(
    section.match(/href="/g)?.length ?? 0,
    PRODUCT_ENTRY_LINKS.length,
    "the Try Site Rep free section must linkify exactly the product entries",
  );
  assert.doesNotMatch(section, /href="\/">\/<\/a>/, "no entry may degrade to a bare homepage link");

  // No product entry may degrade to the raw URL as its visible label.
  assert.doesNotMatch(
    section,
    /<a href="\/(?:#public-pricing|#demo|\?surface=customer)">\/(?:#public-pricing|#demo|\?surface=customer)<\/a>/,
    "no entry may show the raw URL as its link text",
  );

  // The page's honest not-included copy survives the same render, directly
  // after the CTA section.
  const honestySection = html.slice(html.indexOf("<h2>What is not included today</h2>"), sectionStart);
  assert.match(honestySection, /Site Rep is not a full helpdesk\./);
  assert.match(honestySection, /Site Rep does not include native CRM sync or private cloud folder sync\./);
  assert.match(honestySection, /Site Rep does not promise a guaranteed conversion lift or automated ticket-system execution\./);
});

test("the Worker linkifier emits the buyer page's demo and sign-in entries as real anchors", () => {
  // The durable homepage entries the buyer page points at must be in the
  // linkifier allowlist so the rendered HTML carries the full href.
  assert.match(workerSource, /#demo\|/, "the linkifier must turn /#demo into a real anchor");
  assert.match(workerSource, /\\\?surface=customer/, "the linkifier must turn /?surface=customer into a real anchor");
  // ...while the existing free-start entries keep their established shape.
  assert.match(workerSource, /\\\?surface=free-start/, "the linkifier must keep /?surface=free-start linkified");
  assert.match(workerSource, /#free-start\|\\\?surface=free-start\)\?/, "the linkifier must keep the legacy /#free-start hash next to the query entry");
});

test("buyer page useful-links carry human labels, never the raw path as link text", () => {
  const markdown = extractBlock("const BUYER_INTENT_MARKDOWN = `", ["\n`;"]);
  const html = markdownBodyToHtml(markdown);

  const usefulStart = html.indexOf("<h2>Useful links</h2>");
  assert.ok(usefulStart >= 0, "buyer-intent page must render a Useful links section");
  const useful = html.slice(usefulStart);

  // Same human-label rule as the CTA section: the visible text is a label,
  // never the raw developer path, while the href stays the exact entry.
  assert.ok(useful.includes('<a href="/">Homepage and live demo</a>'), "the homepage entry must render with a human label");
  assert.ok(useful.includes('<a href="/trust">Trust and data handling</a>'), "the trust entry must render with a human label");
  assert.ok(useful.includes('<a href="/privacy">Privacy</a>'), "the privacy entry must render with a human label");
  assert.ok(useful.includes('<a href="/terms">Terms</a>'), "the terms entry must render with a human label");
  assert.doesNotMatch(useful, />\/<\/a>/, "the homepage link text must never be the raw root path");
  assert.doesNotMatch(useful, />\/trust<\/a>/, "the trust link text must never be the raw path");
  assert.doesNotMatch(useful, />\/privacy<\/a>/, "the privacy link text must never be the raw path");
  assert.doesNotMatch(useful, />\/terms<\/a>/, "the terms link text must never be the raw path");
});
