import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

const STORE_PATH = process.env.CITEREP_STORE_PATH || resolve("data/store.json");

const emptyStore = {
  bots: {},
  signupRequests: [],
  interestLeads: [],
};

export async function readStore() {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return structuredClone(emptyStore);
  }
}

export async function writeStore(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

export async function updateStore(updater) {
  const store = await readStore();
  const result = await updater(store);
  await writeStore(store);
  return result;
}

export function ensureBot(store, botId) {
  if (!store.bots[botId]) {
    store.bots[botId] = {
      botId,
      publicKey: makePublicKey(),
      ownerAccessKey: makeOwnerAccessKey(),
      label: botId,
      ownerEmail: "",
      plan: "Starter",
      lifecycleStatus: "draft",
      siteUrl: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sources: [],
      leads: [],
      conversations: [],
      unknowns: [],
      escalations: [],
      events: [],
      installs: [],
      allowedOrigins: [],
      routingProfile: "frugal",
      qualityRun: null,
      previousQualityRun: null,
      widgetSettings: {
        title: "Site Rep Assistant",
        welcomeMessage: "Ask about pricing, setup, or whether the team is a fit.",
        theme: "#1f8f5f",
        suggestedQuestions: ["What does it cost?", "How do I install it?", "Can it answer with sources?"],
      },
      responseCount: 0,
      trainingRuns: [],
    };
  }

  if (!store.bots[botId].publicKey) {
    store.bots[botId].publicKey = makePublicKey();
  }
  if (!store.bots[botId].ownerAccessKey) {
    store.bots[botId].ownerAccessKey = makeOwnerAccessKey();
  }
  if (!store.bots[botId].label) {
    store.bots[botId].label = botId;
  }
  if (!store.bots[botId].plan) {
    store.bots[botId].plan = "Starter";
  }
  if (!store.bots[botId].lifecycleStatus) {
    store.bots[botId].lifecycleStatus = "draft";
  }
  if (!Array.isArray(store.bots[botId].allowedOrigins)) {
    store.bots[botId].allowedOrigins = [];
  }
  if (!["frugal", "balanced", "strict"].includes(store.bots[botId].routingProfile)) {
    store.bots[botId].routingProfile = "frugal";
  }
  if (!("qualityRun" in store.bots[botId])) {
    store.bots[botId].qualityRun = null;
  }
  if (!("previousQualityRun" in store.bots[botId])) {
    store.bots[botId].previousQualityRun = null;
  }
  if (!Array.isArray(store.bots[botId].escalations)) {
    store.bots[botId].escalations = [];
  }
  if (!Array.isArray(store.bots[botId].events)) {
    store.bots[botId].events = [];
  }
  if (!store.bots[botId].widgetSettings) {
    store.bots[botId].widgetSettings = {
      title: "Site Rep Assistant",
      welcomeMessage: "Ask about pricing, setup, or whether the team is a fit.",
      theme: "#1f8f5f",
      suggestedQuestions: ["What does it cost?", "How do I install it?", "Can it answer with sources?"],
    };
  }

  return store.bots[botId];
}

function makePublicKey() {
  return `pk_${randomUUID().replace(/-/g, "")}`;
}

function makeOwnerAccessKey() {
  return `own_${randomUUID().replace(/-/g, "")}`;
}
