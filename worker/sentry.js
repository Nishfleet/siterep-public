import { captureException } from "@sentry/cloudflare";

// Error reporting is opt-in. sentryOptions feeds withSentry on every
// invocation; with no SENTRY_DSN secret it sets `enabled: false`, the SDK's
// own off switch, so no client sends anything and no integration is set up.
export function sentryEnabled(env) {
  return typeof env?.SENTRY_DSN === "string" && env.SENTRY_DSN.trim() !== "";
}

// Integrations the Worker never wants:
// - Console turns every console.log/warn/error line into a breadcrumb, and
//   existing log lines can carry lead or chat fields.
// - HttpServer reads POST bodies (visitor leads) into the event scope.
const DROPPED_INTEGRATIONS = new Set(["Console", "HttpServer"]);

export function sentryOptions(env) {
  const enabled = sentryEnabled(env);
  const options = {
    enabled,
    dsn: enabled ? env.SENTRY_DSN.trim() : undefined,
    environment: env?.SENTRY_ENVIRONMENT || "production",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // No sentry-trace/baggage headers on outgoing fetches to third parties.
    tracePropagationTargets: [],
    integrations: (defaults) => defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubAndCapEvent,
    beforeSendTransaction: scrubSentryEvent,
  };
  if (env?.SITEREP_RELEASE_COMMIT) options.release = env.SITEREP_RELEASE_COMMIT;
  return options;
}

// Per-isolate cap on error events. A 500 storm (a D1 or R2 outage, or a
// request an attacker can make fail) would otherwise send one event per
// request and burn the Sentry quota. Each isolate sends at most
// MAX_EVENTS_PER_WINDOW events per window and drops the rest.
export const MAX_EVENTS_PER_WINDOW = 20;
export const EVENT_WINDOW_MS = 60_000;

export function createEventCap({ max = MAX_EVENTS_PER_WINDOW, windowMs = EVENT_WINDOW_MS, now = Date.now } = {}) {
  let windowStart = -Infinity;
  let count = 0;
  return {
    allow() {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        count = 0;
      }
      if (count >= max) return false;
      count += 1;
      return true;
    },
    reset() {
      windowStart = -Infinity;
      count = 0;
    },
  };
}

const isolateEventCap = createEventCap();

export function resetSentryEventCap() {
  isolateEventCap.reset();
}

export function scrubAndCapEvent(event) {
  const scrubbed = scrubSentryEvent(event);
  if (!scrubbed) return null;
  return isolateEventCap.allow() ? scrubbed : null;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Phone numbers and other long digit runs (order ids, card-like numbers).
const NUMBER_PATTERN = /\+?\(?\d[\d\s().-]{6,}\d/g;
const REDACTED_EMAIL = "[email]";
const REDACTED_NUMBER = "[number]";
const REDACTED_DEPTH = "[depth limit]";
const MAX_SCRUB_DEPTH = 12;
const MAX_FREE_TEXT = 300;

function redactEmails(value, depth = 0) {
  if (typeof value === "string") return value.replace(EMAIL_PATTERN, REDACTED_EMAIL);
  if (!value || typeof value !== "object") return value;
  // Past the depth limit the value is dropped, never returned unredacted.
  if (depth >= MAX_SCRUB_DEPTH) return REDACTED_DEPTH;
  if (Array.isArray(value)) return value.map((item) => redactEmails(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactEmails(item, depth + 1);
  return out;
}

// Free text (exception messages, event messages) can quote a visitor: redact
// emails and phone-like numbers and cap the length.
function redactFreeText(value) {
  if (typeof value !== "string") return value;
  const redacted = value.replace(EMAIL_PATTERN, REDACTED_EMAIL).replace(NUMBER_PATTERN, REDACTED_NUMBER);
  return redacted.length > MAX_FREE_TEXT ? `${redacted.slice(0, MAX_FREE_TEXT)}…` : redacted;
}

// Path segments that carry an id, key or token. Bot ids are slugs of the
// customer's domain, so the routes that take one are listed explicitly; any
// other segment that looks like an id or token is redacted by shape.
const BOT_ACTION_ROUTES = new Set(["clone", "create", "reset-usage", "status"]);
const DEVELOPER_API_RESOURCES = new Set(["sources", "conversations", "leads", "retrain"]);
const TOKEN_PREFIX = /^(sr_live_|sr_|pk_|own_|unsub_|rbac_|snap_|crawl_)/i;

function looksLikeId(segment) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(segment)) return true;
  if (TOKEN_PREFIX.test(segment)) return true;
  if (/\d{6,}/.test(segment)) return true;
  return segment.length >= 20 && /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

export function redactPath(pathname) {
  const segments = String(pathname || "/").split("/");
  // segments[0] is "" for an absolute path.
  const out = segments.map((segment) => (segment === "" || !looksLikeId(segment) ? segment : ":id"));
  if (segments[1] === "api" && segments[2] === "bots" && segments.length > 3 && segments[3] !== "" && !BOT_ACTION_ROUTES.has(segments[3])) {
    out[3] = ":botId";
  }
  if (segments[1] === "api" && segments[2] === "v1" && segments[3] === "bots" && segments.length > 4) {
    out[4] = ":botId";
    if (segments.length > 5 && !DEVELOPER_API_RESOURCES.has(segments[5])) out[5] = ":id";
  }
  return out.join("/");
}

function scrubUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${redactPath(url.pathname)}`;
  } catch {
    // Unparseable URL: drop it rather than risk a query string leaking.
    return undefined;
  }
}

function scrubTransaction(transaction) {
  if (typeof transaction !== "string") return undefined;
  // "GET /api/bots/acme" style names: redact the path part.
  const match = transaction.match(/^([A-Z]+ )?(\/\S*)$/);
  if (match) return `${match[1] || ""}${redactPath(match[2].split("?")[0])}`;
  return transaction.startsWith("Scheduled Cron ") ? transaction : undefined;
}

// Contexts the SDK fills in that carry no request or visitor data. Anything
// else (culture/timezone, custom contexts, span data with URLs) is dropped.
const TRACE_CONTEXT_KEYS = ["trace_id", "span_id", "parent_span_id", "op", "status", "origin"];

function scrubContexts(contexts) {
  if (!contexts || typeof contexts !== "object") return undefined;
  const out = {};
  if (contexts.runtime) out.runtime = { name: contexts.runtime.name, version: contexts.runtime.version };
  if (contexts.cloud_resource) out.cloud_resource = { "cloud.provider": contexts.cloud_resource["cloud.provider"] };
  if (contexts.trace) {
    out.trace = {};
    for (const key of TRACE_CONTEXT_KEYS) {
      if (contexts.trace[key] !== undefined) out.trace[key] = contexts.trace[key];
    }
  }
  return out;
}

// Breadcrumbs keep only what kind of thing happened: no message text, and for
// outgoing fetches only the method, status, and origin of the URL.
export function scrubBreadcrumb(crumb) {
  if (!crumb || typeof crumb !== "object") return null;
  if (crumb.category === "console") return null;
  const out = {};
  for (const key of ["type", "category", "level", "timestamp"]) {
    if (crumb[key] !== undefined) out[key] = crumb[key];
  }
  if (crumb.data && (crumb.category === "fetch" || crumb.category === "xhr")) {
    const data = {};
    if (crumb.data.method) data.method = crumb.data.method;
    if (crumb.data.status_code !== undefined) data.status_code = crumb.data.status_code;
    try {
      if (crumb.data.url) data.url = new URL(crumb.data.url).origin;
    } catch {
      // Relative or unparseable URL: leave it out.
    }
    out.data = data;
  }
  return out;
}

function scrubException(exception) {
  if (!exception || !Array.isArray(exception.values)) return undefined;
  return {
    values: exception.values.map((value) => {
      const out = { type: value.type, value: redactFreeText(value.value) };
      if (value.stacktrace) out.stacktrace = value.stacktrace;
      if (value.mechanism) out.mechanism = { type: value.mechanism.type, handled: value.mechanism.handled };
      return out;
    }),
  };
}

// Visitor leads (names, emails, phone numbers, chat text) arrive in request
// bodies and log lines, so an error report keeps the exception type and stack,
// a redacted message, the request method, and the request origin and path
// with ids and tokens redacted. No body, query string, cookies, headers, user,
// extra data, custom contexts, or breadcrumb text leaves the Worker.
export function scrubSentryEvent(event) {
  if (!event || typeof event !== "object") return event;
  const scrubbed = { ...event };
  delete scrubbed.user;
  delete scrubbed.extra;
  delete scrubbed.server_name;
  if (scrubbed.request) {
    const request = {};
    if (scrubbed.request.method) request.method = scrubbed.request.method;
    const url = scrubbed.request.url ? scrubUrl(scrubbed.request.url) : undefined;
    if (url) request.url = url;
    scrubbed.request = request;
  }
  if ("transaction" in scrubbed) {
    const transaction = scrubTransaction(scrubbed.transaction);
    if (transaction) scrubbed.transaction = transaction;
    else delete scrubbed.transaction;
  }
  if ("contexts" in scrubbed) scrubbed.contexts = scrubContexts(scrubbed.contexts);
  if ("exception" in scrubbed) scrubbed.exception = scrubException(scrubbed.exception);
  if (typeof scrubbed.message === "string") scrubbed.message = redactFreeText(scrubbed.message);
  if (scrubbed.logentry) scrubbed.logentry = { message: redactFreeText(scrubbed.logentry.message) };
  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
  }
  return redactEmails(scrubbed);
}

export function reportError(error) {
  // No-op when no Sentry client is active (SENTRY_DSN unset).
  captureException(error);
}
