import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("worker queues crawler jobs instead of crawling inside the train request", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /async alarm\(\)\s*{\s*try\s*{\s*await this\.processCrawlQueue\(\);/);
  // Chunked crawls keep each alarm invocation under the subrequest cap and
  // resume across alarms via R2-persisted state.
  assert.match(worker, /const CRAWL_CHUNK_PAGES = 400/);
  assert.match(worker, /const CRAWL_JOB_MAX_ATTEMPTS = 3/);
  assert.match(worker, /hasResumeState/);
  assert.match(worker, /crawlResumeStateKey/);
  assert.match(worker, /touchCrawlJobProgress/);
  assert.match(worker, /queueCrawlJob\(record,\s*{\s*type:\s*"train"/);
  assert.match(worker, /queueCrawlJob\(record,\s*{\s*type:\s*"retrain"/);
  assert.match(worker, /await scheduleCrawlQueue\(\);/);
  assert.doesNotMatch(worker, /url\.pathname === "\/api\/train"[\s\S]{0,700}await crawlSite/);
  assert.doesNotMatch(worker, /url\.pathname === "\/api\/retrain"[\s\S]{0,700}await crawlSite/);
});

test("crawler completion preserves manual and imported URL sources", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /function mergeCrawlSources/);
  assert.match(worker, /function trimSourcesToPlan/);
  assert.match(worker, /source\.sourceType \|\| "crawl"\) === "crawl"/);
  assert.match(worker, /bot\.sources = await offloadSourceContents\(claimed\.botId, trimSourcesToPlan\(bot, mergeCrawlSources\(previousSources, crawl\.sources \|\| \[\]\)\), this\.env\)/);
});

test("completed crawls store a diff summary for retrain safety", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(worker, /function buildCrawlDiff/);
  assert.match(worker, /const diff = buildCrawlDiff\(previousSources, bot\.sources\)/);
  assert.match(worker, /job\.diff = diff/);
  assert.match(worker, /diff,\s+createdAt: now,/s);
  assert.match(app, /type CrawlDiff/);
  assert.match(app, /latestCrawlDiff/);
  assert.match(app, /Crawl diff/);
});
