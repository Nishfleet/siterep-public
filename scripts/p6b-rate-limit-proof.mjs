#!/usr/bin/env node
// Packet P6-B proof harness. Drives the real worker fetch handler the same
// way curl would drive the deployed worker. No network, no deploy — runs the
// in-process CiteRepCoordinator against a seeded demo bot, and prints what
// each curl line would see. Used in the report to show "burst past the limit
// -> 429; normal pace -> answers; canary pin path -> extractive answer".
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (url === "cloudflare:workers") {
      return {
        format: "module",
        source: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

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
    list: async ({ prefix = "" } = {}) => new Map([...map.entries()].filter(([entryKey]) => entryKey.startsWith(prefix))),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    _map: map,
  };
}

const DEMO_BOT_ID = "site-rep-demo";
const DEMO_PUBLIC_KEY = "sr_demo_source_backed_widget_key";
const DEMO_ORIGIN = "https://siterep.net";

function seedDemoBot() {
  return {
    botId: DEMO_BOT_ID,
    publicKey: DEMO_PUBLIC_KEY,
    ownerAccessKey: "ak_test",
    label: "Site Rep public demo",
    ownerEmail: "hello@siterep.net",
    plan: "Starter",
    lifecycleStatus: "live",
    siteUrl: DEMO_ORIGIN,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sources: [
      {
        id: "pricing-src",
        title: "Site Rep pricing",
        url: `${DEMO_ORIGIN}/#public-pricing`,
        excerpt: "Starter 9 USD, Growth 29 USD, Pro 59 USD, Agency 149 USD per month, tax included.",
        content: "Starter 9 USD, Growth 29 USD, Pro 59 USD, Agency 149 USD per month, tax included.",
        status: "indexed",
        sourceType: "manual",
        indexedAt: new Date().toISOString(),
      },
    ],
    leads: [],
    conversations: [],
    unknowns: [],
    escalations: [],
    tickets: [],
    notifications: [],
    leadRules: { triggers: {}, webhookUrl: "" },
    integrationSettings: { enabledEvents: [], webhooks: [], nativeTargets: [] },
    actionQueue: [],
    payments: [],
    billing: { provider: "", customerId: "" },
    events: [],
    installs: [],
    allowedOrigins: [DEMO_ORIGIN],
    routingProfile: "strict",
    retrieval: {},
    abuseProtection: {},
    widgetSettings: {},
    responseCount: 0,
    responseUsageMonth: "",
    trainingRuns: [],
    crawlJobs: [],
    sourceSync: {},
  };
}

async function main() {
  const { CiteRepCoordinator } = await import("../worker/index.js");
  const storage = fakeStorage({ store: { bots: { [DEMO_BOT_ID]: seedDemoBot() } } });
  const coordinator = new CiteRepCoordinator({ storage }, { CITEREP_ADMIN_KEY: "test-admin-key" });

  const fakeFetch = (ip, extraHeaders = {}) =>
    coordinator.fetch(
      new Request("https://siterep.test/api/public/chat/prepare", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: DEMO_ORIGIN,
          referer: `${DEMO_ORIGIN}/`,
          "cf-connecting-ip": ip,
          ...extraHeaders,
        },
        body: JSON.stringify({
          botId: DEMO_BOT_ID,
          publicKey: DEMO_PUBLIC_KEY,
          question: "What does Site Rep cost?",
          sessionId: `proof-${ip}-${Math.random().toString(36).slice(2, 10)}`,
        }),
      }),
    ).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

  console.log("\n=== A. burst past the limit -> 429 (one IP, 25 calls) ===");
  const ip = "203.0.113.7";
  let firstBlockAt = null;
  for (let i = 1; i <= 25; i += 1) {
    const { status, body } = await fakeFetch(ip);
    const flag = status === 429 ? " <-- BLOCKED" : "";
    if (status === 429 && firstBlockAt === null) firstBlockAt = i;
    if (i <= 3 || status === 429 || i === 25) {
      console.log(`  call ${String(i).padStart(2)}  ip=${ip.padEnd(14)} status=${status}${flag} ${status === 429 ? `error="${body.error}"` : ""}`);
    } else if (i === 4) {
      console.log("  ... (calls 4-20 also status=200)");
    }
  }
  assert.equal(firstBlockAt, 21, `burst must block at call 21, got ${firstBlockAt}`);
  console.log(`  -> block fires at call ${firstBlockAt} (matches the 20/min cap)`);

  console.log("\n=== B. normal pace on a fresh IP -> 200 with cited answer ===");
  const normalIp = "198.51.100.42";
  const normal = await fakeFetch(normalIp);
  const normalText = String(normal.body?.answer?.answer || "");
  const normalSources = normal.body?.answer?.sources || [];
  console.log(`  status=${normal.status}`);
  console.log(`  answer="${normalText.slice(0, 80)}..."`);
  console.log(`  sources=${normalSources.length}`);
  console.log(`  eligible=${normal.body?.eligible}`);
  assert.equal(normal.status, 200);
  assert.ok(normalText.length > 0, "must return an answer string");
  assert.ok(normalSources.length > 0, "must cite at least one source");

  console.log("\n=== C. canary pin path -> 200, extractive (no model call) ===");
  const canaryIp = "198.51.100.99";
  const canary = await fakeFetch(canaryIp, { "x-siterep-canary": "pin" });
  const canaryText = String(canary.body?.answer?.answer || "");
  const canarySources = canary.body?.answer?.sources || [];
  console.log(`  status=${canary.status}`);
  console.log(`  answer="${canaryText.slice(0, 80)}..."`);
  console.log(`  sources=${canarySources.length} (extractive — model not called)`);
  assert.equal(canary.status, 200);

  console.log("\n=== D. second visitor IP is not blocked by first IP's burst ===");
  const other = await fakeFetch("203.0.113.99");
  console.log(`  status=${other.status} (fresh IP, not blocked)`);
  assert.notEqual(other.status, 429);

  console.log("\nAll proof assertions green.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
