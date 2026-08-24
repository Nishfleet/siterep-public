import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("TERMS_MARKDOWN hard-wrapped lines render as single paragraphs", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

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

  const termsMarkdown = extractBlock("const TERMS_MARKDOWN = `", ["\n`;"]);
  const html = markdownBodyToHtml(termsMarkdown);

  assert.doesNotMatch(html, /locked,<\/p><p>the widget/);
  assert.match(html, /locked, the widget is opened/);
  assert.doesNotMatch(html, /include<\/p><p>complete helpdesk/);
  assert.match(html, /does not include complete helpdesk replacement/);
  assert.doesNotMatch(html, /including any<\/li><\/ul><p>/);
  assert.doesNotMatch(html, /including any<\/p><p>applicable tax/);
  assert.match(html, /including any applicable tax, on the checkout page/);
  assert.match(html, /<h2>No warranty and limitation of liability<\/h2>/);
  assert.match(html, /&quot;as is&quot;/);
  assert.match(termsMarkdown, /"as is"/);
});
