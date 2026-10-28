import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (url === "cloudflare:workers") {
      return {
        format: "module",
        source:
          "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { CiteRepCoordinator } = await import("../worker/index.js");

const NOW = new Date().toISOString();

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => {
      if (typeof key === "object" && key !== null) {
        for (const [innerKey, innerValue] of Object.entries(key)) map.set(innerKey, innerValue);
      } else {
        map.set(key, value);
      }
    },
    delete: async (key) => map.delete(key),
    list: async ({ prefix = "" } = {}) =>
      new Map([...map.entries()].filter(([entryKey]) => entryKey.startsWith(prefix))),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    _map: map,
  };
}

function fakeBucket(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key) => {
      if (!map.has(key)) return null;
      return { json: async () => structuredClone(map.get(key)) };
    },
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    _map: map,
  };
}

function makeBot(botId, overrides = {}) {
  return {
    botId,
    publicKey: "pk_test",
    ownerAccessKey: "ak_test",
    label: botId,
    ownerEmail: `owner@${botId}.test`,
    plan: "Pro",
    lifecycleStatus: "approved",
    siteUrl: "https://example.test/",
    createdAt: NOW,
    updatedAt: NOW,
    sources: [],
    leads: [],
    conversations: [],
    unknowns: [],
    escalations: [],
    tickets: [],
    notifications: [],
    events: [],
    crawlJobs: [],
    activeCrawlJobId: "",
    ...overrides,
  };
}

function makeCrawlJob(overrides = {}) {
  return {
    id: "job_1",
    type: "train",
    siteUrl: "https://example.test/",
    maxPages: 50,
    status: "queued",
    createdAt: NOW,
    attempts: 0,
    meta: {},
    error: "",
    ...overrides,
  };
}

async function runFailingCrawl({ bots, bucket, fetchError }) {
  const storage = fakeStorage({ store: { bots } });
  const coordinator = new CiteRepCoordinator({ storage }, { SITEREP_SOURCE_CONTENT: bucket || null });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw fetchError;
  };
  try {
    await coordinator.alarm();
  } finally {
    globalThis.fetch = originalFetch;
  }
  const bot = storage._map.get(`store:bot:${Object.keys(bots)[0]}`);
  return { bot, storage, bucket, coordinator };
}

test("crawl failure marks the job failed, clears the active id, notifies training_failed, leaves no pending job", async () => {
  const job = makeCrawlJob();
  const { bot, coordinator } = await runFailingCrawl({
    bots: { bot1: makeBot("bot1", { crawlJobs: [job] }) },
    bucket: fakeBucket(),
    fetchError: new Error("net: injected crawl failure"),
  });

  const failed = bot.crawlJobs.find((item) => item.id === job.id);
  assert.equal(failed.status, "failed", "job must be failed, not left running");
  assert.match(failed.error, /injected crawl failure/, "job must carry the crawl error");
  assert.notEqual(failed.finishedAt, "", "failed job must record when it finished");

  assert.equal(bot.activeCrawlJobId, "", "active crawl id must be cleared");

  const notification = (bot.notifications || []).find((item) => item.type === "training_failed");
  assert.ok(notification, "a training_failed owner notification must be queued");
  assert.equal(notification.title, "Training failed");
  assert.equal(notification.deliveryStatus, "pending");
  assert.equal(notification.dedupeKey, `training-failed:${job.id}`);

  const ticket = (bot.tickets || []).find((item) => item.dedupeKey === `training-failed:${job.id}`);
  assert.equal(ticket?.proofState, "training_failed", "install_issue ticket must carry proofState training_failed");

  assert.equal((bot.events || []).find((item) => item.title === "Training failed")?.type, "training");

  assert.equal(await coordinator.hasPendingCrawlJobs(), false, "no queued or running crawl job may remain after a failure");
});

test("mid-chunk resume failure marks the job failed, cleans the resume state, and still notifies", async () => {
  const resumeKey = "crawl-state/bot2/job_resume.json";
  const job = makeCrawlJob({
    id: "job_resume",
    status: "running",
    startedAt: NOW,
    attempts: 1,
    maxPages: 5000,
    meta: { hasResumeState: true, progressPages: 400 },
  });
  const bucket = fakeBucket({
    [resumeKey]: {
      queue: ["https://example.test/docs/401", "https://example.test/docs/402", "https://example.test/docs/403"],
      seen: [],
      sources: [],
      errors: [],
      discoveredFromSitemap: 0,
      robotsDisallow: [],
    },
  });
  const { bot, coordinator } = await runFailingCrawl({
    bots: { bot2: makeBot("bot2", { crawlJobs: [job], activeCrawlJobId: "job_resume" }) },
    bucket,
    fetchError: new Error("net: injected mid-chunk resume failure"),
  });

  const failed = bot.crawlJobs.find((item) => item.id === job.id);
  assert.equal(failed.status, "failed", "resumed chunk failure must fail the job, not leave it running");
  assert.match(failed.error, /injected mid-chunk resume failure/, "job must carry the resumed-chunk error");

  assert.equal(bot.activeCrawlJobId, "", "active crawl id must be cleared after a resume failure");

  const notification = (bot.notifications || []).find((item) => item.type === "training_failed");
  assert.ok(notification, "a training_failed owner notification must be queued after a resume failure");
  assert.equal(notification.deliveryStatus, "pending");
  assert.equal(notification.dedupeKey, `training-failed:job_resume`);

  assert.equal(bucket._map.has(resumeKey), false, "orphaned resume state must be deleted from the content bucket");

  assert.equal(await coordinator.hasPendingCrawlJobs(), false, "no queued or running crawl job may remain after a resume failure");
});
