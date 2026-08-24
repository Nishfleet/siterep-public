import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { answerFromSources } from "../server/search.js";
import { PUBLIC_DEMO_SOURCES } from "../worker/demo-sources.js";
import { runHonestyEvals } from "../worker/honesty-evals.js";

const DEMO_SOURCES = PUBLIC_DEMO_SOURCES.map((source) => ({
  ...source,
  excerpt: source.content.slice(0, 240),
  indexedAt: "2026-05-30T00:00:00.000Z",
}));

// Extract the renderHonestyMarkdown function body from the worker source so we
// can exercise it without a Wrangler runtime — same pattern as
// tests/honesty-check.test.js.
async function loadRenderer() {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));
  const { renderHonestyMarkdown } = new Function(
    `"use strict";\n${renderFn}\nreturn { renderHonestyMarkdown };`,
  )();
  return { renderHonestyMarkdown, worker };
}

test("honesty page includes a liability-safe positioning section with court rulings", async () => {
  const { renderHonestyMarkdown } = await loadRenderer();
  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  const markdown = renderHonestyMarkdown(evals);

  // The section header is present.
  assert.match(markdown, /## Why this matters: your business is liable for what your chatbot says/);

  // Air Canada 2024 case is cited with the correct case reference.
  assert.match(markdown, /Air Canada/i);
  assert.match(markdown, /2024 BCCRT 149/);
  assert.match(markdown, /Moffatt v\. Air Canada/);
  assert.match(markdown, /British Columbia Civil Resolution Tribunal/);

  // OLG Hamm May 2026 case is cited with the correct case reference.
  assert.match(markdown, /Hamm/);
  assert.match(markdown, /4 UKl 3\/25/);

  // The liability defense is connected to Site Rep's source-backed behavior.
  assert.match(markdown, /source-backed/i);
  assert.match(markdown, /approved pages/i);
  assert.match(markdown, /hands off/i);
});

test("honesty page liability copy includes the not-legal-advice disclaimer", async () => {
  const { renderHonestyMarkdown } = await loadRenderer();
  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  const markdown = renderHonestyMarkdown(evals);

  assert.match(markdown, /This is not legal advice/i);
  assert.match(markdown, /Talk to a lawyer/i);
});

test("honesty page liability copy does NOT overclaim liability protection", async () => {
  const { renderHonestyMarkdown } = await loadRenderer();
  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  const markdown = renderHonestyMarkdown(evals);

  // No false guarantees.
  assert.doesNotMatch(markdown, /100% liability/i);
  assert.doesNotMatch(markdown, /liability-free/i);
  assert.doesNotMatch(markdown, /guaranteed.*liability/i);
  assert.doesNotMatch(markdown, /eliminates.*liability/i);
  assert.doesNotMatch(markdown, /legal compliance certification/i);
  assert.doesNotMatch(markdown, /legal advice.*provide/i);
});

test("honesty page liability section interpolates live eval counts, not literals", async () => {
  const { renderHonestyMarkdown } = await loadRenderer();

  // Feed a synthetic eval result to prove the counts are interpolated.
  const synthetic = { shouldAnswer: { passed: 3, total: 7 }, shouldRefuse: { passed: 2, total: 5 } };
  const markdown = renderHonestyMarkdown(synthetic);

  assert.match(markdown, /3 of 7 should-answer questions answered from sources/);
  assert.match(markdown, /2 of 5 off-topic questions handed off instead of guessed/);
});

test("honesty page liability section renders through the markdown-to-HTML pipeline with court citations", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const renderFn = worker.slice(worker.indexOf("function renderHonestyMarkdown"), worker.indexOf("\nconst TRUST_PAGES"));
  const { renderHonestyMarkdown } = new Function(
    `"use strict";\n${renderFn}\nreturn { renderHonestyMarkdown };`,
  )();

  // Run through the Worker's own markdown -> HTML pipeline so assertions hold
  // against emitted HTML, not raw markdown — same pattern as
  // tests/honesty-check.test.js.
  const escapeHtmlFn = worker.slice(worker.indexOf("function escapeHtml"), worker.indexOf("\nfunction withVaryAccept"));
  const renderInlineHtmlFn = worker.slice(worker.indexOf("function renderInlineHtml"), worker.indexOf("\nfunction jsonLdScript"));
  const markdownBodyToHtmlFn = worker.slice(worker.indexOf("function markdownBodyToHtml"), worker.indexOf("\nfunction renderInlineHtml"));
  const { markdownBodyToHtml } = new Function(`"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\nreturn { markdownBodyToHtml };`)();

  const evals = runHonestyEvals(answerFromSources, DEMO_SOURCES);
  const html = markdownBodyToHtml(renderHonestyMarkdown(evals));

  // The liability section header renders as an <h2>.
  assert.match(html, /<h2[^>]*>Why this matters: your business is liable for what your chatbot says<\/h2>/);
  // Court citations survive the HTML pipeline.
  assert.match(html, /Air Canada/i);
  assert.match(html, /2024 BCCRT 149/);
  assert.match(html, /4 UKl 3\/25/);
  // The disclaimer is present in the rendered HTML.
  assert.match(html, /This is not legal advice/i);
});
