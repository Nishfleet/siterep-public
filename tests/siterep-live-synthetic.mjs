import { readFileSync } from "node:fs";
import { isNonAnswerText } from "../worker/compose.js";
import { FUNNEL_EVENT_NAMES } from "../worker/funnel-events.js";

// Release marker source of truth: the worker. The marker is a stable milestone
// name (RELEASE_STATUS_MARKER in worker/index.js), so the canary must
// not hardcode a copy — drift between worker code and canary expectation
// silently turns into a red build. Scout 2026-08-20: the canary's hardcoded
// fallback for expectedReleaseMarker disagreed with the worker's marker and
// stayed red across the live==main restore. Read the constant from the worker
// at startup; let SITEREP_EXPECTED_RELEASE_MARKER override it (escape hatch
// when the worker is intentionally staging a new marker).
function readWorkerReleaseMarker() {
  const workerPath = new URL("../worker/index.js", import.meta.url);
  const source = readFileSync(workerPath, "utf8");
  const match = source.match(/const RELEASE_STATUS_MARKER = "([^"]+)"/);
  if (!match) {
    throw new Error(
      "worker/index.js is missing `const RELEASE_STATUS_MARKER = \"...\"`; the live canary cannot derive its marker expectation",
    );
  }
  return match[1];
}

const baseUrl = new URL(process.env.SITEREP_MONITOR_BASE_URL || "https://siterep.net");
const isLocalCandidate = ["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname);
const defaultMonitorBotId = "site-rep-demo";
const defaultMonitorPublicKey = "sr_demo_source_backed_widget_key";
const monitorBotId = process.env.SITEREP_MONITOR_BOT_ID || defaultMonitorBotId;
const monitorPublicKey = process.env.SITEREP_MONITOR_PUBLIC_KEY || defaultMonitorPublicKey;
const monitorOrigin = process.env.SITEREP_MONITOR_ORIGIN || "https://siterep.net";
const monitorAdminKey = process.env.SITEREP_MONITOR_ADMIN_KEY || process.env.CITEREP_ADMIN_KEY || "";
const healthOnly = process.argv.includes("--health") || process.env.SITEREP_MONITOR_SCOPE === "health";
const strictMode = process.argv.includes("--strict") || process.env.SITEREP_MONITOR_STRICT === "true";
const requestTimeoutMs = Number(process.env.SITEREP_MONITOR_TIMEOUT_MS || 10000);
const expectedReleaseMarker = process.env.SITEREP_EXPECTED_RELEASE_MARKER || readWorkerReleaseMarker();
const expectedTrustUpdatedAt = process.env.SITEREP_EXPECTED_TRUST_UPDATED_AT || "2026-08-11";
// The sitemap is a static asset; nothing recomputes lastmod at runtime. If a
// deploy lags behind a content change, stale dates silently persist — the
// defect behind scout 2026-08-09 "every URL still advertises 2026-06-02".
// lastmod tracks the last real content change of each page (not deploy time),
// so privacy/terms legitimately stay at 2026-08-03 while the marketing pages
// moved to 2026-08-11. Pin a minimum floor per URL; bump a floor whenever the
// corresponding sitemap date changes so the live monitor fails loudly until
// the refreshed sitemap is actually deployed. SITEREP_EXPECTED_SITEMAP_LASTMOD
// still raises the floor for every URL (deploy-window override), and
// SITEREP_EXPECTED_SITEMAP_LASTMOD_OVERRIDES replaces individual entries as
// {"/": "2026-08-11"} JSON.
const defaultSitemapLastmodFloors = Object.freeze({
  "/": "2026-08-09",
  "/ai-website-chatbot-for-small-business": "2026-08-09",
  "/privacy": "2026-08-03",
  "/terms": "2026-08-22",
  "/trust": "2026-08-11",
  "/honesty": "2026-08-22",
  "/docs/install": "2026-08-11",
  "/vs": "2026-08-21",
  "/vs/customgpt": "2026-08-11",
  "/vs/chatbase": "2026-08-11",
  "/vs/intercom-fin": "2026-08-11",
  "/vs/tidio-lyro": "2026-08-11",
  "/vs/chatling": "2026-08-21",
});
const expectedSitemapLastmod = process.env.SITEREP_EXPECTED_SITEMAP_LASTMOD || "";
const sitemapLastmodFloors = Object.fromEntries(
  Object.entries(defaultSitemapLastmodFloors).map(([url, date]) => [
    url,
    expectedSitemapLastmod || date,
  ]),
);
try {
  if (process.env.SITEREP_EXPECTED_SITEMAP_LASTMOD_OVERRIDES) {
    Object.assign(
      sitemapLastmodFloors,
      JSON.parse(process.env.SITEREP_EXPECTED_SITEMAP_LASTMOD_OVERRIDES),
    );
  }
} catch (error) {
  throw new Error(`SITEREP_EXPECTED_SITEMAP_LASTMOD_OVERRIDES was not valid JSON: ${error.message}`);
}
// Deploy identity must stay fresh: the payload's deployedAt cannot be older
// than this window, so a stale release stamp fails the live monitor loudly.
const expectedReleaseMaxAgeDays = Number(process.env.SITEREP_EXPECTED_RELEASE_MAX_AGE_DAYS || 31);
const syntheticRunId = Date.now();
const responseBudgetsMs = Object.freeze({
  "fast health": 2000,
  "deep health": 8000,
  "public pricing": 4000,
  "homepage html": 3000,
  "homepage markdown": 3000,
  privacy: 3000,
  terms: 3000,
  trust: 3000,
  "docs install": 3000,
  "vs hub": 3000,
  "vs customgpt": 3000,
  "vs chatbase": 3000,
  "vs intercom-fin": 3000,
  "vs tidio-lyro": 3000,
  "vs webspeaker": 3000,
  "vs chatling": 3000,
  "trust status": 3000,
  "release status": 3000,
  "honesty check": 3000,
  "funnel event collection": 3000,
  "funnel instrumentation bundle": 5000,
  llms: 3000,
  sitemap: 3000,
  "widget preview html": 3000,
  "widget config": 3000,
  "widget install": 3000,
  "widget cited chat": 9000,
  "widget install chat": 9000,
  "widget natural pricing chat": 9000,
  "widget refusal chat": 9000,
  "widget trust chat": 9000,
});
const requiredSecurityHeaders = Object.freeze({
  "strict-transport-security": /max-age=/i,
  "content-security-policy": /default-src 'self'/i,
  "x-content-type-options": /^nosniff$/i,
  "x-frame-options": /^DENY$/i,
  "referrer-policy": /^no-referrer$/i,
  "permissions-policy": /camera=\(\), microphone=\(\), geolocation=\(\)/i,
});
const failures = [];
const warnings = [];
const checks = [];

function absoluteUrl(pathname) {
  return new URL(pathname, baseUrl).toString();
}

async function probe(label, pathname, options = {}, validate = null) {
  const started = performance.now();
  let response;
  let body = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    response = await fetch(absoluteUrl(pathname), { ...options, signal: controller.signal });
    body = await response.text();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : "request failed"}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
  const ms = Math.round(performance.now() - started);
  const result = { label, status: response.status, ms };
  checks.push(result);
  if (!response.ok) failures.push(`${label}: expected 2xx, got ${response.status}`);
  const budgetMs = responseBudgetsMs[label];
  if (Number.isFinite(budgetMs) && ms > budgetMs) failures.push(`${label}: took ${ms}ms over ${budgetMs}ms budget`);
  assertSecurityHeaders(label, response);
  if (validate) {
    try {
      await validate({ response, body, ms });
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : "validation failed"}`);
    }
  }
  return { response, body, ms };
}

function assertSecurityHeaders(label, response) {
  for (const [header, pattern] of Object.entries(requiredSecurityHeaders)) {
    const value = response.headers.get(header) || "";
    if (!pattern.test(value)) failures.push(`${label}: missing or weak ${header}`);
  }
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("response was not valid JSON");
  }
}

// A cited answer must be a real answer: not refused, citing at least one
// source, never the same source twice, and never narrated non-answer text
// ("the excerpts do not mention...") dressed up with citations.
function assertHonestCitedAnswer(label, data) {
  if (!data.answer || !data.conversation?.id) throw new Error(`${label} chat did not return an answer and conversation`);
  if (data.unknown || data.refused || data.conversation?.refused) throw new Error(`${label} answer was refused`);
  if (!Array.isArray(data.sources) || data.sources.length === 0) throw new Error(`${label} answer did not cite sources`);
  const sourceIds = data.sources.map((source) => String(source?.id || ""));
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error(`${label} answer cited the same source more than once: ${sourceIds.join(", ")}`);
  }
  for (const source of data.sources) {
    if (!source?.title) throw new Error(`${label} citation was missing a title`);
    if (!source?.url) throw new Error(`${label} citation was missing a URL or file label`);
    if (!source?.excerpt) throw new Error(`${label} citation was missing an excerpt`);
  }
  if (isNonAnswerText(data.answer)) {
    throw new Error(`${label} answer is a non-answer dressed as a cited answer: ${String(data.answer).slice(0, 160)}`);
  }
}

// Demo pricing answers are exact live-checkout quotes the retrieval layer
// built ("Starter €X, Growth €Y, Pro €Z, Agency €W per month, tax included —"
// or the honest checkout/email fallback). They must reach the visitor verbatim
// — the answer starts with the cited excerpt, never a model paraphrase that
// drops plan names.
function assertQuoteNotParaphrased(label, data) {
  const excerpt = String(data.sources?.[0]?.excerpt || "");
  if (!excerpt) throw new Error(`${label} pricing answer had no citation excerpt`);
  if (!String(data.answer || "").startsWith(excerpt)) {
    throw new Error(`${label} pricing answer paraphrased the live quote: ${String(data.answer).slice(0, 160)}`);
  }
}

// The generic pricing answer must quote the four NAMED-plan prices the live
// #public-pricing section renders — "Starter €X, Growth €Y, Pro €Z, Agency €W
// per month, tax included — ...". When the live checkout quoted real amounts,
// every plan name the quote guarantees must appear in the shipped answer.
function assertPricingQuotesNamedPlans(label, data) {
  assertQuoteNotParaphrased(label, data);
  const excerpt = String(data.sources?.[0]?.excerpt || "");
  if (!/(?:€|$|£|₹)\s?\d/.test(excerpt)) return;
  for (const planName of ["Starter", "Growth", "Pro", "Agency"]) {
    if (!String(data.answer).includes(planName)) {
      throw new Error(`${label} pricing answer dropped the ${planName} plan name: ${String(data.answer).slice(0, 160)}`);
    }
  }
}

function assertReleaseFreshness(label, release) {
  if (!release || typeof release !== "object") throw new Error(`${label} missing release marker`);
  if (release.marker !== expectedReleaseMarker) {
    throw new Error(`${label} stale release marker: expected ${expectedReleaseMarker}, got ${release.marker || "missing"}`);
  }
  if (release.publicTrustUpdatedAt !== expectedTrustUpdatedAt) {
    throw new Error(`${label} stale trust marker: expected ${expectedTrustUpdatedAt}, got ${release.publicTrustUpdatedAt || "missing"}`);
  }
  const expectedStage = process.env.SITEREP_EXPECTED_RELEASE_STAGE || "production_hardening";
  if (release.stage !== expectedStage) {
    throw new Error(`${label} unexpected release stage: expected ${expectedStage}, got ${release.stage || "missing"}`);
  }
  // The payload must identify the actually deployed release: a verifiable
  // commit and a current deploy timestamp, not a stale hardcoded date.
  if (!/^[0-9a-f]{7,40}$/.test(String(release.commit || ""))) {
    throw new Error(`${label} missing verifiable deploy commit: ${release.commit || "missing"}`);
  }
  const deployedAtMs = Date.parse(String(release.deployedAt || ""));
  if (!Number.isFinite(deployedAtMs)) {
    throw new Error(`${label} missing deploy timestamp: ${release.deployedAt || "missing"}`);
  }
  const ageDays = (Date.now() - deployedAtMs) / 86400000;
  if (ageDays < -1) {
    throw new Error(`${label} deploy timestamp is in the future: ${release.deployedAt}`);
  }
  if (ageDays > expectedReleaseMaxAgeDays) {
    throw new Error(
      `${label} stale deploy identity: deployedAt ${release.deployedAt} is ${Math.round(ageDays)} days old (max ${expectedReleaseMaxAgeDays} days)`,
    );
  }
}

function publicHealthCountLeakPaths(value, path = []) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => publicHealthCountLeakPaths(item, [...path, String(index)]));
  }
  const knownPrivateCountFields = new Set(["botCount", "signupRequestCount", "interestCount", "rowCounts"]);
  return Object.entries(value).flatMap(([key, child]) => {
    const fieldPath = [...path, key];
    const ownLeak = knownPrivateCountFields.has(key) || /(?:Row)?Counts?$/.test(key) || /_(?:row_)?counts?$/i.test(key) || /^(?:row)?counts?$/i.test(key)
      ? [fieldPath.join(".")]
      : [];
    return [...ownLeak, ...publicHealthCountLeakPaths(child, fieldPath)];
  });
}

function assertNoPublicHealthCounts(label, data = {}) {
  const leaks = publicHealthCountLeakPaths(data);
  if (leaks.length) {
    throw new Error(`${label} exposed private count fields: ${leaks.join(", ")}`);
  }
}

// Every sitemap URL must advertise a lastmod at or after the per-page floor,
// so a stale deploy cannot silently keep serving the previous cycle's dates
// to search engines. Per-page floors exist because lastmod tracks real
// content change, not deploy time: privacy/terms last changed 2026-08-03
// while the marketing pages moved to 2026-08-09/2026-08-11.
function assertSitemapFreshness(label, body) {
  if (!body.includes("<urlset")) throw new Error(`${label} did not look like a sitemap urlset`);
  const entries = [...body.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)]
    .map((match) => ({ pathname: new URL(match[1]).pathname.replace(/\/$/, "") || "/", lastmod: match[2] }));
  if (entries.length === 0) throw new Error(`${label} contained no lastmod dates`);
  const stale = [];
  for (const { pathname, lastmod } of entries) {
    const floor = sitemapLastmodFloors[pathname];
    if (floor && lastmod < floor) stale.push(`${pathname}: ${lastmod} < ${floor}`);
  }
  if (stale.length) throw new Error(`${label} advertises stale lastmod dates: ${stale.join(", ")}`);
  const uncovered = Object.keys(sitemapLastmodFloors).filter(
    (pathname) => !entries.some((entry) => entry.pathname === pathname),
  );
  if (uncovered.length) throw new Error(`${label} is missing pinned URLs: ${uncovered.join(", ")}`);
}

await probe("fast health", "/api/health/live", {}, ({ body, ms }) => {
  const data = parseJson(body);
  if (data.mode !== "fast") throw new Error("mode was not fast");
  assertNoPublicHealthCounts("fast health", data);
  if (!data.ok || data.runtime !== "cloudflare-worker") throw new Error("Worker runtime was not healthy");
  if (!healthOnly) assertReleaseFreshness("fast health", data.release);
});

if (!healthOnly) {
  await probe("deep health", "/api/health/deep", monitorAdminKey ? { headers: { "x-citerep-admin-key": monitorAdminKey } } : {}, ({ body }) => {
    const data = parseJson(body);
    if (data.mode !== "deep") throw new Error("mode was not deep");
    if (monitorAdminKey) {
      if (typeof data.botCount !== "number") throw new Error("deep health did not include bot count");
      if (!data.accountRbac?.configured) throw new Error("account RBAC binding is not configured");
    } else {
      assertNoPublicHealthCounts("public deep health", data);
      if (data.adminAuth?.unlocked) throw new Error("public deep health reported admin unlock");
      if (typeof data.accountRbac?.configured !== "boolean") throw new Error("public deep health did not include coarse account RBAC readiness");
    }
    if (!data.billing?.ready) warnings.push(`billing not ready: ${data.billing?.reason || "unknown"}`);
    if (!data.notifications?.ready) warnings.push(`email notifications not ready: ${data.notifications?.reason || "unknown"}`);
    // One enforced readiness invariant (scout 2026-08-09): required storage
    // components cannot report not-ready while the aggregate is green.
    const requiredNotReady = ["recordLedger", "sourceContent", "accountRbac"].filter((name) => !data[name]?.ready);
    if (requiredNotReady.length && data.selfServe?.ready) {
      throw new Error(`deep health contradicts itself: ${requiredNotReady.join(", ")} not ready while selfServe is green`);
    }
    if (!data.selfServe?.ready) {
      const message = `self-serve not ready: ${data.selfServe?.blockers?.[0] || "unknown"}`;
      if (strictMode) failures.push(message);
      else warnings.push(message);
    }
  });

  await probe("public pricing", "/api/public/pricing", {}, ({ body }) => {
    const data = parseJson(body);
    const starter = data.plans?.find((plan) => plan.name === "Starter");
    if (!starter?.displayPrice || !starter?.amountSubunits) {
      const message = "Starter price was missing";
      if (isLocalCandidate && !strictMode) warnings.push(`${message}: local Dodo secrets are not loaded.`);
      else throw new Error(message);
    }
    if (strictMode && (!data.ok || data.provider !== "dodo" || starter.source !== "dodo_checkout_preview")) {
      throw new Error("strict launch requires live Dodo preview pricing");
    }
  });

  await probe("homepage html", "/", {}, ({ body }) => {
    if (!body.includes("Site Rep")) throw new Error("homepage did not include Site Rep");
  });

  await probe("homepage markdown", "/", { headers: { Accept: "text/markdown" } }, ({ body }) => {
    if (!body.includes("# Site Rep")) throw new Error("markdown page did not include Site Rep heading");
  });

  await probe("privacy", "/privacy", {}, ({ body }) => {
    if (!body.includes("Privacy")) throw new Error("privacy page missing title");
  });

  await probe("terms", "/terms", {}, ({ body }) => {
    if (!body.includes("Terms")) throw new Error("terms page missing title");
  });

  await probe("trust", "/trust", {}, ({ body }) => {
    if (!body.includes("Trust and Data Handling") || !body.includes("what Site Rep does today")) {
      throw new Error("trust page did not include the customer-facing trust notes");
    }
  });

  await probe("docs install", "/docs/install", {}, ({ body }) => {
    if (!body.includes("Install Site Rep Docs Mode")) throw new Error("docs install page missing title");
    if (!body.includes("Mintlify") || !body.includes("Docusaurus") || !body.includes("GitBook")) {
      throw new Error("docs install page missing requested recipes");
    }
    if (!body.includes("not directly installable")) throw new Error("docs install page must not overclaim hosted GitBook install");
    // The install guide must never be an activation dead-end: a visitor who
    // lands on the recipes page has to reach the free-start signup and the
    // customer sign-in to get the bot id, widget key, and allowed-domain lock
    // the snippets require. Render both anchors in Worker HTML, no JS needed.
    if (!body.includes('href="/?surface=free-start"')) {
      throw new Error("docs install page missing activation CTA to the free-start signup surface");
    }
    if (!body.includes('href="/?surface=customer"')) {
      throw new Error("docs install page missing sign-in CTA to the customer surface");
    }
  });

  // Comparison pages must keep delivering the durable free-start entry: the
  // live-delivery defect behind scout 2026-08-08 05:34 IST was a comparison
  // CTA that looked right but never reached the signup surface. Every /vs/*
  // page must render the real /?surface=free-start anchor (Worker-rendered
  // HTML, no JS needed); the SPA handoff of that entry is pinned by the
  // public-layout smoke (incl. the live canary click-through).
  const comparisonPages = Object.freeze([
    { label: "vs hub", path: "/vs" },
    { label: "vs customgpt", path: "/vs/customgpt" },
    { label: "vs chatbase", path: "/vs/chatbase" },
    { label: "vs intercom-fin", path: "/vs/intercom-fin" },
    { label: "vs tidio-lyro", path: "/vs/tidio-lyro" },
    { label: "vs webspeaker", path: "/vs/webspeaker" },
    { label: "vs chatling", path: "/vs/chatling" },
  ]);
  for (const comparison of comparisonPages) {
    await probe(comparison.label, comparison.path, {}, ({ body }) => {
      if (!body.includes('href="/?surface=free-start"')) {
        throw new Error("comparison page did not render the durable free-start CTA anchor");
      }
      if (!body.includes("Compare Site Rep with")) {
        throw new Error("comparison page missing the comparison cluster section");
      }
    });
  }

  await probe("trust status", "/api/public/trust-status", {}, ({ body }) => {
    const data = parseJson(body);
    if (!data.ok || data.product !== "Site Rep") throw new Error("trust status payload was not for Site Rep");
    if (data.certificationStatus !== "not_certified") throw new Error("trust status must not imply certification");
    assertReleaseFreshness("trust status", data.releaseStatus);
    if (!Array.isArray(data.confirmedControls) || data.confirmedControls.length < 5) throw new Error("trust status missing confirmed controls");
    if (!Array.isArray(data.notClaimed) || !data.notClaimed.length) throw new Error("trust status missing not-claimed guardrails");
    if (!Array.isArray(data.needsReview) || !data.needsReview.length) throw new Error("trust status missing review gaps");
  });

  await probe("release status", "/api/public/release-status", {}, ({ body }) => {
    const data = parseJson(body);
    if (!data.ok || data.product !== "Site Rep") throw new Error("release status payload was not for Site Rep");
    assertReleaseFreshness("release status", data.release);
    if (data.launchReady !== false) throw new Error("release status must not imply launch readiness");
    // Internal launch-gate checklists must NOT be public — they read as
    // "no real customer has ever paid" to buyers doing diligence.
    if (Array.isArray(data.productionProofRequired) || Array.isArray(data.notLaunchProof)) {
      throw new Error("release status leaks internal launch-gate checklists");
    }
  });

  // Public honesty check: the live demo must answer and cite from real
  // sources, and refuse unsupported questions. allPass is derived from the
  // same shared evals the page and the trust material use, so a citation
  // regression on the live demo now fails the canary the same way it fails
  // the public endpoint.
  await probe("honesty check", "/api/public/honesty-check", {}, ({ body }) => {
    const data = parseJson(body);
    if (data.product !== "Site Rep") throw new Error("honesty-check payload was not for Site Rep");
    const citations = data.citations;
    const citationsOk = citations.passed === citations.total;
    if (!data.allPass || !citationsOk) {
      throw new Error(
        `honesty check failed: allPass=${data.allPass}, citations ${citations.passed}/${citations.total}`,
      );
    }
  });

  // Privacy-safe public funnel instrumentation must stay on the live bundle.
  // The scout re-files on 2026-08-09 and 2026-08-10 ("closed twin still missing
  // on the live bundle") were false positives: the scout searched the deployed
  // JS for third-party analytics tokens (plausible/posthog/gtag/funnel_event/
  // trackEvent), which the first-party allow-listed beacon never used. Pin the
  // real delivery contract from docs/funnel-instrumentation.md instead: the
  // SPA bundle must contain the collection path and every allow-listed event
  // name, and the collection endpoint must keep answering 204 even for an
  // invalid payload — the collector drops invalid payloads by design and never
  // records them, so this probe cannot pollute the aggregate counters.
  await probe(
    "funnel event collection",
    "/api/public/funnel-event",
    {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ event: "monitor_probe_never_recorded" }),
    },
    ({ response }) => {
      if (response.status !== 204) throw new Error("funnel collection must answer 204 no matter what");
    },
  );
  await probe("funnel instrumentation bundle", "/", {}, async ({ body }) => {
    const assetMatch = body.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
    if (!assetMatch) throw new Error("homepage did not reference the SPA bundle");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let bundleResponse;
    try {
      bundleResponse = await fetch(absoluteUrl(assetMatch[0]), { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!bundleResponse.ok) throw new Error(`SPA bundle fetch failed with ${bundleResponse.status}`);
    const bundle = await bundleResponse.text();
    if (!bundle.includes("/api/public/funnel-event")) {
      throw new Error("live bundle missing the public funnel collection path");
    }
    for (const eventName of FUNNEL_EVENT_NAMES) {
      if (!bundle.includes(eventName)) {
        throw new Error(`live bundle missing allow-listed funnel event: ${eventName}`);
      }
    }
  });

  await probe("llms", "/llms.txt", {}, ({ body }) => {
    if (!body.includes("Site Rep")) throw new Error("llms.txt missing Site Rep");
  });

  await probe("sitemap", "/sitemap.xml", {}, ({ body }) => {
    assertSitemapFreshness("sitemap", body);
  });

  // The dashboard install-preview iframe loads /widget-test.html with a query
  // string. Cloudflare's default html_handling 307-redirects the .html file
  // to its dot-less twin, which the worker's unknown dot-less 404 gate then
  // rejects — so a regression makes the preview (and the Google
  // site-verification file) 404 in production. html_handling: "none" serves
  // the file as-is; this probe fails loudly if that regresses.
  await probe("widget preview html", "/widget-test.html", {}, ({ response, body }) => {
    if (response.status !== 200) throw new Error("widget-test.html must be served directly with HTTP 200");
    if (!body.includes("Site Rep Install Preview")) throw new Error("widget-test.html served the wrong document");
  });

  if (monitorBotId && monitorPublicKey) {
    const widgetQuery = `botId=${encodeURIComponent(monitorBotId)}&publicKey=${encodeURIComponent(monitorPublicKey)}`;
    const widgetHeaders = {
      origin: monitorOrigin,
      referer: `${monitorOrigin.replace(/\/+$/, "")}/`,
    };
    await probe("widget config", `/api/public/config?${widgetQuery}`, { headers: widgetHeaders }, ({ body }) => {
      const data = parseJson(body);
      if (data.botId !== monitorBotId || !data.widgetSettings) throw new Error("widget config incomplete");
      if (!data.sourceManifest || typeof data.sourceManifest.sourceCount !== "number") throw new Error("widget config missing source manifest summary");
      if (!data.abuseProtection || data.abuseProtection.enabled !== false) throw new Error("widget config abuse protection should be present and off by default");
    });
    await probe(
      "widget install",
      "/api/public/install",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...widgetHeaders,
        },
        body: JSON.stringify({
          botId: monitorBotId,
          publicKey: monitorPublicKey,
          href: `${monitorOrigin.replace(/\/+$/, "")}/`,
          title: "Site Rep synthetic monitor",
        }),
      },
      ({ body }) => {
        const data = parseJson(body);
        if (!data.ok || !Array.isArray(data.installs)) throw new Error("install proof did not return installs");
      },
    );
    await probe(
      "widget cited chat",
      "/api/public/chat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...widgetHeaders,
        },
        body: JSON.stringify({
          botId: monitorBotId,
          publicKey: monitorPublicKey,
          question: "What does it cost?",
          sessionId: `synthetic-cited-${syntheticRunId}`,
        }),
      },
      ({ body }) => {
        const data = parseJson(body);
        assertHonestCitedAnswer("pricing demo", data);
        // The generic pricing question must quote the four named-plan prices
        // the live #public-pricing section renders — never a paraphrase.
        assertPricingQuotesNamedPlans("pricing demo", data);
        // The public payload is visitor-safe: conversation carries only an id.
        if (Object.keys(data.conversation || {}).some((key) => !["id"].includes(key))) {
          throw new Error("public chat response leaks owner-side conversation fields");
        }
      },
    );
    await probe(
      "widget install chat",
      "/api/public/chat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...widgetHeaders,
        },
        body: JSON.stringify({
          botId: monitorBotId,
          publicKey: monitorPublicKey,
          question: "How do I install it?",
          sessionId: `synthetic-install-${syntheticRunId}`,
        }),
      },
      ({ body }) => {
        const data = parseJson(body);
        // This is a suggested demo question; it must get a real cited answer,
        // never a refusal and never a narrated non-answer.
        assertHonestCitedAnswer("install demo", data);
      },
    );
    await probe(
      "widget natural pricing chat",
      "/api/public/chat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...widgetHeaders,
        },
        body: JSON.stringify({
          botId: monitorBotId,
          publicKey: monitorPublicKey,
          question: "What does it cost?",
          sessionId: `synthetic-natural-${syntheticRunId}`,
        }),
      },
      ({ body }) => {
        const data = parseJson(body);
        // The exact public demo CTA for pricing must get a real cited answer
        // and the live quote must not be paraphrased into an amount.
        assertHonestCitedAnswer("natural pricing demo", data);
        assertQuoteNotParaphrased("natural pricing demo", data);
      },
    );
    await probe(
      "widget refusal chat",
      "/api/public/chat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...widgetHeaders,
        },
        body: JSON.stringify({
          botId: monitorBotId,
          publicKey: monitorPublicKey,
          question: "Can it file my taxes?",
          sessionId: `synthetic-refusal-${syntheticRunId}`,
        }),
      },
      ({ body }) => {
        const data = parseJson(body);
        if (!data.answer || !data.conversation?.id) throw new Error("refusal chat did not return an answer and conversation");
        if (!data.unknown) throw new Error("unsupported demo question was not refused");
        if (Array.isArray(data.sources) && data.sources.length > 0) throw new Error("unsupported demo refusal returned citations");
      },
    );
    await probe(
      "widget trust chat",
      "/api/public/chat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...widgetHeaders,
        },
        body: JSON.stringify({
          botId: monitorBotId,
          publicKey: monitorPublicKey,
          question: "What trust controls are confirmed?",
          sessionId: `synthetic-trust-${syntheticRunId}`,
        }),
      },
      ({ body }) => {
        const data = parseJson(body);
        // Public demo CTA: the trust question must get an honest cited answer.
        assertHonestCitedAnswer("trust demo", data);
      },
    );
  } else {
    failures.push("Widget config/install/chat synthetic requires a bot id and public key. Defaults should use the public demo unless explicitly cleared.");
  }
}

if (strictMode && warnings.length) failures.push(...warnings.map((warning) => `strict warning: ${warning}`));

const summary = {
  ok: failures.length === 0,
  baseUrl: baseUrl.toString().replace(/\/$/, ""),
  checks,
  warnings,
  failures,
  widgetMonitor: {
    botId: monitorBotId,
    origin: monitorOrigin,
    source: process.env.SITEREP_MONITOR_BOT_ID || process.env.SITEREP_MONITOR_PUBLIC_KEY ? "env" : "public-demo-default",
  },
  generatedAt: new Date().toISOString(),
  expectedReleaseMarker,
};

console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exit(1);
