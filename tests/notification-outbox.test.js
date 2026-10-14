import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

// The worker bundle imports "cloudflare:workers"; Node has no Workers runtime, so this shim must be registered before the worker module loads.
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
const OUTBOX_ROUTE = new Request("https://siterep.test/api/internal/notifications/process", {
  method: "POST",
  headers: { "x-citerep-admin-key": "test-admin-key" },
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
    list: async ({ prefix = "" } = {}) =>
      new Map([...map.entries()].filter(([entryKey]) => entryKey.startsWith(prefix))),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    _map: map,
  };
}

function baseEnv(overrides = {}) {
  return {
    SITEREP_NOTIFY_ENABLED: "true",
    SITEREP_NOTIFY_PROVIDER: "cloudflare",
    EMAIL_FROM_EMAIL: "noreply@siterep.test",
    CITEREP_ADMIN_KEY: "test-admin-key",
    CITEREP_STORE: null,
    ...overrides,
  };
}

function makeBot(botId, { ownerEmail = `owner@${botId}.test` } = {}) {
  return {
    botId,
    publicKey: "pk_test",
    ownerAccessKey: "ak_test",
    label: botId,
    ownerEmail,
    plan: "Pro",
    lifecycleStatus: "live",
    siteUrl: "https://example.com",
    createdAt: NOW,
    updatedAt: NOW,
    sources: [],
    leads: [],
    conversations: [],
    unknowns: [],
    escalations: [],
    tickets: [],
    notifications: [],
    leadRules: { triggers: {}, notifyEmails: [], webhookUrl: "" },
    integrationSettings: { enabledEvents: [], webhooks: [], nativeTargets: [] },
    actionQueue: [],
    payments: [],
    billing: { provider: "dodo", customerId: `cus_${botId}` },
    events: [],
    installs: [],
    allowedOrigins: ["https://example.com"],
    routingProfile: "frugal",
    retrieval: {},
    abuseProtection: {},
    widgetSettings: {},
    responseCount: 0,
    responseUsageMonth: NOW.slice(0, 7),
    overage: { enabled: false, maxExtraPerMonth: 0, pending: [] },
    trainingRuns: [],
    crawlJobs: [],
    sourceSync: {},
  };
}

function makeNotification(overrides = {}) {
  return {
    id: "note_test_1",
    type: "team_notification.created",
    title: "Test notification",
    detail: "Something happened that the owner should know about.",
    priority: "normal",
    channel: "email",
    deliveryStatus: "pending",
    attempts: 0,
    lastError: "",
    nextAttemptAt: "",
    dedupeKey: "team_notification.created:Test notification:Something happened that the owner should know about.",
    meta: {},
    createdAt: NOW,
    updatedAt: NOW,
    sentAt: "",
    ...overrides,
  };
}

const RETRY_WINDOW_MS = 120 * 1000;

function assertBackoffAround(expectedMs, actualIso, message) {
  const delta = Date.parse(actualIso) - Date.now();
  assert.ok(
    delta > expectedMs - RETRY_WINDOW_MS && delta < expectedMs + RETRY_WINDOW_MS,
    `${message}: expected backoff near ${expectedMs}ms, got ${delta}ms`,
  );
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function driveOutbox({ bots, env = baseEnv(), emailSend = null, fetchImpl = null }) {
  const storage = fakeStorage({ store: { bots } });
  const coordinator = new CiteRepCoordinator({ storage }, env);
  const emailCalls = [];
  env.EMAIL = {
    send: async (message) => {
      emailCalls.push(message);
      if (!emailSend) throw new Error("EMAIL.send called but the test did not stub it");
      return await emailSend(message);
    },
  };
  if (fetchImpl) {
    globalThis.fetch = async (url, init) => fetchImpl(url, init);
  }
  const response = await coordinator.fetch(OUTBOX_ROUTE);
  const body = await response.json();
  const notificationsOf = (botId) => {
    const record = storage._map.get(`store:bot:${botId}`);
    return Array.isArray(record?.notifications) ? record.notifications : [];
  };
  return { http: response.status, body, emailCalls, notificationsOf };
}

test("provider throw keeps the notification failed — never sent, never dropped", async () => {
  const { http, body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [makeNotification()] } },
    emailSend: async () => {
      throw new Error("provider temporarily unavailable");
    },
  });

  assert.equal(http, 200);
  assert.deepEqual(body.notifications, { sent: 0, skipped: 0, failed: 1, checked: 1 });
  assert.equal(emailCalls.length, 1);
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "failed");
  assert.equal(record.attempts, 1);
  assert.match(record.lastError, /provider temporarily unavailable/);
  assert.notEqual(record.sentAt, undefined);
  assert.equal(record.sentAt, "");
  assertBackoffAround(2 * 60 * 1000, record.nextAttemptAt, "first backoff");
});

test("provider HTTP error (Plunk) keeps the notification failed", async () => {
  const { http, body, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [makeNotification()] } },
    env: baseEnv({
      SITEREP_NOTIFY_PROVIDER: "plunk",
      PLUNK_API_KEY: "sk_test_123",
      PLUNK_FROM_EMAIL: "noreply@siterep.test",
    }),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "provider error" }),
  });

  assert.equal(http, 200);
  assert.deepEqual(body.notifications, { sent: 0, skipped: 0, failed: 1, checked: 1 });
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "failed");
  assert.equal(record.attempts, 1);
  assert.match(record.lastError, /provider error/);
  assert.equal(record.sentAt, "");
});

test("provider success is the only path to sent", async () => {
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [makeNotification()] } },
    emailSend: async () => ({ ok: true }),
  });

  assert.deepEqual(body.notifications, { sent: 1, skipped: 0, failed: 0, checked: 1 });
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].to, "owner@bot1.test");
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "sent");
  assert.equal(record.attempts, 1);
  assert.equal(record.nextAttemptAt, "");
  assert.notEqual(record.sentAt, "");
});

test("failed notification is not re-delivered before its backoff time", async () => {
  const nextAttemptAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const seeded = makeNotification({ deliveryStatus: "failed", attempts: 1, lastError: "boom", nextAttemptAt });
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [seeded] } },
    emailSend: async () => {
      throw new Error("provider must not be called during backoff");
    },
  });

  assert.deepEqual(body.notifications, { sent: 0, skipped: 0, failed: 0, checked: 0 });
  assert.equal(emailCalls.length, 0);
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "failed");
  assert.equal(record.attempts, 1);
  assert.equal(record.nextAttemptAt, nextAttemptAt);
  assert.equal(record.sentAt, "");
});

test("failed notification retries after the backoff window and still never sends without provider success", async () => {
  const seeded = makeNotification({ deliveryStatus: "failed", attempts: 1, lastError: "boom", nextAttemptAt: isoMinutesAgo(60) });
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [seeded] } },
    emailSend: async () => {
      throw new Error("provider still down");
    },
  });

  assert.deepEqual(body.notifications, { sent: 0, skipped: 0, failed: 1, checked: 1 });
  assert.equal(emailCalls.length, 1);
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "failed");
  assert.equal(record.attempts, 2);
  assert.equal(record.sentAt, "");
  assertBackoffAround(10 * 60 * 1000, record.nextAttemptAt, "second backoff");
});

test("attempt exhaustion stops provider calls and keeps the event failed", async () => {
  const seeded = makeNotification({ deliveryStatus: "failed", attempts: 4, lastError: "boom", nextAttemptAt: isoMinutesAgo(5) });
  const first = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [seeded] } },
    emailSend: async () => {
      throw new Error("provider down");
    },
  });
  assert.deepEqual(first.body.notifications, { sent: 0, skipped: 0, failed: 1, checked: 1 });
  assert.equal(first.emailCalls.length, 1);
  const [afterFirst] = first.notificationsOf("bot1");
  assert.equal(afterFirst.deliveryStatus, "failed");
  assert.equal(afterFirst.attempts, 5);
  assert.equal(afterFirst.nextAttemptAt, "");
  assert.equal(afterFirst.sentAt, "");

  const second = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [afterFirst] } },
    emailSend: async () => {
      throw new Error("provider must not be called after exhaustion");
    },
  });
  assert.deepEqual(second.body.notifications, { sent: 0, skipped: 0, failed: 0, checked: 0 });
  assert.equal(second.emailCalls.length, 0);
  const [afterSecond] = second.notificationsOf("bot1");
  assert.equal(afterSecond.deliveryStatus, "failed");
  assert.equal(afterSecond.attempts, 5);
  assert.equal(afterSecond.sentAt, "");
});

test("pending event past the attempt ceiling is marked failed without any provider call", async () => {
  const seeded = makeNotification({ deliveryStatus: "pending", attempts: 5, nextAttemptAt: "" });
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [seeded] } },
    emailSend: async () => {
      throw new Error("provider must not be called for an exhausted event");
    },
  });

  assert.deepEqual(body.notifications, { sent: 0, skipped: 0, failed: 1, checked: 0 });
  assert.equal(emailCalls.length, 0);
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "failed");
  assert.equal(record.lastError, "max_attempts_reached");
  assert.equal(record.attempts, 5);
  assert.equal(record.sentAt, "");
});

test("stuck sending claim older than the stuck window is recovered and delivers", async () => {
  const seeded = makeNotification({
    deliveryStatus: "sending",
    attempts: 0,
    updatedAt: isoMinutesAgo(11),
  });
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [seeded] } },
    emailSend: async () => ({ ok: true }),
  });

  assert.deepEqual(body.notifications, { sent: 1, skipped: 0, failed: 0, checked: 1 });
  assert.equal(emailCalls.length, 1);
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "sent");
  assert.equal(record.attempts, 1);
  assert.notEqual(record.sentAt, "");
});

test("stuck sending claim recovers but stays failed when the provider throws", async () => {
  const seeded = makeNotification({
    deliveryStatus: "sending",
    attempts: 0,
    updatedAt: isoMinutesAgo(11),
  });
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [seeded] } },
    emailSend: async () => {
      throw new Error("provider down after crash recovery");
    },
  });

  assert.deepEqual(body.notifications, { sent: 0, skipped: 0, failed: 1, checked: 1 });
  assert.equal(emailCalls.length, 1);
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "failed");
  assert.equal(record.attempts, 1);
  assert.equal(record.sentAt, "");
});

test("a fresh in-flight sending claim is not re-claimed", async () => {
  const updatedAt = isoMinutesAgo(1);
  const seeded = makeNotification({ deliveryStatus: "sending", attempts: 0, updatedAt });
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [seeded] } },
    emailSend: async () => {
      throw new Error("provider must not be called for an in-flight claim");
    },
  });

  assert.deepEqual(body.notifications, { sent: 0, skipped: 0, failed: 0, checked: 0 });
  assert.equal(emailCalls.length, 0);
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "sending");
  assert.equal(record.updatedAt, updatedAt);
});

test("mixed run persists per-bot receipts: sent only where the provider succeeded", async () => {
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: {
      bot1: { ...makeBot("bot1", { ownerEmail: "ok@bot1.test" }), notifications: [makeNotification({ id: "note_ok" })] },
      bot2: { ...makeBot("bot2", { ownerEmail: "down@bot2.test" }), notifications: [makeNotification({ id: "note_down" })] },
    },
    emailSend: async (message) => {
      if (message.to === "ok@bot1.test") return { ok: true };
      throw new Error("provider down for bot2");
    },
  });

  assert.deepEqual(body.notifications, { sent: 1, skipped: 0, failed: 1, checked: 2 });
  assert.equal(emailCalls.length, 2);
  const [okRecord] = notificationsOf("bot1");
  const [downRecord] = notificationsOf("bot2");
  assert.equal(okRecord.deliveryStatus, "sent");
  assert.notEqual(okRecord.sentAt, "");
  assert.equal(downRecord.deliveryStatus, "failed");
  assert.equal(downRecord.sentAt, "");
});

test("disabled provider leaves the event pending — never sent, never dropped", async () => {
  const seeded = makeNotification();
  const { body, emailCalls, notificationsOf } = await driveOutbox({
    bots: { bot1: { ...makeBot("bot1"), notifications: [seeded] } },
    env: baseEnv({ SITEREP_NOTIFY_ENABLED: "" }),
    emailSend: async () => {
      throw new Error("provider must not be called when notifications are disabled");
    },
  });

  assert.deepEqual(body.notifications, { sent: 0, skipped: 1, failed: 0, checked: 1 });
  assert.equal(emailCalls.length, 0);
  const [record] = notificationsOf("bot1");
  assert.equal(record.deliveryStatus, "pending");
  assert.equal(record.attempts, 0);
  assert.equal(record.sentAt, "");
});
