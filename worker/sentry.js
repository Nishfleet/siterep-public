import { captureException } from "@sentry/cloudflare";
import { ROUTE_SEGMENTS } from "./sentry-route-segments.js";

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
    // Production deploys (npm run deploy:cloudflare) always set
    // SITEREP_RELEASE_DEPLOYED_AT; a local `wrangler dev` run does not.
    environment: env?.SENTRY_ENVIRONMENT || (env?.SITEREP_RELEASE_DEPLOYED_AT ? "production" : "development"),
    sendDefaultPii: false,
    // Tracing stays off: no tracesSampleRate (even 0 lets an incoming
    // sentry-trace header sample a request), and any transaction that still
    // gets built is dropped, since transactions skip beforeSend's scrubber.
    beforeSendTransaction: () => null,
    // No sentry-trace/baggage headers on outgoing fetches to third parties.
    tracePropagationTargets: [],
    integrations: (defaults) => defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubSentryEvent,
  };
  if (env?.SITEREP_RELEASE_COMMIT) options.release = env.SITEREP_RELEASE_COMMIT;
  return options;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Phone numbers and other long digit runs (order ids, card-like numbers).
const NUMBER_PATTERN = /\+?\(?\d[\d\s().-]{6,}\d/g;
const REDACTED_EMAIL = "[email]";
const REDACTED_NUMBER = "[number]";
const REDACTED_DEPTH = "[depth limit]";
const WITHHELD_MESSAGE = "[message withheld]";
const MAX_SCRUB_DEPTH = 12;
// Ids the SDK generates, the release sha, and stack-frame locations can
// contain long digit runs (hashed asset names); they carry no visitor data,
// and rewriting them would break symbolication, so the number pass leaves
// them alone.
const NO_NUMBER_REDACTION_KEYS = new Set([
  "event_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "release",
  "timestamp",
  "start_timestamp",
  "filename",
  "module",
  "abs_path",
]);
// Source lines around a stack frame. The Cloudflare SDK does not add them
// today; if a later version does, they are dropped rather than checked.
const FRAME_SOURCE_KEYS = ["context_line", "pre_context", "post_context", "vars"];

function redactText(value) {
  return value.replace(EMAIL_PATTERN, REDACTED_EMAIL).replace(NUMBER_PATTERN, REDACTED_NUMBER);
}

// Final pass over every string left in the event (tags, fingerprint, frames,
// anything the SDK adds): emails and phone-like numbers are redacted.
function redactLeftovers(value, depth = 0, key = "") {
  if (typeof value === "string") {
    return NO_NUMBER_REDACTION_KEYS.has(key) ? value.replace(EMAIL_PATTERN, REDACTED_EMAIL) : redactText(value);
  }
  if (!value || typeof value !== "object") return value;
  // Past the depth limit the value is dropped, never returned unredacted.
  if (depth >= MAX_SCRUB_DEPTH) return REDACTED_DEPTH;
  if (Array.isArray(value)) return value.map((item) => redactLeftovers(item, depth + 1, key));
  const out = {};
  for (const [childKey, item] of Object.entries(value)) out[childKey] = redactLeftovers(item, depth + 1, childKey);
  return out;
}

// Exception messages are sent only when they match a known shape that cannot
// carry visitor text: the Worker's own fixed error messages, and runtime or
// platform messages. Where a runtime message names a property key or an
// expression (which code can build from visitor input, e.g. obj[name]), the
// shape is kept and the key is replaced. Anything else (a message built from
// lead or chat fields, a third-party error body, a JSON parse error that
// quotes its input) is withheld; the error type and stack still go.
const KEEP = (message) => message;
const SAFE_MESSAGE_RULES = [
  // The Worker's own fixed messages (throw sites in worker/index.js).
  [/^(Payment ledger is not configured yet|Payment was not found|Payment return signature could not be verified|Payment claim write could not be verified|Payment activation did not return a bot ID|Admin key is required for paid activation)\.$/, KEEP],
  [/^(Dodo webhook key is not configured|Dodo API key is not configured|Dodo pricing is not available for checkout|Dodo preview did not return a display price|Dodo did not return a trusted checkout URL|Dodo checkout was not found)\.$/, KEEP],
  [/^(MCP body too large|MCP body length required|Only http and https domains are supported|Feedback rating must be up or down|Add a domain or origin first)\.$/, KEEP],
  [/^(CITEREP_STORE KV binding|CITEREP_COORDINATOR Durable Object binding) is not configured\.$/, KEEP],
  [/^(Activation failed|Dodo billing status sync failed) with \d{3}\.$/, KEEP],
  [/^(Dodo checkout|Dodo preview|Razorpay) returned \d{3}\.$/, KEEP],
  // normalizePlan only returns a PLAN_LIMITS key or "Free".
  [/^Dodo product is not configured for [A-Za-z]{1,32}\.$/, KEEP],
  [/^Razorpay is missing keys, currency, or [A-Z0-9_]{1,64}\.$/, KEEP],
  // Runtime messages: keep the shape, never the key or expression.
  [/^Cannot (read|set) properties of (undefined|null) \((reading|setting) .*\)$/s, (message) => message.replace(/\((reading|setting) .*\)$/s, "($1 '[key]')")],
  [/^.+ is not (a function|a constructor|iterable|defined)$/s, (message) => message.replace(/^.+ (is not (a function|a constructor|iterable|defined))$/s, "[expression] $1")],
  // Platform messages.
  [/^(Network connection lost|Too many subrequests|The script will never generate a response|Maximum call stack size exceeded|Unexpected end of JSON input|fetch failed|The operation was aborted|This operation was aborted|Invalid URL|Invalid URL string)\.?$/, KEEP],
  [/^internal error; reference = \w{1,64}$/, KEEP],
  [/^D1_[A-Z_]{1,32}: (UNIQUE|NOT NULL|FOREIGN KEY|CHECK) constraint failed: [\w., ]{1,200}(: SQLITE_\w{1,40})?$/, KEEP],
  [/^D1_[A-Z_]{1,32}: no such (table|column): [\w.]{1,128}(: SQLITE_\w{1,40})?$/, KEEP],
  [/^D1_[A-Z_]{1,32}: (Network connection lost|Internal error)\.?$/, KEEP],
];

export function safeMessage(message) {
  if (typeof message !== "string" || message === "") return message;
  const rule = SAFE_MESSAGE_RULES.find(([pattern]) => pattern.test(message));
  return rule ? rule[1](message) : WITHHELD_MESSAGE;
}

function scrubStacktrace(stacktrace) {
  if (!stacktrace || !Array.isArray(stacktrace.frames)) return stacktrace;
  return {
    ...stacktrace,
    frames: stacktrace.frames.map((frame) => {
      const out = { ...frame };
      for (const key of FRAME_SOURCE_KEYS) delete out[key];
      return out;
    }),
  };
}

// Keep a path segment only if it is a literal segment of a route in the
// router; every other segment (bot slugs, ids, keys, tokens) becomes ":id".
export function redactPath(pathname) {
  return String(pathname || "/")
    .split("/")
    .map((segment) => (segment === "" || ROUTE_SEGMENTS.has(segment) ? segment : ":id"))
    .join("/");
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
  return /^Scheduled Cron [\d*/,\- ]+$/.test(transaction) ? transaction : undefined;
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
// outgoing fetches only the method and status. No URL, so customer hostnames
// from crawls and source audits never leave the Worker.
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
    out.data = data;
  }
  return out;
}

function scrubException(exception) {
  if (!exception || !Array.isArray(exception.values)) return undefined;
  return {
    values: exception.values.map((value) => {
      const out = { type: value.type, value: safeMessage(value.value) };
      if (value.stacktrace) out.stacktrace = scrubStacktrace(value.stacktrace);
      if (value.mechanism) out.mechanism = { type: value.mechanism.type, handled: value.mechanism.handled };
      return out;
    }),
  };
}

// Visitor leads (names, emails, phone numbers, chat text) arrive in request
// bodies and log lines, so an error report keeps the exception type and stack,
// a message only when it has a known safe shape, the request method, and the
// request origin and path with every non-route segment redacted. No body,
// query string, cookies, headers, user, extra data, custom contexts, or
// breadcrumb text leaves the Worker.
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
  if (typeof scrubbed.message === "string") scrubbed.message = safeMessage(scrubbed.message);
  if (scrubbed.logentry) scrubbed.logentry = { message: safeMessage(scrubbed.logentry.message) };
  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
  }
  return redactLeftovers(scrubbed);
}

export function reportError(error) {
  // No-op when no Sentry client is active (SENTRY_DSN unset).
  captureException(error);
}
