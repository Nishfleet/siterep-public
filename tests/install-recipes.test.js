import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { INSTALL_RECIPE_PLATFORMS, INSTALL_RECIPES, canonicalEmbedSnippet, renderInstallRecipesMarkdown } from "../server/install-recipes.js";

test("install recipe matrix covers every requested host", () => {
  assert.deepEqual(INSTALL_RECIPE_PLATFORMS, [
    "mintlify",
    "docusaurus",
    "gitbook",
    "static-docs",
    "webflow",
    "framer",
    "generic",
    "wordpress",
  ]);
  assert.deepEqual(INSTALL_RECIPES.map((recipe) => recipe.id), INSTALL_RECIPE_PLATFORMS);

  const gitbook = INSTALL_RECIPES.find((recipe) => recipe.id === "gitbook");
  assert.equal(gitbook.status, "not-directly-installable");
  assert.match(gitbook.notes.join(" "), /ingest public GitBook pages as approved sources/);
});

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

  // The guide must hand readers the bot id, widget key, and allowed-domain
  // lock path: dashboard values come from the free-start signup or the
  // customer sign-in, and the placeholders must not be publishable as-is.
  assert.match(markdown, /\[Start free\]\(\/\?surface=free-start\)/);
  assert.match(markdown, /\[sign in\]\(\/\?surface=customer\)/);
  assert.match(markdown, /dashboard shows your bot ID, public widget key, allowed install domains/);
  assert.match(markdown, /Replace `YOUR_BOT_ID` and `YOUR_PUBLIC_WIDGET_KEY`/);
  assert.match(markdown, /install proof only after the published domain sends one widget ping/);
});

test("Worker exposes a real docs install page", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");

  assert.match(worker, /renderInstallRecipesMarkdown/);
  assert.match(worker, /"\/docs\/install"/);
  assert.match(worker, /Install Site Rep Docs Mode/);
  assert.match(worker, /<pre><code/);
  assert.match(worker, /line\.startsWith\("```"\)/);
  assert.match(sitemap, /https:\/\/siterep\.net\/docs\/install/);
  assert.match(llms, /Docs Mode install guide at \/docs\/install/);
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
  const slugifyFn = extractBlock("function slugify", ["\n// The Docs Mode install guide"]);
  const docsInstallBodyFn = extractBlock("function docsInstallBody", ["\nfunction escapeHtml"]);
  const { docsInstallBody } = new Function(
    `"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\n${slugifyFn}\n${docsInstallBodyFn}\nreturn { docsInstallBody };`,
  )();

  const markdown = renderInstallRecipesMarkdown();
  const html = docsInstallBody(markdown);

  // Every host section is an anchored h2 (id from the human label).
  for (const label of ["Mintlify", "Docusaurus", "GitBook", "Static docs", "Webflow", "Framer", "Generic sites", "WordPress"]) {
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    assert.ok(html.includes(`<h2 id="${id}">${label}</h2>`), `host section ${label} must carry its anchor id`);
  }

  // The jump nav lists every host as a same-page anchor link.
  assert.match(html, /<nav class="host-jump" aria-label="Jump to a host">/);
  assert.match(html, /Jump to a host:/);
  for (const label of ["Mintlify", "Docusaurus", "Webflow", "WordPress"]) {
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    assert.ok(html.includes(`<a href="#${id}">${label}</a>`), `jump nav must link ${label}`);
  }
  // The nav sits right after the h1, before the first host section.
  assert.ok(html.indexOf("<nav class=\"host-jump\"") > html.indexOf("<h1>"), "jump nav must come after the h1");
  assert.ok(html.indexOf("<nav class=\"host-jump\"") < html.indexOf("<h2 id=\"mintlify\">"), "jump nav must come before the first host section");
});

test("docs install page wraps long snippets instead of overflowing the viewport", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  // The canonical single-line snippet must wrap on narrow screens: pre and code
  // get pre-wrap + anywhere overflow, and the jump nav is styled for readability.
  assert.match(worker, /pre\{background:#111614;color:white;border-radius:8px;overflow:auto;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere\}/);
  assert.match(worker, /code\{font-family:"SFMono-Regular",Consolas,monospace;font-size:\.88rem;white-space:pre-wrap;overflow-wrap:anywhere\}/);
  assert.match(worker, /\.host-jump\{background:#eef4f0/);
});

test("dashboard install handoff uses single-script recipes", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /data-bot-id="\$\{botId\}"/);
  assert.match(app, /data-public-key="\$\{widgetKey\}"/);
  assert.match(app, /data-mode="\$\{widgetSettings\.mode\}"/);
  assert.match(app, /data-hotkey="\$\{widgetSettings\.hotkey/);
  assert.match(app, /Hosted install is not directly supported/);
  assert.match(app, /Mintlify/);
  assert.match(app, /Docusaurus/);
  assert.match(app, /Webflow/);
  assert.doesNotMatch(app, /window\.siterep = \{/);
});
