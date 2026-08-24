import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Acceptance for backlog item #976: every public doc page renders a visible
// "Last updated: YYYY-MM-DD." stamp whose date equals the corresponding
// <lastmod> in public/sitemap.xml. A content edit that bumps one and not the
// other makes the page advertise stale freshness.

const SITEMAP_STAMPED_PATHS = [
  "/ai-website-chatbot-for-small-business",
  "/privacy",
  "/terms",
  "/honesty",
  "/docs/install",
  "/vs",
];

async function parseSitemapLastmods() {
  const xml = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const entries = {};
  for (const path of SITEMAP_STAMPED_PATHS) {
    const loc = `https://siterep.net${path}`;
    const locEscaped = loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`<loc>${locEscaped}</loc>\\s*<lastmod>([^<]+)</lastmod>`);
    const m = xml.match(re);
    assert.ok(m, `sitemap must list ${loc} with a <lastmod>`);
    entries[path] = m[1];
  }
  return entries;
}

test("every public doc page stamp matches its sitemap lastmod", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const installRecipes = await readFile(new URL("../server/install-recipes.js", import.meta.url), "utf8");
  const lastmods = await parseSitemapLastmods();

  // Map each path to the source file that holds its markdown and a fragment
  // unique enough to locate the stamp near it.
  const pageSources = {
    "/ai-website-chatbot-for-small-business": { src: worker, anchor: "# AI website chatbot for small business that answers from your own site" },
    "/privacy": { src: worker, anchor: "# Site Rep Privacy and Data Handling" },
    "/terms": { src: worker, anchor: "# Site Rep Terms" },
    "/honesty": { src: worker, anchor: "# The chatbot that says when it does not know" },
    "/vs": { src: worker, anchor: "# Site Rep comparisons" },
    "/docs/install": { src: installRecipes, anchor: "# Install Site Rep Docs Mode" },
  };

  for (const [path, { src, anchor }] of Object.entries(pageSources)) {
    const expectedDate = lastmods[path];
    const stamp = `Last updated: ${expectedDate}.`;
    // The stamp must appear in the source.
    assert.match(
      src,
      new RegExp(stamp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${path}: expected "${stamp}" (matching sitemap lastmod ${expectedDate}) in source`,
    );
    // The stamp must appear shortly after the H1 anchor (within 200 chars).
    const anchorIdx = src.indexOf(anchor);
    assert.ok(anchorIdx >= 0, `${path}: anchor "${anchor}" not found in source`);
    const stampIdx = src.indexOf(stamp, anchorIdx);
    assert.ok(
      stampIdx >= 0 && stampIdx < anchorIdx + 200,
      `${path}: "${stamp}" must appear within 200 chars of the H1 anchor`,
    );
  }
});
