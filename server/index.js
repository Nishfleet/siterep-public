import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
// Legacy local API only. Product routes that touch payments, customer activation,
// owner inbox, notification queues, or private exports are Worker-only.
// Use `npm run cf:dev` for local product testing so behavior matches Cloudflare.
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crawlSinglePage, crawlSite, normalizeUrl } from "./crawler.js";
import { answerFromSources, publicSource } from "./search.js";
import { ensureBot, readStore, updateStore } from "./store.js";

const PORT = Number(process.env.PORT || 8787);
const STATIC_ROOT = resolve("dist");
const STARTER_PAGE_LIMIT = 100;
const STARTER_RESPONSE_LIMIT = 1000;
const STARTER_PRICE_CENTS = 900;
const PLAN_LIMITS = Object.freeze({
  Starter: {
    priceCents: STARTER_PRICE_CENTS,
    botLimit: 1,
    pageLimit: STARTER_PAGE_LIMIT,
    responseLimit: STARTER_RESPONSE_LIMIT,
    monthlyRefreshLimit: 4,
    allowedOriginsLimit: 1,
    brandingLocked: true,
  },
  Growth: {
    priceCents: 2900,
    botLimit: 2,
    pageLimit: 1000,
    responseLimit: 4000,
    monthlyRefreshLimit: 12,
    allowedOriginsLimit: 3,
    brandingLocked: false,
  },
  Pro: {
    priceCents: 5900,
    botLimit: 5,
    pageLimit: 5000,
    responseLimit: 12000,
    monthlyRefreshLimit: 30,
    allowedOriginsLimit: 10,
    brandingLocked: false,
  },
  Agency: {
    priceCents: 14900,
    botLimit: 20,
    pageLimit: 10000,
    responseLimit: 40000,
    monthlyRefreshLimit: 100,
    allowedOriginsLimit: 50,
    brandingLocked: false,
  },
});
const SOURCE_AUDIT_TIMEOUT_MS = 6000;
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60_000;
const PUBLIC_RATE_LIMIT_MAX = 45;
const PUBLIC_LEAD_RATE_LIMIT_MAX = 10;
const PUBLIC_INSTALL_RATE_LIMIT_MAX = 120;
const PUBLIC_FEEDBACK_RATE_LIMIT_MAX = 60;
const PUBLIC_SIGNUP_RATE_LIMIT_MAX = 3;
const DEFAULT_ALLOWED_CORS_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "https://siterep.net",
  "https://www.siterep.net",
  "https://tinystudio.io",
  "https://www.tinystudio.io",
]);
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
});
const DEFAULT_WIDGET_SETTINGS = {
  title: "Site Rep Assistant",
  welcomeMessage: "Ask about pricing, setup, or whether the team is a fit.",
  theme: "#1f8f5f",
  suggestedQuestions: ["What does it cost?", "How do I install it?", "Can it answer with sources?"],
};
const ROUTING_PROFILES = new Set(["frugal", "balanced", "strict"]);
const publicChatHits = new Map();
const COVERAGE_CATEGORIES = [
  {
    key: "pricing",
    label: "Pricing",
    terms: ["price", "pricing", "cost", "plan", "subscription", "trial"],
    question: "What does it cost and which plan should I choose?",
    suggestedSourceTitle: "Pricing, plans, demo, or purchase policy",
  },
  {
    key: "install",
    label: "Install",
    terms: ["install", "setup", "script", "embed", "wordpress", "website"],
    question: "How do I install this on my website?",
    suggestedSourceTitle: "Install and setup guide",
  },
  {
    key: "security",
    label: "Security",
    terms: ["security", "privacy", "source", "proof", "safe", "hallucination"],
    question: "How do you keep answers accurate and source-cited?",
    suggestedSourceTitle: "Security, privacy, and source policy",
  },
  {
    key: "lead-capture",
    label: "Lead capture",
    terms: ["lead", "email", "contact", "demo", "buyer", "capture"],
    question: "Can this collect buyer leads for follow-up?",
    suggestedSourceTitle: "Lead capture and handoff workflow",
  },
  {
    key: "contact",
    label: "Contact",
    terms: ["contact", "demo", "call", "book", "support", "sales"],
    question: "Can I book a demo or talk to someone?",
    suggestedSourceTitle: "Contact, demo, and support page",
  },
  {
    key: "refund",
    label: "Refunds",
    terms: ["refund", "cancel", "cancellation", "money", "terms"],
    question: "Can I cancel or get a refund?",
    suggestedSourceTitle: "Refund and cancellation policy",
  },
  {
    key: "integrations",
    label: "Integrations",
    terms: ["integration", "api", "webhook", "wordpress", "shopify", "slack"],
    question: "Which integrations does this support?",
    suggestedSourceTitle: "Integration and platform support guide",
  },
];

const server = createServer(handleRequest);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Site Rep API running at http://127.0.0.1:${PORT}`);
  });
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (!setCors(request, response)) {
      sendJson(response, 403, { error: "CORS origin is not allowed." });
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Server error" });
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    const store = await readStore();
    sendJson(response, 200, {
      ok: true,
      runtime: "local-node",
      storage: "file",
      botCount: Object.keys(store.bots || {}).length,
      signupRequestCount: (store.signupRequests || []).length,
      interestCount: (store.interestLeads || []).length,
      adminAuth: {
        required: Boolean(configuredAdminKey()),
        unlocked: isAuthorizedAdmin(request, url),
      },
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  const authorization = await authorizeApiRequest(request, url);
  if (!authorization.ok) {
    sendJson(response, 401, {
      error: "Admin key required.",
      adminRequired: true,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/interest") {
    const store = await readStore();
    const leads = (store.interestLeads || []).map((lead) => ({
      id: lead.id,
      email: lead.email,
      source: lead.source || "public-home",
      status: lead.status || "new",
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
    }));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(leads));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/train") {
    const body = await readJson(request);
    const siteUrl = normalizeUrl(body.url);
    const botId = body.botId || botIdForUrl(siteUrl);
    const crawl = await crawlSite(siteUrl, body.maxPages || STARTER_PAGE_LIMIT);

    const bot = await updateStore((store) => {
      const record = ensureBot(store, botId);
      record.label = record.label || new URL(siteUrl).host;
      record.siteUrl = crawl.siteUrl;
      record.allowedOrigins = [...new Set([...(record.allowedOrigins || []), new URL(crawl.siteUrl).origin])];
      record.sources = crawl.sources;
      if (record.lifecycleStatus === "paused") record.lifecycleStatus = "draft";
      pushEvent(record, "training", "Website trained", `${crawl.sources.length} sources indexed from ${new URL(crawl.siteUrl).host}.`, {
        pageCount: crawl.sources.length,
        attemptedCount: crawl.meta?.attemptedCount || 0,
      });
      record.updatedAt = new Date().toISOString();
      record.trainingRuns.unshift({
        id: Date.now(),
        siteUrl: crawl.siteUrl,
        pageCount: crawl.sources.length,
        errors: crawl.errors,
        meta: crawl.meta,
        createdAt: new Date().toISOString(),
      });
      record.trainingRuns = record.trainingRuns.slice(0, 10);
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/retrain") {
    const body = await readJson(request);
    const store = await readStore();
    const current = store.bots[body.botId];
    if (!current?.siteUrl) {
      sendJson(response, 404, { error: "Train this bot before retraining." });
      return;
    }
    request.method = "POST";
    const crawl = await crawlSite(current.siteUrl, body.maxPages || STARTER_PAGE_LIMIT);
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, body.botId);
      record.sources = crawl.sources;
      pushEvent(record, "training", "Website retrained", `${crawl.sources.length} sources refreshed from ${new URL(current.siteUrl).host}.`, {
        pageCount: crawl.sources.length,
        attemptedCount: crawl.meta?.attemptedCount || 0,
      });
      record.updatedAt = new Date().toISOString();
      record.trainingRuns.unshift({
        id: Date.now(),
        siteUrl: current.siteUrl,
        pageCount: crawl.sources.length,
        errors: crawl.errors,
        meta: crawl.meta,
        createdAt: new Date().toISOString(),
      });
      record.trainingRuns = record.trainingRuns.slice(0, 10);
      return record;
    });
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/bots") {
    const store = await readStore();
    const bots = Object.values(store.bots || {}).map(toBotSummary).sort((a, b) => newestTime(b.updatedAt) - newestTime(a.updatedAt));
    sendJson(response, 200, bots);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bots/create") {
    const body = await readJson(request);
    const label = String(body.label || "").trim() || "New customer bot";
    const siteUrl = safeNormalizeSiteUrl(body.siteUrl);
    const botId = uniqueBotId(await readStore(), siteUrl ? botIdForUrl(siteUrl) : `starter-${slug(label) || "customer"}`);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, botId);
      record.label = label.slice(0, 72);
      record.ownerEmail = String(body.ownerEmail || "").trim().slice(0, 160);
      record.plan = normalizePlan(body.plan);
      record.lifecycleStatus = "draft";
      record.siteUrl = siteUrl;
      record.allowedOrigins = siteUrl ? [new URL(siteUrl).origin] : [];
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bots/clone") {
    const body = await readJson(request);
    const store = await readStore();
    const source = store.bots[body.botId];
    if (!source) {
      sendJson(response, 404, { error: "Bot not found." });
      return;
    }
    const label = String(body.label || `${source.label || source.botId} copy`).trim();
    const nextBotId = uniqueBotId(store, `${source.botId}-copy`);
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, nextBotId);
      record.label = label.slice(0, 72);
      record.ownerEmail = String(body.ownerEmail || source.ownerEmail || "").trim().slice(0, 160);
      record.plan = normalizePlan(body.plan || source.plan);
      record.lifecycleStatus = "draft";
      record.siteUrl = source.siteUrl || "";
      record.sources = structuredClone(source.sources || []);
      record.allowedOrigins = structuredClone(source.allowedOrigins || []);
      record.widgetSettings = sanitizeWidgetSettings({}, source.widgetSettings);
      record.sourceAudit = source.sourceAudit ? structuredClone(source.sourceAudit) : null;
      record.responseCount = 0;
      record.leads = [];
      record.conversations = [];
      record.unknowns = [];
      record.installs = [];
      record.trainingRuns = [];
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bots/reset-usage") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.responseCount = 0;
      record.usageResetAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bots/status") {
    const body = await readJson(request);
    const status = normalizeLifecycleStatus(body.status);
    if (!status) {
      sendJson(response, 400, { error: "Use draft, approved, live, or paused." });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      if (status === "live") {
        const blockers = publicLaunchBlockers(record);
        if (blockers.length) {
          return { error: `Cannot publish yet: ${blockers[0]}`, blockers };
        }
      }
      record.lifecycleStatus = status;
      pushEvent(record, "status", status === "live" ? "Bot published" : status === "paused" ? "Bot paused" : "Bot moved to draft", `Public widget status is now ${status}.`);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    if (bot?.error) {
      sendJson(response, 400, bot);
      return;
    }
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/routing/profile") {
    const body = await readJson(request);
    const profile = normalizeRoutingProfile(body.routingProfile);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.routingProfile = profile;
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/signup-requests") {
    const store = await readStore();
    sendJson(response, 200, (store.signupRequests || []).slice(0, 100));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/interest") {
    const body = await readJson(request);
    if (isSignupTrapFilled(body)) {
      sendJson(response, 200, acceptedSignupTrapResponse());
      return;
    }
    const email = String(body.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }
    const rateLimit = checkPublicRateLimit("interest", signupRateLimitKey(request, email, body.siteUrl || ""), "interest", PUBLIC_SIGNUP_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Interest capture is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }
    const lead = await updateStore((store) => {
      store.interestLeads ||= [];
      const existing = store.interestLeads.find((item) => String(item.email || "").toLowerCase() === email);
      const record = {
        id: existing?.id || Date.now(),
        email,
        source: String(body.source || "public-home").trim().slice(0, 80),
        status: existing?.status || "new",
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.interestLeads = [record, ...store.interestLeads.filter((item) => String(item.email || "").toLowerCase() !== email)].slice(0, 500);
      return record;
    });
    sendJson(response, 200, { ok: true, status: "joined", lead });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/signup-requests") {
    const body = await readJson(request);
    if (isSignupTrapFilled(body)) {
      sendJson(response, 200, acceptedSignupTrapResponse());
      return;
    }

    const email = String(body.email || "").trim();
    if (!isValidEmail(email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }
    const siteUrl = safeNormalizeSiteUrl(body.siteUrl || body.domain);
    if (!siteUrl) {
      sendJson(response, 400, { error: "Website domain is required." });
      return;
    }

    const rateLimit = checkPublicRateLimit("signup", signupRateLimitKey(request, email, siteUrl), "signup", PUBLIC_SIGNUP_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Signup is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    sendJson(response, 409, {
      error: "Paid self-serve setup now starts with the configured payment checkout.",
      paymentRoute: "/api/payments/razorpay/link",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/signup-requests/status") {
    const body = await readJson(request);
    const status = String(body.status || "").trim();
    if (!["new", "approved", "waitlist", "rejected"].includes(status)) {
      sendJson(response, 400, { error: "Use a valid request status." });
      return;
    }
    const requests = await updateStore((store) => {
      store.signupRequests = (store.signupRequests || []).map((item) =>
        String(item.id) === String(body.requestId)
          ? {
              ...item,
              status,
              updatedAt: new Date().toISOString(),
            }
          : item,
      );
      return store.signupRequests;
    });
    sendJson(response, 200, requests);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/signup-requests/approve") {
    const body = await readJson(request);
    const store = await readStore();
    const requestRecord = (store.signupRequests || []).find((item) => String(item.id) === String(body.requestId));
    if (!requestRecord) {
      sendJson(response, 404, { error: "Signup request not found." });
      return;
    }
    const botId = uniqueBotId(store, botIdForUrl(requestRecord.siteUrl));
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, botId);
      record.label = new URL(requestRecord.siteUrl).host;
      record.ownerEmail = requestRecord.email;
      record.plan = normalizePlan(requestRecord.plan);
      record.lifecycleStatus = "approved";
      record.siteUrl = requestRecord.siteUrl;
      record.allowedOrigins = [new URL(requestRecord.siteUrl).origin];
      record.updatedAt = new Date().toISOString();
      nextStore.signupRequests = (nextStore.signupRequests || []).map((item) =>
        String(item.id) === String(body.requestId)
          ? {
              ...item,
              status: "approved",
              botId,
              updatedAt: new Date().toISOString(),
            }
          : item,
      );
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  const botMatch = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
  if (request.method === "GET" && botMatch) {
    const store = await readStore();
    const id = decodeURIComponent(botMatch[1]);
    let bot = store.bots[id];
    if (bot && (!bot.publicKey || !bot.ownerAccessKey)) {
      bot = await updateStore((nextStore) => ensureBot(nextStore, id));
    }
    sendJson(response, 200, bot ? toPublicBot(bot) : null);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/customer/login") {
    const body = await readJson(request);
    const bot = await getCustomerBot(body.botId, body.accessKey || body.ownerAccessKey);
    if (!bot) {
      sendJson(response, 401, { error: "Bot ID or owner access key is wrong." });
      return;
    }
    sendJson(response, 200, toCustomerBot(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/customer/bot") {
    const bot = await getCustomerBot(url.searchParams.get("botId"), ownerKeyFromRequest(request));
    if (!bot) {
      sendJson(response, 401, { error: "Bot ID or owner access key is wrong." });
      return;
    }
    sendJson(response, 200, toCustomerBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const question = String(body.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }

    const result = await recordConversation(botId, question);

    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/chat") {
    const body = await readJson(request);
    const question = String(body.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }

    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(body.botId, body.publicKey, requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Public chat blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = checkPublicRateLimit(body.botId, requestOrigin || "unknown", "chat", PUBLIC_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      await recordEventIfBot(body.botId, "blocked", "Public chat rate limited", "A widget origin hit the public question limit.", { origin: requestOrigin || "unknown" });
      sendJson(response, 429, {
        error: "This widget is getting too many questions right now. Try again in a minute or leave your email.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }

    const result = await recordConversation(body.botId, question);
    if (result.unknown) {
      await recordWidgetEscalation(body.botId, {
        question,
        conversationId: result.conversation?.id,
        origin: requestOrigin || "unknown",
      });
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/install") {
    const body = await readJson(request);
    const installOrigin = verifiedRequestOrigin(request);
    const publicError = await validatePublicInstallRequest(body.botId, body.publicKey, installOrigin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Install ping blocked", publicError.message, { origin: installOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = checkPublicRateLimit(body.botId, installOrigin, "install", PUBLIC_INSTALL_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Install verification is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      const origin = installOrigin;
      const current = (record.installs || []).find((item) => item.origin === origin);
      const nextInstall = {
        origin,
        href: String(body.href || "").slice(0, 500),
        title: String(body.title || "").slice(0, 160),
        userAgent: String(request.headers["user-agent"] || "").slice(0, 220),
        count: (current?.count || 0) + 1,
        firstSeenAt: current?.firstSeenAt || new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      record.installs = [nextInstall, ...(record.installs || []).filter((item) => item.origin !== origin)].slice(0, 20);
      pushEvent(record, "install", current ? "Widget install refreshed" : "Widget install verified", `${origin} loaded the widget.`, {
        origin,
        count: nextInstall.count,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, { ok: true, installs: bot.installs || [] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/public/config") {
    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(url.searchParams.get("botId"), url.searchParams.get("publicKey"), requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(url.searchParams.get("botId"), "blocked", "Widget config blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }

    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, {
      botId: bot?.botId,
      widgetSettings: sanitizeWidgetSettings({}, bot?.widgetSettings),
      lifecycleStatus: bot?.lifecycleStatus || "draft",
      usage: bot ? usageFor(bot) : null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/feedback") {
    const body = await readJson(request);
    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(body.botId, body.publicKey, requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Feedback blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = checkPublicRateLimit(body.botId, requestOrigin || "unknown", "feedback", PUBLIC_FEEDBACK_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Feedback is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    if (!["up", "down"].includes(String(body.rating || "").trim())) {
      sendJson(response, 400, { error: "Feedback rating must be up or down." });
      return;
    }
    const feedback = await recordFeedback(body.botId || "starter-demo", body.conversationId, body.rating, body.note);
    if (!feedback) {
      sendJson(response, 404, { error: "Conversation not found." });
      return;
    }
    sendJson(response, 200, { ok: true, feedback });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/leads") {
    const body = await readJson(request);
    if (!isValidEmail(body.email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }

    const lead = await saveLead(body.botId || "starter-demo", body);

    sendJson(response, 200, lead);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/leads") {
    const body = await readJson(request);
    if (String(body.website || "").trim()) {
      sendJson(response, 200, { ok: true, ignored: true });
      return;
    }
    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(body.botId, body.publicKey, requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Lead capture blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = checkPublicRateLimit(body.botId, requestOrigin || "unknown", "lead", PUBLIC_LEAD_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Lead capture is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }
    if (!isValidEmail(body.email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }

    const lead = await saveLead(body.botId || "starter-demo", body);
    sendJson(response, 200, lead);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources") {
    const body = await readJson(request);
    const title = String(body.title || "").trim();
    const content = String(body.content || "").trim();
    if (title.length < 3) {
      sendJson(response, 400, { error: "Source title is required." });
      return;
    }
    if (content.length < 40) {
      sendJson(response, 400, { error: "Add at least 40 characters of source text." });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      const source = {
        id: uniqueSourceId(record.sources || [], title),
        title,
        url: normalizeSourceUrl(body.url, record.siteUrl),
        excerpt: content.slice(0, 320),
        content: content.slice(0, 18000),
        status: "indexed",
        sourceType: "manual",
        indexedAt: new Date().toISOString(),
      };
      record.sources = [source, ...(record.sources || [])].slice(0, 100);
      if (body.unknownId) {
        markUnknown(record, body.unknownId, "source-added");
      }
      pushEvent(record, "source", "Manual source added", `${title} was added to the answer base.`, { sourceId: source.id });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/draft") {
    const body = await readJson(request);
    const store = await readStore();
    const bot = store.bots[body.botId || "starter-demo"];
    if (!bot) {
      sendJson(response, 404, { error: "Bot not found." });
      return;
    }
    const unknown = (bot.unknowns || []).find((item) => String(item.id) === String(body.unknownId));
    const question = String(body.question || unknown?.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }
    sendJson(response, 200, sourceDraftForQuestion(question, bot, unknown));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-url") {
    const body = await readJson(request);
    const sourceUrl = normalizeUrl(body.url);
    const store = await readStore();
    const current = store.bots[body.botId || "starter-demo"];
    if (current?.siteUrl && new URL(sourceUrl).origin !== new URL(current.siteUrl).origin) {
      sendJson(response, 400, { error: "Source URL must be on the trained website domain." });
      return;
    }

    const fetchedSource = await crawlSinglePage(sourceUrl);
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, body.botId || "starter-demo");
      const source = {
        ...fetchedSource,
        id: uniqueSourceId(record.sources || [], fetchedSource.title),
      };
      record.sources = [source, ...(record.sources || [])].slice(0, 100);
      if (body.unknownId) {
        markUnknown(record, body.unknownId, "source-added");
      }
      pushEvent(record, "source", "URL source imported", `${source.title} was imported from ${new URL(source.url).host}.`, { sourceId: source.id });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/remove") {
    const body = await readJson(request);
    const sourceId = String(body.sourceId || "").trim();
    if (!sourceId) {
      sendJson(response, 400, { error: "Source id is required." });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.sources = (record.sources || []).filter((source) => source.id !== sourceId);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/audit") {
    const body = await readJson(request);
    const store = await readStore();
    const current = store.bots[body.botId || "starter-demo"];
    if (!current) {
      sendJson(response, 404, { error: "Train this bot before auditing sources." });
      return;
    }

    const checkedAt = new Date().toISOString();
    const results = await Promise.all((current.sources || []).map((source) => auditSource(source, checkedAt)));
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, body.botId || "starter-demo");
      const byId = new Map(results.map((source) => [source.id, source]));
      record.sources = (record.sources || []).map((source) => byId.get(source.id) || source);
      record.sourceAudit = {
        checkedAt,
        ok: results.filter((source) => source.status === "indexed").length,
        needsReview: results.filter((source) => source.status === "needs-review").length,
        missing: results.filter((source) => source.status === "missing").length,
      };
      pushEvent(record, "audit", "Source audit completed", `${record.sourceAudit.ok} healthy, ${record.sourceAudit.needsReview} review, ${record.sourceAudit.missing} missing.`);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/quality/run") {
    const body = await readJson(request);
    const qualityRun = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      const previous = record.qualityRun || null;
      const run = runQualitySuite(record);
      run.delta = qualityDelta(run, previous);
      record.previousQualityRun = previous;
      record.qualityRun = run;
      pushEvent(record, "qa", "Launch QA run", `${run.score}% score across ${run.total} buyer checks.`, { score: run.score });
      record.unknowns = [...run.results]
        .filter((item) => item.status !== "pass")
        .reduce(
          (unknowns, item, index) =>
            touchUnknown(unknowns, {
              id: run.id + index + 1,
              question: item.question,
              status: item.status === "weak" ? "needs-review" : "needs-source",
              createdAt: run.generatedAt,
            }),
          record.unknowns || [],
        )
        .slice(0, 50);
      record.updatedAt = new Date().toISOString();
      return run;
    });

    const bot = await getBot(body.botId || "starter-demo");
    sendJson(response, 200, { qualityRun, bot: toPublicBot(bot) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/domains") {
    const body = await readJson(request);
    const origin = safeNormalizeOriginInput(body.origin);
    if (!origin) {
      sendJson(response, 400, { error: "Add a real http or https domain." });
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      const alreadyAllowed = (record.allowedOrigins || []).includes(origin);
      if (!alreadyAllowed && domainUsageFor(record).locked) {
        return { error: `Install domain limit reached for this plan. Upgrade or remove unused items before adding more.`, status: 429, limitStatus: limitStatusFor(record, store) };
      }
      record.allowedOrigins = capAllowedOrigins(record, [origin, ...(record.allowedOrigins || []).filter((item) => item !== origin)]);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    if (bot?.error) {
      sendJson(response, bot.status || 429, bot);
      return;
    }
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/domains/remove") {
    const body = await readJson(request);
    const origin = safeNormalizeOriginInput(body.origin);
    if (!origin) {
      sendJson(response, 400, { error: "Add a real http or https domain." });
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.allowedOrigins = (record.allowedOrigins || []).filter((item) => item !== origin);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/widget/settings") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.widgetSettings = sanitizeWidgetSettings(body.widgetSettings || {}, record.widgetSettings);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/unknowns/resolve") {
    const body = await readJson(request);
    const unknownId = body.unknownId;
    if (!unknownId) {
      sendJson(response, 400, { error: "Unknown question id is required." });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      markUnknown(record, unknownId, "resolved");
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/unknowns/retest") {
    const body = await readJson(request);
    const unknownId = body.unknownId;
    if (!unknownId) {
      sendJson(response, 400, { error: "Unknown question id is required." });
      return;
    }

    const result = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      const unknown = (record.unknowns || []).find((item) => String(item.id) === String(unknownId));
      if (!unknown) return { bot: record, answer: null };
      const answer = answerFromSources(unknown.question, record.sources || []);
      if (!answer.unknown) {
        markUnknown(record, unknownId, "resolved");
        const intent = inferIntent(unknown.question);
        const answerRoute = routeAnswer(unknown.question, answer, record.routingProfile);
        record.conversations.unshift({
          id: Date.now(),
          question: unknown.question,
          answer: answer.answer,
          sources: answer.sources,
          unknown: false,
          confidence: answer.confidence,
          score: answer.score,
          matchedTerms: answer.matchedTerms,
          intent,
          answerRoute,
          estimatedCostCents: answerRoute.estimatedCostCents,
          trace: buildAnswerTrace(unknown.question, answer, answerRoute),
          createdAt: new Date().toISOString(),
        });
        record.conversations = record.conversations.slice(0, 100);
      }
      record.updatedAt = new Date().toISOString();
      return { bot: record, answer };
    });

    sendJson(response, 200, { bot: toPublicBot(result.bot), answer: result.answer });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/leads/status") {
    const body = await readJson(request);
    const leadId = body.leadId;
    const status = String(body.status || "").trim();
    if (!leadId || !["new", "contacted", "won", "lost"].includes(status)) {
      sendJson(response, 400, { error: "Lead id and valid status are required." });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.leads = (record.leads || []).map((lead) =>
        String(lead.id) === String(leadId)
          ? {
              ...lead,
              status,
              updatedAt: new Date().toISOString(),
            }
          : lead,
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/leads/note") {
    const body = await readJson(request);
    const leadId = body.leadId;
    if (!leadId) {
      sendJson(response, 400, { error: "Lead id is required." });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.leads = (record.leads || []).map((lead) =>
        String(lead.id) === String(leadId)
          ? {
              ...lead,
              note: String(body.note || "").trim().slice(0, 800),
              nextFollowUpAt: normalizeOptionalDate(body.nextFollowUpAt),
              updatedAt: new Date().toISOString(),
            }
          : lead,
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/escalations/status") {
    const body = await readJson(request);
    const status = String(body.status || "").trim();
    if (!body.escalationId || !["open", "contacted", "resolved"].includes(status)) {
      sendJson(response, 400, { error: "Escalation id and valid status are required." });
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.escalations = (record.escalations || []).map((item) =>
        String(item.id) === String(body.escalationId)
          ? {
              ...item,
              status,
              updatedAt: new Date().toISOString(),
              resolvedAt: status === "resolved" ? new Date().toISOString() : item.resolvedAt,
            }
          : item,
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/leads") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? (bot.leads || []).map((lead) => withLeadFollowUp(lead, bot)) : []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/conversations") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot?.conversations || []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/unknowns") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot?.unknowns || []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/escalations") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot?.escalations || []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/report") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? buildLaunchReport(bot) : null);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/embed/preflight") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? buildEmbedPreflight(bot) : null);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/report.json") {
    const bot = await getBot(url.searchParams.get("botId"));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"citerep-report.json\"",
    });
    response.end(JSON.stringify(bot ? buildLaunchReport(bot) : null, null, 2));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/bot.json") {
    const bot = await getBot(url.searchParams.get("botId"));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"citerep-bot-backup.json\"",
    });
    response.end(JSON.stringify(buildBotBackup(bot), null, 2));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/leads.csv") {
    const bot = await getBot(url.searchParams.get("botId"));
    const rows = [["email", "name", "need", "source", "status", "score", "heat", "seenCount", "lastSeenAt", "nextStep", "followUpSubject", "note", "nextFollowUpAt", "createdAt"], ...(bot?.leads || []).map((lead) => [
      lead.email,
      lead.name,
      lead.need,
      lead.source,
      lead.status,
      withLeadFollowUp(lead, bot).score,
      withLeadFollowUp(lead, bot).heat,
      lead.seenCount || 1,
      lead.lastSeenAt || "",
      withLeadFollowUp(lead, bot).nextStep,
      withLeadFollowUp(lead, bot).followUpSubject,
      lead.note || "",
      lead.nextFollowUpAt || "",
      lead.createdAt,
    ])];
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"citerep-leads.csv\"",
    });
    response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/interest.csv") {
    const store = await readStore();
    const rows = [["email", "source", "status", "createdAt", "updatedAt"], ...(store.interestLeads || []).map((lead) => [
      lead.email,
      lead.source || "public-home",
      lead.status || "new",
      lead.createdAt,
      lead.updatedAt || "",
    ])];
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"siterep-interest.csv\"",
      "cache-control": "no-store",
    });
    response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/conversations.csv") {
    const bot = await getBot(url.searchParams.get("botId"));
    const rows = [["question", "answer", "sources", "unknown", "confidence", "intent", "route", "costCents", "feedback", "createdAt"], ...(bot?.conversations || []).map((item) => [
      item.question,
      item.answer,
      (item.sources || []).map((source) => source.title).join("; "),
      item.unknown ? "yes" : "no",
      item.confidence || "",
      item.intent?.label || inferIntent(item.question).label,
      item.answerRoute?.model || routeAnswer(item.question, item, bot?.routingProfile).model,
      item.estimatedCostCents ?? routeAnswer(item.question, item, bot?.routingProfile).estimatedCostCents,
      item.feedback?.rating || "",
      item.createdAt,
    ])];
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"citerep-conversations.csv\"",
    });
    response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function getBot(botId) {
  const store = await readStore();
  return store.bots[botId || "starter-demo"] || null;
}

async function getCustomerBot(botId, accessKey) {
  const id = String(botId || "").trim();
  const key = String(accessKey || "").trim();
  if (!id || !key) return null;
  const store = await readStore();
  let bot = store.bots[id];
  if (bot && !bot.ownerAccessKey) {
    bot = await updateStore((nextStore) => ensureBot(nextStore, id));
  }
  return bot && timingSafeEqual(key, bot.ownerAccessKey) ? bot : null;
}

async function authorizeApiRequest(request, url) {
  if (isPublicApiRoute(request.method, url.pathname)) {
    return { ok: true, role: "public" };
  }
  if (isAuthorizedAdmin(request, url)) {
    return { ok: true, role: "admin" };
  }
  if (!isOwnerAllowedRoute(request.method, url.pathname)) {
    return { ok: false };
  }

  const body = request.method === "GET" ? {} : await readJson(request);
  const botId = botIdFromRequest(request, url, body);
  const ownerKey = ownerKeyFromRequest(request, url, body);
  const bot = await getCustomerBot(botId, ownerKey);
  return bot ? { ok: true, role: "owner" } : { ok: false };
}

function isPublicApiRoute(method, pathname) {
  if (method === "GET" && pathname === "/api/health") return true;
  if (method === "GET" && pathname === "/api/public/config") return true;
  if (method === "GET" && pathname === "/api/customer/bot") return true;
  if (method === "POST" && pathname === "/api/customer/login") return true;
  if (method === "POST" && pathname === "/api/interest") return true;
  if (method === "POST" && pathname === "/api/signup-requests") return true;
  return (
    method === "POST" &&
    ["/api/public/chat", "/api/public/install", "/api/public/feedback", "/api/public/leads"].includes(pathname)
  );
}

function isOwnerAllowedRoute(method, pathname) {
  if (method === "GET" && /^\/api\/bots\/[^/]+$/.test(pathname)) return true;
  if (
    method === "GET" &&
    [
      "/api/leads",
      "/api/conversations",
      "/api/unknowns",
      "/api/escalations",
      "/api/report",
      "/api/embed/preflight",
      "/api/export/report.json",
      "/api/export/bot.json",
      "/api/export/leads.csv",
      "/api/export/conversations.csv",
    ].includes(pathname)
  ) {
    return true;
  }
  return (
    method === "POST" &&
    [
      "/api/chat",
      "/api/train",
      "/api/retrain",
      "/api/crawl/cancel",
      "/api/leads",
      "/api/sources",
      "/api/sources/draft",
      "/api/sources/from-url",
      "/api/sources/remove",
      "/api/sources/rollback",
      "/api/sources/audit",
      "/api/quality/run",
      "/api/domains",
      "/api/domains/remove",
      "/api/bots/status",
      "/api/routing/profile",
      "/api/widget/settings",
      "/api/unknowns/resolve",
      "/api/unknowns/retest",
      "/api/leads/status",
      "/api/leads/note",
      "/api/escalations/status",
    ].includes(pathname)
  );
}

function botIdFromRequest(_request, url, body = {}) {
  const botPathMatch = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
  return decodeURIComponent(botPathMatch?.[1] || "") || url.searchParams.get("botId") || body.botId || "starter-demo";
}

function ownerKeyFromRequest(request) {
  return request.headers["x-citerep-owner-key"] || "";
}

function isAuthorizedAdmin(request, url) {
  const expected = configuredAdminKey();
  if (!expected) return isLocalRequest(request);
  const supplied = String(request.headers["x-citerep-admin-key"] || "");
  return timingSafeEqual(supplied, expected);
}

function configuredAdminKey() {
  return String(process.env.CITEREP_ADMIN_KEY || "").trim();
}

function isLocalRequest(request) {
  const host = String(request.headers.host || "");
  return host.startsWith("127.0.0.1") || host.startsWith("localhost");
}

function timingSafeEqual(value, expected) {
  const a = String(value || "");
  const b = String(expected || "");
  if (!a || !b) return false;
  let mismatch = 0;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0 && a.length === b.length;
}

function toPublicBot(bot) {
  return {
    botId: bot.botId,
    publicKey: bot.publicKey,
    ownerAccessKey: bot.ownerAccessKey,
    label: bot.label || bot.botId,
    ownerEmail: bot.ownerEmail || "",
    plan: bot.plan || "Starter",
    planLimits: publicPlanLimitsFor(bot),
    limitStatus: limitStatusFor(bot),
    lifecycleStatus: bot.lifecycleStatus || "draft",
    publishBlockers: publicLaunchBlockers(bot),
    routingProfile: normalizeRoutingProfile(bot.routingProfile),
    siteUrl: bot.siteUrl,
    updatedAt: bot.updatedAt,
    createdAt: bot.createdAt,
    sources: (bot.sources || []).map(publicSource),
    leads: (bot.leads || []).map((lead) => withLeadFollowUp(lead, bot)),
    conversations: bot.conversations || [],
    unknowns: bot.unknowns || [],
    escalations: bot.escalations || [],
    events: bot.events || [],
    installs: bot.installs || [],
    allowedOrigins: bot.allowedOrigins || [],
    widgetSettings: sanitizeWidgetSettings({}, bot.widgetSettings),
    sourceAudit: bot.sourceAudit || null,
    qualityRun: bot.qualityRun || null,
    previousQualityRun: bot.previousQualityRun || null,
    embedPreflight: buildEmbedPreflight(bot),
    usageResetAt: bot.usageResetAt || "",
    responseCount: bot.responseCount || 0,
    usage: usageFor(bot),
    analytics: analyticsFor(bot),
    launchReport: buildLaunchReport(bot),
    trainingRuns: bot.trainingRuns || [],
  };
}

function toCustomerBot(bot) {
  return {
    ...toPublicBot(bot),
    accessRole: "customer",
  };
}

function toBotSummary(bot) {
  const usage = usageFor(bot);
  return {
    botId: bot.botId,
    label: bot.label || bot.botId,
    ownerEmail: bot.ownerEmail || "",
    plan: bot.plan || "Starter",
    planLimits: publicPlanLimitsFor(bot),
    limitStatus: limitStatusFor(bot),
    lifecycleStatus: bot.lifecycleStatus || "draft",
    publishBlockers: publicLaunchBlockers(bot),
    routingProfile: normalizeRoutingProfile(bot.routingProfile),
    siteUrl: bot.siteUrl || "",
    sourceCount: (bot.sources || []).length,
    leadCount: (bot.leads || []).length,
    unknownCount: (bot.unknowns || []).filter((item) => item.status !== "resolved").length,
    escalationCount: (bot.escalations || []).filter((item) => item.status !== "resolved").length,
    installCount: (bot.installs || []).length,
    usage,
    analytics: analyticsFor(bot),
    ownerAccessReady: Boolean(bot.ownerAccessKey),
    qualityScore: bot.qualityRun?.score ?? null,
    launchReport: buildLaunchReport(bot),
    updatedAt: bot.updatedAt,
    createdAt: bot.createdAt,
  };
}

async function recordConversation(botId, question) {
  return await updateStore((store) => {
    const bot = ensureBot(store, botId);
    if ((bot.responseCount || 0) >= STARTER_RESPONSE_LIMIT) {
      return {
        answer:
          "This Starter bot has used all 1,000 included responses for the month. Leave your email and the site owner can follow up.",
        sources: [],
        leadPrompt: true,
        unknown: true,
        responseCount: bot.responseCount || 0,
        usage: usageFor(bot),
        confidence: "none",
        score: 0,
        matchedTerms: [],
      };
    }

    const answer = answerFromSources(question, bot.sources || []);
    const intent = inferIntent(question);
    const answerRoute = routeAnswer(question, answer, bot.routingProfile);
    const conversation = {
      id: Date.now(),
      question,
      answer: answer.answer,
      sources: answer.sources,
      unknown: answer.unknown,
      confidence: answer.confidence,
      score: answer.score,
      matchedTerms: answer.matchedTerms,
      intent,
      answerRoute,
      estimatedCostCents: answerRoute.estimatedCostCents,
      trace: buildAnswerTrace(question, answer, answerRoute),
      createdAt: new Date().toISOString(),
    };
    bot.conversations.unshift(conversation);
    bot.conversations = bot.conversations.slice(0, 100);
    bot.responseCount = (bot.responseCount || 0) + 1;
    pushEvent(
      bot,
      answer.unknown ? "unknown" : "chat",
      answer.unknown ? "Question refused" : "Question answered",
      `${answer.unknown ? "Missing source for" : "Cited answer for"}: ${question.slice(0, 140)}`,
      {
        conversationId: conversation.id,
        confidence: answer.confidence,
        sourceCount: answer.sources.length,
      },
    );
    bot.updatedAt = new Date().toISOString();

    if (answer.unknown) {
      bot.unknowns = touchUnknown(bot.unknowns || [], {
        id: conversation.id,
        question,
        status: "needs-source",
        createdAt: conversation.createdAt,
      }).slice(0, 50);
    }

    return {
      ...answer,
      conversation,
      responseCount: bot.responseCount,
      usage: usageFor(bot),
    };
  });
}

async function saveLead(botId, body) {
  return await updateStore((store) => {
    const bot = ensureBot(store, botId);
    const now = new Date().toISOString();
    const email = String(body.email || "").trim().toLowerCase();
    const existing = (bot.leads || []).find((lead) => String(lead.email || "").trim().toLowerCase() === email);
    const next = {
      ...(existing || {}),
      id: existing?.id || Date.now(),
      name: String(body.name || existing?.name || "Website visitor").trim(),
      email,
      need: String(body.need || existing?.need || "Asked a buying question").trim(),
      source: String(body.source || existing?.source || "Widget"),
      status: existing?.status || "new",
      seenCount: (existing?.seenCount || 0) + 1,
      firstSeenAt: existing?.firstSeenAt || existing?.createdAt || now,
      lastSeenAt: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      note: existing?.note || "",
      nextFollowUpAt: existing?.nextFollowUpAt || "",
    };
    Object.assign(next, scoreLead(next));
    bot.leads = [next, ...(bot.leads || []).filter((lead) => String(lead.email || "").trim().toLowerCase() !== email)];
    bot.leads = bot.leads.slice(0, 200);
    pushEvent(bot, "lead", existing ? "Lead updated" : "Lead captured", `${next.email} · ${next.heat} intent · ${next.seenCount} capture${next.seenCount === 1 ? "" : "s"}.`, {
      leadId: next.id,
      heat: next.heat,
      seenCount: next.seenCount,
    });
    bot.updatedAt = new Date().toISOString();
    return next;
  });
}

async function recordFeedback(botId, conversationId, rating, note) {
  const normalizedRating = String(rating || "").trim();
  if (!["up", "down"].includes(normalizedRating)) {
    throw new Error("Feedback rating must be up or down.");
  }

  return await updateStore((store) => {
    const bot = ensureBot(store, botId);
    const conversation = (bot.conversations || []).find((item) => String(item.id) === String(conversationId));
    if (!conversation) return null;

    const feedback = {
      rating: normalizedRating,
      note: String(note || "").trim().slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    bot.conversations = (bot.conversations || []).map((item) =>
      String(item.id) === String(conversationId)
        ? {
            ...item,
            feedback,
          }
        : item,
    );
    if (normalizedRating === "down") {
      bot.unknowns = touchUnknown(bot.unknowns || [], {
        id: Date.now(),
        question: conversation.question,
        status: "needs-review",
        createdAt: new Date().toISOString(),
      }).slice(0, 50);
    }
    pushEvent(bot, "feedback", normalizedRating === "up" ? "Answer marked helpful" : "Answer needs review", conversation.question.slice(0, 160), {
      conversationId: conversation.id,
      rating: normalizedRating,
    });
    bot.updatedAt = new Date().toISOString();
    return feedback;
  });
}

async function validatePublicRequest(botId, publicKey, origin, appOrigin = "") {
  const store = await readStore();
  const bot = store.bots[botId || "starter-demo"];
  if (!bot) return { status: 404, message: "Bot not found." };
  if (!bot.publicKey || !timingSafeEqual(publicKey, bot.publicKey)) {
    return { status: 401, message: "Invalid widget key." };
  }

  const allowed = allowedOriginsFor(bot, appOrigin);
  if (!origin) {
    return { status: 403, message: "This widget domain could not be verified." };
  }
  if (!allowed.has(origin) && !isPreviewOrigin(origin, appOrigin)) {
    return { status: 403, message: "This widget key is not enabled for this domain." };
  }
  if (bot.lifecycleStatus === "paused") {
    return { status: 423, message: "This widget is paused by the site owner." };
  }
  if (bot.lifecycleStatus !== "live" && !isPreviewOrigin(origin, appOrigin)) {
    return { status: 423, message: "This widget is not published yet." };
  }
  return null;
}

async function validatePublicInstallRequest(botId, publicKey, origin) {
  const store = await readStore();
  const bot = store.bots[botId || "starter-demo"];
  if (!bot) return { status: 404, message: "Bot not found." };
  if (!bot.publicKey || !timingSafeEqual(publicKey, bot.publicKey)) {
    return { status: 401, message: "Invalid widget key." };
  }
  if (!origin) {
    return { status: 403, message: "This widget domain could not be verified." };
  }
  if (!externalAllowedOriginsFor(bot).has(origin)) {
    return { status: 403, message: "Install proof must come from an allowed customer domain." };
  }
  if (bot.lifecycleStatus === "paused") {
    return { status: 423, message: "This widget is paused by the site owner." };
  }
  if (bot.lifecycleStatus !== "live") {
    return { status: 423, message: "This widget is not published yet." };
  }
  return null;
}

function allowedOriginsFor(bot, appOrigin = "") {
  const allowed = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
  if (appOrigin) allowed.add(appOrigin);
  for (const origin of externalAllowedOriginsFor(bot)) {
    allowed.add(origin);
  }
  return allowed;
}

function externalAllowedOriginsFor(bot) {
  const allowed = new Set();
  try {
    if (bot.siteUrl) allowed.add(new URL(bot.siteUrl).origin);
  } catch {
    // Ignore invalid local prototype state.
  }
  for (const origin of bot.allowedOrigins || []) {
    allowed.add(origin);
  }
  return allowed;
}

function resolveRequestOrigin(request, fallbackUrl = "") {
  return request.headers.origin || safeOrigin(request.headers.referer) || safeOrigin(fallbackUrl);
}

function verifiedRequestOrigin(request) {
  return request.headers.origin || safeOrigin(request.headers.referer);
}

function isPreviewOrigin(origin, appOrigin = "") {
  if (!origin) return false;
  if (origin === appOrigin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function publicLaunchBlockers(bot) {
  const blockers = [];
  if (!(bot.sources || []).length) blockers.push("Train the website first.");
  if (!bot.publicKey) blockers.push("Generate the public widget key.");
  if (!externalAllowedOriginsFor(bot).size) blockers.push("Add an allowed install domain.");
  if ((bot.sources || []).length > 0 && (bot.sources || []).every((source) => source.status && source.status !== "indexed")) blockers.push("Fix source health before publishing.");
  if (usageFor(bot).locked) blockers.push("Reset usage or upgrade before publishing.");
  return blockers;
}

function normalizeLifecycleStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return ["draft", "approved", "live", "paused"].includes(status) ? status : "";
}

async function auditSource(source, checkedAt) {
  if (!/^https?:\/\//i.test(source.url || "")) {
    return {
      ...source,
      status: "needs-review",
      httpStatus: "",
      healthMessage: "Manual source URL needs review.",
      healthCheckedAt: checkedAt,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_AUDIT_TIMEOUT_MS);
  try {
    let response = await fetch(source.url, {
      method: "HEAD",
      headers: { "user-agent": "SiteRepBot/0.1 (+https://siterep.net)" },
      signal: controller.signal,
    });
    if (response.status === 405 || response.status === 403) {
      response = await fetch(source.url, {
        method: "GET",
        headers: { "user-agent": "SiteRepBot/0.1 (+https://siterep.net)" },
        signal: controller.signal,
      });
    }
    const ok = response.status >= 200 && response.status < 400;
    return {
      ...source,
      status: ok ? "indexed" : response.status === 404 || response.status === 410 ? "missing" : "needs-review",
      httpStatus: response.status,
      healthMessage: ok ? "URL is reachable." : `HTTP ${response.status} from source URL.`,
      healthCheckedAt: checkedAt,
    };
  } catch (error) {
    return {
      ...source,
      status: "needs-review",
      httpStatus: "",
      healthMessage: error instanceof Error && error.name === "AbortError" ? "Source audit timed out." : "Source URL could not be checked.",
      healthCheckedAt: checkedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOriginInput(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Add a domain or origin first.");
  const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withProtocol);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https domains are supported.");
  return parsed.origin;
}

function safeNormalizeOriginInput(value) {
  try {
    return normalizeOriginInput(value);
  } catch {
    return "";
  }
}

function sanitizeWidgetSettings(input, current = {}) {
  const base = {
    ...DEFAULT_WIDGET_SETTINGS,
    ...current,
  };
  const theme = String(input.theme || base.theme || DEFAULT_WIDGET_SETTINGS.theme).trim();
  const title = String(input.title || base.title || DEFAULT_WIDGET_SETTINGS.title).trim().slice(0, 48);
  const welcomeMessage = String(input.welcomeMessage || base.welcomeMessage || DEFAULT_WIDGET_SETTINGS.welcomeMessage).trim().slice(0, 220);
  const suggestedQuestions = Array.isArray(input.suggestedQuestions)
    ? input.suggestedQuestions
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 4)
    : base.suggestedQuestions || DEFAULT_WIDGET_SETTINGS.suggestedQuestions;

  return {
    title: title || DEFAULT_WIDGET_SETTINGS.title,
    welcomeMessage: welcomeMessage || DEFAULT_WIDGET_SETTINGS.welcomeMessage,
    theme: /^#[0-9a-f]{6}$/i.test(theme) ? theme : DEFAULT_WIDGET_SETTINGS.theme,
    suggestedQuestions: suggestedQuestions.length ? suggestedQuestions : DEFAULT_WIDGET_SETTINGS.suggestedQuestions,
  };
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function planLimitsFor(botOrPlan) {
  const plan = typeof botOrPlan === "string" ? normalizePlan(botOrPlan) : normalizePlan(botOrPlan?.plan);
  return PLAN_LIMITS[plan] || PLAN_LIMITS.Starter;
}

function publicPlanLimitsFor(botOrPlan) {
  const limits = planLimitsFor(botOrPlan);
  return {
    botLimit: limits.botLimit,
    pageLimit: limits.pageLimit,
    responseLimit: limits.responseLimit,
    monthlyRefreshLimit: limits.monthlyRefreshLimit,
    allowedOriginsLimit: limits.allowedOriginsLimit,
    brandingLocked: limits.brandingLocked,
  };
}

function meterFor(used, limit) {
  const safeUsed = Math.max(0, Number(used) || 0);
  const safeLimit = Math.max(1, Number(limit) || 1);
  return {
    used: safeUsed,
    limit: safeLimit,
    remaining: Math.max(0, safeLimit - safeUsed),
    percent: Math.min(100, Math.round((safeUsed / safeLimit) * 100)),
    locked: safeUsed >= safeLimit,
  };
}

function effectivePageLimitFor(botOrPlan) {
  return planLimitsFor(botOrPlan).pageLimit;
}

function preservedSourceCount(bot) {
  return (bot.sources || []).filter((source) => (source.sourceType || "crawl") !== "crawl").length;
}

function sourceUsageFor(bot) {
  return meterFor((bot.sources || []).length, effectivePageLimitFor(bot));
}

function refreshUsageFor(bot) {
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const used = (bot.crawlJobs || []).filter((job) => {
    if (job.type !== "retrain" || job.status === "cancelled") return false;
    const createdAt = Date.parse(job.createdAt || job.startedAt || "");
    return Number.isFinite(createdAt) && createdAt >= monthStart;
  }).length;
  return meterFor(used, planLimitsFor(bot).monthlyRefreshLimit);
}

function domainUsageFor(bot) {
  return meterFor(externalAllowedOriginsFor(bot).size, planLimitsFor(bot).allowedOriginsLimit);
}

function ownerEmailKey(value) {
  return String(value || "").trim().toLowerCase();
}

function ownerBotCount(store, ownerEmail, excludeBotId = "") {
  const key = ownerEmailKey(ownerEmail);
  if (!key) return 0;
  return Object.values(store.bots || {}).filter((bot) => bot.botId !== excludeBotId && ownerEmailKey(bot.ownerEmail) === key).length;
}

function ownerBotUsageFor(store, ownerEmail, plan, excludeBotId = "") {
  const used = ownerEmailKey(ownerEmail) ? ownerBotCount(store, ownerEmail, excludeBotId) : 0;
  return meterFor(used, planLimitsFor(plan).botLimit);
}

function botCreationLimitError(store, ownerEmail, plan) {
  const key = ownerEmailKey(ownerEmail);
  if (!key) return null;
  const usage = ownerBotUsageFor(store, key, plan);
  if (usage.used < usage.limit) return null;
  return {
    error: `${normalizePlan(plan)} includes ${usage.limit} bot${usage.limit === 1 ? "" : "s"} for each owner. Upgrade before creating another bot for this email.`,
    limitStatus: {
      bots: usage,
      planLimits: publicPlanLimitsFor(plan),
    },
  };
}

function limitStatusFor(bot, store = null) {
  const limits = planLimitsFor(bot);
  const ownerKey = ownerEmailKey(bot.ownerEmail);
  return {
    responses: usageFor(bot),
    sources: sourceUsageFor(bot),
    refreshes: refreshUsageFor(bot),
    domains: domainUsageFor(bot),
    bots: store && ownerKey ? meterFor(ownerBotCount(store, ownerKey), limits.botLimit) : meterFor(1, limits.botLimit),
    branding: {
      required: limits.brandingLocked,
      locked: limits.brandingLocked,
      label: limits.brandingLocked ? "Site Rep branding is required on this plan." : "Branding can be removed on this plan.",
    },
  };
}

function capAllowedOrigins(bot, origins = []) {
  return [...new Set(origins.filter(Boolean))].slice(0, planLimitsFor(bot).allowedOriginsLimit);
}

function usageFor(bot) {
  const used = bot.responseCount || 0;
  return meterFor(used, planLimitsFor(bot).responseLimit);
}

function buildLaunchReport(bot) {
  const conversations = bot.conversations || [];
  const leads = (bot.leads || []).map(normalizedLeadScore);
  const unknowns = (bot.unknowns || []).filter((item) => item.status !== "resolved");
  const economics = economicsFor(bot);
  const coverage = buildCoverageMap(bot.sources || []);
  const quality = bot.qualityRun || null;
  const openEscalations = (bot.escalations || []).filter((item) => item.status !== "resolved");
  const overdueLeads = (bot.leads || []).filter((lead) => lead.nextFollowUpAt && Date.parse(lead.nextFollowUpAt) < Date.now() && !["won", "lost"].includes(lead.status || "new"));
  const routeBreakdown = conversations.reduce((totals, conversation) => {
    const model = conversation.answerRoute?.model || routeAnswer(conversation.question, conversation, bot.routingProfile).model;
    totals[model] = (totals[model] || 0) + 1;
    return totals;
  }, {});
  const leadHeat = {
    hot: leads.filter((lead) => lead.heat === "hot").length,
    warm: leads.filter((lead) => lead.heat === "warm").length,
    cold: leads.filter((lead) => lead.heat === "cold").length,
  };
  const topGaps = [...unknowns]
    .map((item) => ({
      id: item.id,
      question: item.question,
      count: item.count || 1,
      priorityScore: item.priorityScore || unknownPriorityScore(item),
      suggestedSourceTitle: item.suggestedSourceTitle || suggestedSourceTitle(item.question),
      status: item.status,
    }))
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 5);
  const topBuyingQuestions = conversations
    .filter((item) => (item.intent?.label || inferIntent(item.question).label) === "buying")
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      question: item.question,
      confidence: item.confidence || "none",
      route: item.answerRoute?.model || routeAnswer(item.question, item, bot.routingProfile).model,
    }));
  const publicLeadCaptured = leads.some((lead) => String(lead.source || "").toLowerCase() === "widget");
  const readiness = [
    { label: "Website trained", done: (bot.sources || []).length > 0 },
    { label: "Published live", done: bot.lifecycleStatus === "live" },
    { label: "Widget installed", done: (bot.installs || []).length > 0 },
    { label: "Domain locked", done: (bot.allowedOrigins || []).length > 0 || Boolean(bot.siteUrl) },
    { label: "Public lead captured", done: publicLeadCaptured },
    { label: "Gaps under control", done: topGaps.length === 0 || topGaps[0].priorityScore < 45 },
  ];
  return {
    generatedAt: new Date().toISOString(),
    botId: bot.botId,
    label: bot.label || bot.botId,
    plan: bot.plan || "Starter",
    routingProfile: normalizeRoutingProfile(bot.routingProfile),
    readiness: {
      score: readiness.filter((item) => item.done).length,
      total: readiness.length,
      checks: readiness,
    },
    economics: {
      ...economics,
      routeBreakdown,
    },
    pipeline: {
      totalLeads: leads.length,
      leadHeat,
      topLeads: leads.sort((a, b) => b.score - a.score).slice(0, 5),
    },
    analytics: analyticsFor(bot),
    questions: {
      totalConversations: conversations.length,
      topBuyingQuestions,
      topGaps,
    },
    coverage,
    quality,
    publicStatus: {
      lifecycleStatus: bot.lifecycleStatus || "draft",
      publishBlockers: publicLaunchBlockers(bot),
      externalOrigins: [...externalAllowedOriginsFor(bot)],
    },
    embedPreflight: buildEmbedPreflight(bot),
    support: {
      openEscalations: openEscalations.length,
      overdueLeadFollowUps: overdueLeads.length,
      latestEscalations: openEscalations.slice(0, 5),
    },
    activity: (bot.events || []).slice(0, 12),
    nextActions: nextActionsFor(bot, topGaps, leads, economics, coverage, quality),
  };
}

function analyticsFor(bot) {
  const conversations = bot.conversations || [];
  const leads = (bot.leads || []).map(normalizedLeadScore);
  const feedback = conversations.filter((item) => item.feedback);
  const cited = conversations.filter((item) => !item.unknown && (item.sources || []).length > 0).length;
  const unknown = conversations.filter((item) => item.unknown).length;
  const helpful = feedback.filter((item) => item.feedback?.rating === "up").length;
  const needsReview = feedback.filter((item) => item.feedback?.rating === "down").length;
  const hotLeads = leads.filter((lead) => lead.heat === "hot").length;
  return {
    installCount: (bot.installs || []).reduce((total, item) => total + (item.count || 1), 0),
    uniqueInstallOrigins: (bot.installs || []).length,
    conversationCount: conversations.length,
    leadCount: leads.length,
    hotLeadCount: hotLeads,
    citedRate: percent(cited, conversations.length),
    unknownRate: percent(unknown, conversations.length),
    leadConversionRate: percent(leads.length, conversations.length),
    hotLeadRate: percent(hotLeads, Math.max(1, leads.length)),
    helpfulRate: percent(helpful, feedback.length),
    needsReviewRate: percent(needsReview, conversations.length),
    latestActivityAt: (bot.events || [])[0]?.createdAt || bot.updatedAt || bot.createdAt || "",
  };
}

function economicsFor(bot) {
  const conversations = bot.conversations || [];
  const used = bot.responseCount || conversations.length || 0;
  const estimatedCostCents = conversations.reduce((total, conversation) => {
    return total + Number(conversation.estimatedCostCents ?? routeAnswer(conversation.question, conversation, bot.routingProfile).estimatedCostCents);
  }, 0);
  const costPerResponseCents = used > 0 ? estimatedCostCents / used : 0;
  const projectedCostAtLimitCents = Math.round(costPerResponseCents * STARTER_RESPONSE_LIMIT * 1000) / 1000;
  const grossMarginCents = STARTER_PRICE_CENTS - projectedCostAtLimitCents;
  return {
    usedResponses: used,
    includedResponses: STARTER_RESPONSE_LIMIT,
    estimatedCostCents: roundCost(estimatedCostCents),
    costPerResponseCents: roundCost(costPerResponseCents),
    projectedCostAtLimitCents: roundCost(projectedCostAtLimitCents),
    projectedGrossMarginCents: roundCost(grossMarginCents),
    projectedGrossMarginPercent: Math.max(0, Math.round((grossMarginCents / STARTER_PRICE_CENTS) * 100)),
  };
}

function inferIntent(question) {
  const text = String(question || "").toLowerCase();
  if (/price|pricing|cost|plan|buy|trial|demo|book|call|quote|contact|hire|available|subscription|upgrade/.test(text)) {
    return { label: "buying", score: 90 };
  }
  if (/refund|cancel|security|privacy|source|proof|integrat|install|setup|wordpress|api|support/.test(text)) {
    return { label: "objection", score: 70 };
  }
  if (/what|how|which|where|when|can|does|do/.test(text)) {
    return { label: "research", score: 45 };
  }
  return { label: "general", score: 25 };
}

function routeAnswer(question, answer, profile = "frugal") {
  const routingProfile = normalizeRoutingProfile(profile);
  const intent = inferIntent(question);
  const confidence = answer.confidence || "none";
  if (routingProfile === "strict") {
    return answer.unknown || confidence === "none"
      ? {
          model: "strict-refusal",
          reason: "Strict mode refuses when no source is strong enough.",
          estimatedCostCents: 0.004,
        }
      : {
          model: "latest-smart-cited-rag",
          reason: "Strict mode uses the latest approved smart route and answers only from indexed sources.",
          estimatedCostCents: 0.012,
        };
  }
  if (answer.unknown || confidence === "none") {
    return {
      model: "source-refusal",
      reason: "No strong source found, so no paid fallback is used.",
      estimatedCostCents: 0.006,
    };
  }
  if (routingProfile === "balanced" && (intent.label === "buying" || confidence === "low" || confidence === "medium")) {
    return {
      model: "latest-smart-rag",
      reason: "Balanced mode uses the latest approved smart route for sales-sensitive or weaker answers.",
      estimatedCostCents: 0.075,
    };
  }
  if (confidence === "high" || intent.label === "research") {
    return {
      model: "latest-fast-rag",
      reason: "Fast source-backed answer from indexed sources.",
      estimatedCostCents: 0.018,
    };
  }
  if (intent.label === "buying" || confidence === "medium") {
    return {
      model: "latest-fast-plus",
      reason: "Buying or medium-confidence answer gets a stronger verified route.",
      estimatedCostCents: 0.045,
    };
  }
  return {
    model: "latest-fast-rag",
    reason: "Fast grounded route.",
    estimatedCostCents: 0.022,
  };
}

function normalizeRoutingProfile(value) {
  const profile = String(value || "frugal").trim().toLowerCase();
  return ROUTING_PROFILES.has(profile) ? profile : "frugal";
}

function buildCoverageMap(sources) {
  const haystacks = (sources || []).map((source) => ({
    source,
    text: `${source.title || ""} ${source.url || ""} ${source.excerpt || ""} ${source.content || ""}`.toLowerCase(),
  }));

  return COVERAGE_CATEGORIES.map((category) => {
    const matches = haystacks
      .map(({ source, text }) => ({
        source,
        hits: category.terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0),
      }))
      .filter((item) => item.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    const hitCount = matches.reduce((total, item) => total + item.hits, 0);
    const status = hitCount >= 3 ? "covered" : hitCount > 0 ? "thin" : "missing";

    return {
      key: category.key,
      label: category.label,
      status,
      score: Math.min(100, Math.round((hitCount / Math.max(1, category.terms.length)) * 100)),
      question: category.question,
      suggestedSourceTitle: category.suggestedSourceTitle,
      sourceTitles: matches.slice(0, 3).map((item) => item.source.title),
    };
  });
}

function runQualitySuite(bot) {
  const generatedAt = new Date().toISOString();
  const results = COVERAGE_CATEGORIES.map((category) => {
    const answer = answerFromSources(category.question, bot.sources || []);
    const route = routeAnswer(category.question, answer, bot.routingProfile);
    const status = answer.unknown || answer.sources.length === 0 ? "missing" : answer.confidence === "low" ? "weak" : "pass";
    return {
      key: category.key,
      label: category.label,
      question: category.question,
      status,
      confidence: answer.confidence,
      sources: answer.sources.map((source) => source.title),
      route: route.model,
      costCents: route.estimatedCostCents,
      fix: status === "pass" ? "" : category.suggestedSourceTitle,
    };
  });
  const score = Math.round((results.filter((item) => item.status === "pass").length / results.length) * 100);
  return {
    id: Date.now(),
    generatedAt,
    score,
    passed: results.filter((item) => item.status === "pass").length,
    total: results.length,
    results,
  };
}

function buildEmbedPreflight(bot) {
  const usage = usageFor(bot);
  const settings = sanitizeWidgetSettings({}, bot.widgetSettings);
  const allowedOrigins = [...externalAllowedOriginsFor(bot)];
  const checks = [
    { label: "Public key ready", done: Boolean(bot.publicKey) },
    { label: "Bot published", done: bot.lifecycleStatus === "live" },
    { label: "Install domain locked", done: allowedOrigins.length > 0 },
    { label: "Widget copy configured", done: Boolean(settings.title && settings.welcomeMessage && settings.suggestedQuestions.length) },
    { label: "Widget install ping seen", done: (bot.installs || []).length > 0 },
    { label: "Public lead captured", done: (bot.leads || []).some((lead) => String(lead.source || "").toLowerCase() === "widget") },
    { label: "Usage budget available", done: !usage.locked },
    { label: "Abuse guard active", done: true },
  ];
  return {
    generatedAt: new Date().toISOString(),
    score: checks.filter((item) => item.done).length,
    total: checks.length,
    checks,
    allowedOrigins,
    latestInstall: (bot.installs || [])[0] || null,
    rateLimit: {
      maxQuestions: PUBLIC_RATE_LIMIT_MAX,
      windowSeconds: Math.round(PUBLIC_RATE_LIMIT_WINDOW_MS / 1000),
    },
  };
}

function buildBotBackup(bot) {
  if (!bot) return null;
  return {
    exportedAt: new Date().toISOString(),
    botId: bot.botId,
    publicKey: bot.publicKey,
    label: bot.label || bot.botId,
    ownerEmail: bot.ownerEmail || "",
    plan: bot.plan || "Starter",
    planLimits: publicPlanLimitsFor(bot),
    limitStatus: limitStatusFor(bot),
    lifecycleStatus: bot.lifecycleStatus || "draft",
    siteUrl: bot.siteUrl || "",
    allowedOrigins: bot.allowedOrigins || [],
    widgetSettings: sanitizeWidgetSettings({}, bot.widgetSettings),
    sources: bot.sources || [],
    leads: (bot.leads || []).map((lead) => withLeadFollowUp(lead, bot)),
    conversations: bot.conversations || [],
    unknowns: bot.unknowns || [],
    escalations: bot.escalations || [],
    installs: bot.installs || [],
    events: bot.events || [],
    opsAlerts: opsAlertsFor(bot),
    sourceAudit: bot.sourceAudit || null,
    qualityRun: bot.qualityRun || null,
    previousQualityRun: bot.previousQualityRun || null,
    trainingRuns: bot.trainingRuns || [],
    crawlJobs: (bot.crawlJobs || []).map((job) => ({
      ...job,
      errors: job.errors || [],
      meta: job.meta || {},
    })),
    sourceSnapshots: (bot.sourceSnapshots || []).map((snapshot) => ({
      id: snapshot.id,
      reason: snapshot.reason,
      sourceCount: snapshot.sourceCount,
      byteSize: snapshot.byteSize,
      restorable: snapshot.restorable !== false,
      meta: snapshot.meta || {},
      createdAt: snapshot.createdAt,
    })),
    usage: usageFor(bot),
    analytics: analyticsFor(bot),
    embedPreflight: buildEmbedPreflight(bot),
    launchReport: buildLaunchReport(bot),
  };
}

function scoreLead(lead) {
  const text = `${lead.need || ""} ${lead.source || ""}`.toLowerCase();
  let score = 35;
  const reasons = [];
  if (/demo|call|quote|buy|hire|purchase|trial|pricing|price|plan|cost|urgent|today|this week/.test(text)) {
    score += 35;
    reasons.push("buying intent");
  }
  if (/refund|security|privacy|integration|wordpress|setup|install|remove branding|white.?label/.test(text)) {
    score += 15;
    reasons.push("implementation or objection");
  }
  if (lead.email && !/@(gmail|yahoo|hotmail|outlook|icloud)\./i.test(lead.email)) {
    score += 10;
    reasons.push("work email");
  }
  if (String(lead.status || "new") === "won") {
    score = 100;
    reasons.push("won");
  }
  score = Math.max(0, Math.min(100, score));
  return {
    score,
    heat: score >= 75 ? "hot" : score >= 50 ? "warm" : "cold",
    scoringReason: reasons.length ? reasons.join(", ") : "low intent",
  };
}

function normalizedLeadScore(lead) {
  const scoring = lead.score && lead.heat ? { score: lead.score, heat: lead.heat, scoringReason: lead.scoringReason || "" } : scoreLead(lead);
  return { ...lead, ...scoring };
}

function withLeadFollowUp(lead, bot) {
  const scored = normalizedLeadScore(lead);
  const siteLabel = bot.label || safeHost(bot.siteUrl) || "the site";
  const subject =
    scored.heat === "hot"
      ? `Re: ${siteLabel} pricing and fit`
      : scored.heat === "warm"
        ? `Quick follow-up from ${siteLabel}`
        : `Thanks for checking ${siteLabel}`;
  const body = [
    `Hi ${scored.name && scored.name !== "Website visitor" ? scored.name : "there"},`,
    "",
    `Saw your question: "${scored.need}".`,
    "The fastest next step is to send the exact page or answer that backs this up, then offer a short call if they are still comparing options.",
    "",
    "Best,",
    siteLabel,
  ].join("\n");

  return {
    ...scored,
    nextStep:
      scored.heat === "hot"
        ? "Reply today with the cited answer and a demo link."
        : scored.heat === "warm"
          ? "Reply with the best source and ask one qualifying question."
          : "Keep in nurture unless they ask another buying question.",
    followUpSubject: subject,
    followUpBody: body,
  };
}

function normalizeOptionalDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

async function recordWidgetEscalation(botId, body) {
  return await updateStore((store) => {
    const bot = ensureBot(store, botId || "starter-demo");
    const now = new Date().toISOString();
    const key = normalizeQuestionKey(body.question);
    const current = (bot.escalations || []).find((item) => item.status !== "resolved" && normalizeQuestionKey(item.question) === key);
    const next = {
      id: current?.id || Date.now(),
      question: String(body.question || "").trim(),
      conversationId: body.conversationId || current?.conversationId || null,
      origin: String(body.origin || current?.origin || "unknown").slice(0, 240),
      status: current?.status || "open",
      count: (current?.count || 0) + 1,
      firstSeenAt: current?.firstSeenAt || now,
      lastSeenAt: now,
      suggestedSourceTitle: suggestedSourceTitle(body.question),
      priorityScore: unknownPriorityScore({
        question: body.question,
        count: (current?.count || 0) + 1,
        status: current?.status || "open",
      }),
    };
    bot.escalations = [next, ...(bot.escalations || []).filter((item) => item.id !== next.id)].slice(0, 100);
    bot.updatedAt = now;
    return next;
  });
}

function buildAnswerTrace(question, answer, answerRoute) {
  return {
    confidence: answer.confidence || "none",
    matchedTerms: answer.matchedTerms || [],
    sourceCount: (answer.sources || []).length,
    sourceTitles: (answer.sources || []).map((source) => source.title),
    route: answerRoute.model,
    routeReason: answerRoute.reason,
    score: answer.score || 0,
    refused: Boolean(answer.unknown),
    explanation: answer.unknown
      ? "No indexed source matched strongly enough, so the bot refused instead of inventing."
      : `Matched ${(answer.sources || []).length} source${(answer.sources || []).length === 1 ? "" : "s"} for this question.`,
    repairHint: answer.unknown ? suggestedSourceTitle(question) : "",
  };
}

function sourceDraftForQuestion(question, bot, unknown = null) {
  const category =
    COVERAGE_CATEGORIES.find((item) => item.question === question) ||
    COVERAGE_CATEGORIES.find((item) => item.terms.some((term) => String(question).toLowerCase().includes(term))) ||
    null;
  const suggestedTitle = unknown?.suggestedSourceTitle || category?.suggestedSourceTitle || suggestedSourceTitle(question);
  const host = safeHost(bot.siteUrl);
  return {
    title: suggestedTitle,
    url: bot.siteUrl || "",
    question,
    guidance: [
      `Answer this exact visitor question: "${question}"`,
      `Use a real ${host || "customer"} page, policy, pricing row, FAQ, docs page, or approved internal note.`,
      "Paste only exact source text. Do not paste a generated answer.",
      "After saving, retest the gap and only resolve it when the bot cites this source.",
    ],
    content: "",
  };
}

function qualityDelta(current, previous) {
  if (!previous) {
    return {
      status: "baseline",
      scoreChange: 0,
      newFailures: current.results.filter((item) => item.status !== "pass").map((item) => item.label),
      fixed: [],
    };
  }
  const previousByKey = new Map((previous.results || []).map((item) => [item.key, item]));
  const newFailures = current.results
    .filter((item) => item.status !== "pass" && previousByKey.get(item.key)?.status === "pass")
    .map((item) => item.label);
  const fixed = current.results
    .filter((item) => item.status === "pass" && previousByKey.get(item.key)?.status !== "pass")
    .map((item) => item.label);

  return {
    status: "compared",
    scoreChange: current.score - Number(previous.score || 0),
    newFailures,
    fixed,
  };
}

async function recordEventIfBot(botId, type, title, detail = "", meta = {}) {
  if (!botId) return null;
  return await updateStore((store) => {
    const bot = store.bots?.[botId];
    if (!bot) return null;
    pushEvent(bot, type, title, detail, meta);
    bot.updatedAt = new Date().toISOString();
    return bot.events?.[0] || null;
  });
}

function pushEvent(bot, type, title, detail = "", meta = {}) {
  bot.events = [
    {
      id: Date.now() + Math.floor(Math.random() * 1000),
      type,
      title,
      detail,
      meta,
      createdAt: new Date().toISOString(),
    },
    ...(Array.isArray(bot.events) ? bot.events : []),
  ].slice(0, 120);
}

function checkPublicRateLimit(botId, origin, action = "chat", maxHits = PUBLIC_RATE_LIMIT_MAX) {
  const now = Date.now();
  const key = `${action}:${botId || "starter-demo"}:${origin || "unknown"}`;
  const current = (publicChatHits.get(key) || []).filter((timestamp) => now - timestamp < PUBLIC_RATE_LIMIT_WINDOW_MS);
  if (current.length >= maxHits) {
    const oldest = current[0] || now;
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((PUBLIC_RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000)),
    };
  }
  current.push(now);
  publicChatHits.set(key, current);
  return { limited: false, retryAfterSeconds: 0 };
}

function isSignupTrapFilled(body) {
  return Boolean(
    String(body.botField || "").trim() ||
      String(body.companyWebsite || "").trim() ||
      String(body.websiteUrl || "").trim(),
  );
}

function acceptedSignupTrapResponse() {
  return {
    ok: true,
    status: "received",
    createdAt: new Date().toISOString(),
  };
}

function signupRateLimitKey(request, email, siteUrl) {
  const ip =
    request.headers["cf-connecting-ip"] ||
    String(request.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    request.headers.origin ||
    "";
  const emailDomain = String(email || "").split("@")[1] || "";
  let siteHost = "";
  try {
    siteHost = new URL(siteUrl).host;
  } catch {
    siteHost = "";
  }
  return [ip, emailDomain, siteHost].filter(Boolean).join(":") || "unknown";
}

function unknownPriorityScore(item) {
  const intent = inferIntent(item.question);
  const count = item.count || 1;
  const statusPenalty = item.status === "source-added" ? -10 : 0;
  return Math.max(0, Math.min(100, intent.score + count * 8 + statusPenalty));
}

function suggestedSourceTitle(question) {
  const intent = inferIntent(question);
  if (intent.label === "buying") return "Pricing, plans, demo, or purchase policy";
  if (/refund|cancel/i.test(question)) return "Refund and cancellation policy";
  if (/install|setup|wordpress|script/i.test(question)) return "Install and setup guide";
  if (/security|privacy|source|proof/i.test(question)) return "Security, privacy, and source policy";
  return "FAQ source for this exact question";
}

function nextActionsFor(bot, topGaps, leads, economics, coverage = [], quality = null) {
  const actions = [];
  const openEscalations = (bot.escalations || []).filter((item) => item.status !== "resolved");
  const overdueLeads = (bot.leads || []).filter((lead) => lead.nextFollowUpAt && Date.parse(lead.nextFollowUpAt) < Date.now() && !["won", "lost"].includes(lead.status || "new"));
  if ((bot.sources || []).length === 0) actions.push("Train the customer site before sending the embed.");
  if (openEscalations.length > 0) actions.push("Handle open widget escalations first.");
  if (overdueLeads.length > 0) actions.push("Follow up overdue leads today.");
  const missingCoverage = coverage.find((item) => item.status === "missing");
  if (missingCoverage) actions.push(`Add ${missingCoverage.label.toLowerCase()} source coverage.`);
  if (!quality) actions.push("Run launch QA before sending the widget.");
  if (quality && quality.score < 80) actions.push("Fix failed launch QA questions before traffic.");
  if (bot.lifecycleStatus !== "live") actions.push("Publish the bot before using it on a customer domain.");
  if ((bot.installs || []).length === 0) actions.push("Verify the widget install on the customer domain.");
  if (topGaps.length > 0) actions.push(`Add source: ${topGaps[0].suggestedSourceTitle}.`);
  if (leads.some((lead) => lead.heat === "hot" && (lead.status || "new") === "new")) actions.push("Follow up with the hottest new lead.");
  if (economics.projectedGrossMarginPercent < 80) actions.push("Tighten routing before scaling this plan.");
  if (actions.length === 0) actions.push("Ready for a small traffic test.");
  return actions.slice(0, 5);
}

function roundCost(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function uniqueBotId(store, baseId) {
  const base = slug(baseId) || `starter-${Date.now()}`;
  let id = base;
  let index = 2;
  while (store.bots?.[id]) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function safeNormalizeSiteUrl(value) {
  try {
    return value ? normalizeUrl(value) : "";
  } catch {
    return "";
  }
}

function normalizePlan(value) {
  const plan = String(value || "Starter").trim();
  return ["Starter", "Growth", "Pro", "Agency"].includes(plan) ? plan : "Starter";
}

function botIdForUrl(siteUrl) {
  const host = new URL(siteUrl).host;
  return `starter-${host.replace(/\W/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}`;
}

function dedupeUnknowns(unknowns) {
  const seen = new Set();
  return unknowns.filter((item) => {
    const key = item.question.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeQuestionKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function touchUnknown(unknowns, next) {
  const key = normalizeQuestionKey(next.question);
  const existing = unknowns.find((item) => normalizeQuestionKey(item.question) === key);
  if (existing) {
    return [
      {
        ...existing,
        status: existing.status === "resolved" ? next.status : existing.status || next.status,
        count: (existing.count || 1) + 1,
        lastAskedAt: next.createdAt,
        priorityScore: unknownPriorityScore({ ...existing, count: (existing.count || 1) + 1, question: next.question }),
        suggestedSourceTitle: suggestedSourceTitle(next.question),
      },
      ...unknowns.filter((item) => normalizeQuestionKey(item.question) !== key),
    ];
  }
  return [
    {
      ...next,
      count: 1,
      priorityScore: unknownPriorityScore(next),
      suggestedSourceTitle: suggestedSourceTitle(next.question),
    },
    ...unknowns,
  ];
}

function markUnknown(bot, unknownId, status) {
  bot.unknowns = (bot.unknowns || []).map((item) =>
    String(item.id) === String(unknownId)
      ? {
          ...item,
          status,
          resolvedAt: new Date().toISOString(),
          priorityScore: status === "resolved" ? 0 : item.priorityScore,
        }
      : item,
  );
}

function uniqueSourceId(sources, title) {
  const base = slug(title) || `source-${Date.now()}`;
  let id = base;
  let index = 2;
  const used = new Set(sources.map((source) => source.id));
  while (used.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function normalizeSourceUrl(value, siteUrl) {
  const raw = String(value || "").trim();
  if (!raw) return siteUrl || "Manual source";
  try {
    const siteOrigin = siteUrl ? new URL(siteUrl).origin : "";
    if (siteOrigin && (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || (!/^[a-z]+:\/\//i.test(raw) && !raw.includes(".")))) {
      const parsed = new URL(raw, `${siteOrigin}/`);
      parsed.hash = "";
      return parsed.toString();
    }
    const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return raw;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}

function newestTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

async function readJson(request) {
  if (request._jsonBody !== undefined) return request._jsonBody;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  request._jsonBody = raw ? JSON.parse(raw) : {};
  return request._jsonBody;
}

function sendJson(response, status, data) {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function setCors(request, response) {
  const origin = String(request.headers.origin || "");
  if (!origin) return true;
  if (isPublicWidgetCorsRoute(request)) {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    return true;
  }
  if (!isAllowedCorsOrigin(origin, request)) return false;
  response.setHeader("access-control-allow-origin", origin); // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,x-citerep-admin-key,x-citerep-owner-key");
  return true;
}

function isPublicWidgetCorsRoute(request) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (["GET", "OPTIONS"].includes(request.method) && url.pathname === "/api/public/config") return true;
    return (
      ["POST", "OPTIONS"].includes(request.method) &&
      ["/api/public/chat", "/api/public/install", "/api/public/feedback", "/api/public/leads"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}

function isAllowedCorsOrigin(origin, request) {
  if (DEFAULT_ALLOWED_CORS_ORIGINS.has(origin)) return true;
  const configured = String(process.env.CITEREP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  const host = String(request.headers.host || "");
  return origin === `http://${host}` || origin === `https://${host}`;
}

async function serveStatic(response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(STATIC_ROOT, safePath);
  const root = STATIC_ROOT + "/";
  if (!filePath.startsWith(root) && filePath !== STATIC_ROOT) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not file");
    response.writeHead(200, { ...SECURITY_HEADERS, "content-type": contentType(filePath) });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
    createReadStream(join(STATIC_ROOT, "index.html")).pipe(response);
  }
}

function contentType(filePath) {
  const ext = extname(filePath);
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".html") return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
