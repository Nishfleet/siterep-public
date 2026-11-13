import assert from "node:assert/strict";
import { test } from "node:test";
import { crawlPublicCloudSource, publicCloudSourceCandidate, sourcesFromFeedXml } from "../server/crawler.js";


test("crawler parses RSS and Atom feeds into indexed sources", () => {
  const rssSources = sourcesFromFeedXml(
    `<?xml version="1.0"?>
    <rss><channel>
      <item>
        <title>Refund policy update</title>
        <link>https://example.com/refunds</link>
        <description><![CDATA[Customers can request refunds within 14 days when the setup has not started. This policy is source-backed for support answers.]]></description>
      </item>
    </channel></rss>`,
    "https://example.com/feed.xml",
  );
  const atomSources = sourcesFromFeedXml(
    `<feed>
      <entry>
        <title>Installation notes</title>
        <link href="https://example.com/install" />
        <summary>Install Site Rep with one script tag, then verify a real-domain widget ping before treating the launch as ready.</summary>
      </entry>
    </feed>`,
    "https://example.com/atom.xml",
  );

  assert.equal(rssSources[0].sourceType, "feed");
  assert.equal(rssSources[0].url, "https://example.com/refunds");
  assert.match(rssSources[0].content, /refunds within 14 days/);
  assert.equal(atomSources[0].sourceType, "feed");
  assert.equal(atomSources[0].url, "https://example.com/install");
  assert.match(atomSources[0].content, /real-domain widget ping/);
});

test("crawler adapts public cloud source links without OAuth claims", async () => {
  const googleDoc = publicCloudSourceCandidate("https://docs.google.com/document/d/doc_123/edit");
  const googleSheet = publicCloudSourceCandidate("https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=7");
  const youtube = publicCloudSourceCandidate("https://youtu.be/video_123");
  const notion = publicCloudSourceCandidate("https://example.notion.site/Public-FAQ-123");

  assert.equal(googleDoc.provider, "Google Docs");
  assert.equal(googleDoc.fetchUrl, "https://docs.google.com/document/d/doc_123/export?format=txt");
  assert.equal(googleSheet.provider, "Google Sheets");
  assert.match(googleSheet.fetchUrl, /format=csv/);
  assert.equal(youtube.provider, "YouTube");
  assert.equal(youtube.url, "https://www.youtube.com/watch?v=video_123");
  assert.equal(notion.provider, "Notion");
  assert.equal(publicCloudSourceCandidate("https://example.com/pricing"), null);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("Refund Policy\nCustomers can request refunds within 14 days when setup has not started.", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const source = await crawlPublicCloudSource("https://docs.google.com/document/d/doc_123/edit");
    assert.equal(source.sourceType, "cloud");
    assert.equal(source.cloudProvider, "Google Docs");
    assert.equal(source.url, "https://docs.google.com/document/d/doc_123/edit");
    assert.match(source.content, /refunds within 14 days/);

    globalThis.fetch = async () =>
      new Response("<!doctype html><html><body><form>Sign in</form></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    await assert.rejects(
      () => crawlPublicCloudSource("https://docs.google.com/document/d/private_doc/edit"),
      /did not expose readable public text/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});


