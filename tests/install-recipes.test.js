import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { canonicalEmbedSnippet, renderInstallRecipesMarkdown } from "../server/install-recipes.js";


test("canonical recipe snippet uses data attributes and Docs Mode config", () => {
  const snippet = canonicalEmbedSnippet({ botId: "bot_123", publicKey: "pk_123" });

  assert.match(snippet, /src="https:\/\/siterep\.net\/widget\.js"/);
  assert.match(snippet, /data-bot-id="bot_123"/);
  assert.match(snippet, /data-public-key="pk_123"/);
  assert.match(snippet, /data-api-base="https:\/\/siterep\.net"/);
  assert.match(snippet, /data-mode="docs"/);
  assert.match(snippet, /data-hotkey="mod\+k"/);
  assert.doesNotMatch(snippet, /ownerAccessKey|session|secret|token/i);
});

test("install markdown includes snippets, validation, domain lock, and source manifest notes", () => {
  const markdown = renderInstallRecipesMarkdown();

  for (const label of ["Mintlify", "Docusaurus", "GitBook", "Static docs", "Webflow", "Framer", "Generic sites"]) {
    assert.match(markdown, new RegExp(`## ${label}`));
  }
  assert.match(markdown, /Used N sources drawer/);
  assert.match(markdown, /allowed-domain lock|allowed-domain|allowed domains/i);
  assert.match(markdown, /source manifest/i);
  assert.match(markdown, /Hosted GitBook does not directly support arbitrary custom HTML, CSS, or JavaScript/);
});

test("install markdown leads readers to the activation surface, not a dead end", () => {
  const markdown = renderInstallRecipesMarkdown();

  assert.match(markdown, /\[Start free\]\(\/\?surface=free-start\)/);
  assert.match(markdown, /\[sign in\]\(\/\?surface=customer\)/);
  assert.match(markdown, /dashboard shows your bot ID, public widget key, allowed install domains/);
  assert.match(markdown, /Replace `YOUR_BOT_ID` and `YOUR_PUBLIC_WIDGET_KEY`/);
  assert.match(markdown, /install proof only after the published domain sends one widget ping/);
});


test("docs install page renders anchored host sections with a jump nav", async () => {
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
  const slugifyFn = extractBlock("function slugify", ["\nfunction docsInstallBody"]);
  const docsInstallBodyFn = extractBlock("function docsInstallBody", ["\nfunction escapeHtml"]);
  const { docsInstallBody } = new Function(
    `"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\n${slugifyFn}\n${docsInstallBodyFn}\nreturn { docsInstallBody };`,
  )();

  const markdown = renderInstallRecipesMarkdown();
  const html = docsInstallBody(markdown);

  for (const label of ["Mintlify", "Docusaurus", "GitBook", "Static docs", "Webflow", "Framer", "Generic sites", "WordPress"]) {
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    assert.ok(html.includes(`<h2 id="${id}">${label}</h2>`), `host section ${label} must carry its anchor id`);
  }

  assert.match(html, /<nav class="host-jump" aria-label="Jump to a host">/);
  assert.match(html, /Jump to a host:/);
  for (const label of ["Mintlify", "Docusaurus", "Webflow", "WordPress"]) {
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    assert.ok(html.includes(`<a href="#${id}">${label}</a>`), `jump nav must link ${label}`);
  }
  assert.ok(html.indexOf("<nav class=\"host-jump\"") > html.indexOf("<h1>"), "jump nav must come after the h1");
  assert.ok(html.indexOf("<nav class=\"host-jump\"") < html.indexOf("<h2 id=\"mintlify\">"), "jump nav must come before the first host section");
});


