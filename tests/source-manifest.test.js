import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { buildSourceManifest, isSourceRetrievable, retrievableSources, sourceManifestEntry } from "../server/source-manifest.js";
import { answerFromSources } from "../server/search.js";

const freshSource = {
  id: "install",
  title: "Install guide",
  url: "https://example.com/docs/install",
  excerpt: "Install the widget with one script tag.",
  content: "Install the widget with one script tag before the closing body tag.",
  contentFingerprint: "abc123",
  sourceType: "crawl",
  status: "indexed",
  indexedAt: "2026-06-29T00:00:00.000Z",
  freshnessStatus: "fresh",
  freshnessCheckedAt: "2026-06-29T01:00:00.000Z",
  etag: "\"v1\"",
  lastModified: "Mon, 29 Jun 2026 00:00:00 GMT",
  sitemapLastmod: "2026-06-29",
};

test("source manifests expose safe freshness and version metadata", () => {
  const manifest = buildSourceManifest({
    botId: "docs-bot",
    ownerEmail: "owner@example.com",
    sources: [
      freshSource,
      {
        id: "manual-upload",
        title: "PDF setup notes",
        url: "upload://setup.pdf",
        sourceType: "upload",
        contentType: "application/pdf",
        status: "indexed",
        freshnessStatus: "manual-review",
        contentR2Key: "bots/docs-bot/sources/private.txt",
      },
    ],
  });

  assert.equal(manifest.botId, "docs-bot");
  assert.equal(manifest.sourceCount, 2);
  assert.equal(manifest.retrievableCount, 2);
  assert.equal(manifest.sources[0].discovery, "crawler");
  assert.equal(manifest.sources[0].version.etag, "\"v1\"");
  assert.equal(manifest.sources[0].version.lastModified, "Mon, 29 Jun 2026 00:00:00 GMT");
  assert.equal(manifest.sources[0].version.sitemapLastmod, "2026-06-29");
  assert.equal(manifest.sources[1].discovery, "manual-upload");
  assert.equal(manifest.sources[1].version.contentR2Key, "stored-private");
});

test("manifest entries represent docs pages, sitemap, llms, PDFs, and manual uploads", () => {
  assert.equal(sourceManifestEntry({ ...freshSource, sitemapUrl: "https://example.com/sitemap.xml" }).discovery, "sitemap");
  assert.equal(sourceManifestEntry({ ...freshSource, llmsUrl: "https://example.com/llms.txt" }).discovery, "llms.txt");
  assert.equal(sourceManifestEntry({ ...freshSource, sourceType: "url" }).discovery, "exact-url");
  assert.equal(
    sourceManifestEntry({ title: "Uploaded PDF", url: "upload://guide.pdf", sourceType: "upload", contentType: "application/pdf" }).contentType,
    "application/pdf",
  );
  assert.equal(sourceManifestEntry({ title: "Manual note", sourceType: "manual" }).discovery, "manual");
});

test("stale or disabled sources are excluded from retrieval by default", () => {
  const changed = { ...freshSource, id: "changed", freshnessStatus: "changed" };
  const deleted = { ...freshSource, id: "deleted", status: "deleted" };
  const disabled = { ...freshSource, id: "disabled", enabled: false };
  const auditedUpload = {
    ...freshSource,
    id: "audited-upload",
    url: "upload://guide.pdf",
    sourceType: "upload",
    status: "needs-review",
    freshnessStatus: "manual-review",
  };

  assert.equal(isSourceRetrievable(freshSource), true);
  assert.equal(isSourceRetrievable(changed), false);
  assert.equal(isSourceRetrievable(deleted), false);
  assert.equal(isSourceRetrievable(disabled), false);
  assert.equal(isSourceRetrievable(auditedUpload), true);
  assert.deepEqual(retrievableSources([freshSource, changed, deleted, disabled, auditedUpload]).map((source) => source.id), ["install", "audited-upload"]);
});

test("retrieval refuses when only stale sources would answer", () => {
  const stale = { ...freshSource, freshnessStatus: "changed" };
  const result = answerFromSources("How do I install the widget?", retrievableSources([stale]));

  assert.equal(result.unknown, true);
  assert.equal(result.sources.length, 0);
});

test("public widget config exposes only aggregate source manifest fields", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const summary = worker.slice(worker.indexOf("function publicSourceManifestSummary"), worker.indexOf("function meterFor"));

  assert.match(summary, /sourceCount: manifest\.sourceCount/);
  assert.match(summary, /retrievableCount: manifest\.retrievableCount/);
  assert.match(summary, /staleCount: manifest\.staleCount/);
  assert.match(summary, /sourceTypes: countBy\("sourceType"\)/);
  assert.doesNotMatch(summary, /sources: manifest\.sources\.map/);
  assert.doesNotMatch(summary, /fingerprint|etag|lastModified|error|url:/);
});
