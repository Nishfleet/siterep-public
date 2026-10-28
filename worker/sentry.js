import { captureException } from "@sentry/cloudflare";
import { ROUTE_SEGMENTS } from "./sentry-route-segments.js";

export function sentryEnabled(env) {
  return typeof env?.SENTRY_DSN === "string" && env.SENTRY_DSN.trim() !== "";
}

const DROPPED_INTEGRATIONS = new Set(["Console", "HttpServer"]);

export function sentryOptions(env) {
  const enabled = sentryEnabled(env);
  const options = {
    enabled,
    dsn: enabled ? env.SENTRY_DSN.trim() : undefined,
    environment: env?.SENTRY_ENVIRONMENT || (env?.SITEREP_RELEASE_DEPLOYED_AT ? "production" : "development"),
    sendDefaultPii: false,
    beforeSendTransaction: () => null,
    tracePropagationTargets: [],
    integrations: (defaults) => defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubSentryEvent,
  };
  if (env?.SITEREP_RELEASE_COMMIT) options.release = env.SITEREP_RELEASE_COMMIT;
  return options;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NUMBER_PATTERN = /\+?\(?\d[\d\s().-]{6,}\d/g;
const REDACTED_EMAIL = "[email]";
const REDACTED_NUMBER = "[number]";
const REDACTED_DEPTH = "[depth limit]";
const WITHHELD_MESSAGE = "[message withheld]";
const MAX_SCRUB_DEPTH = 12;
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
const FRAME_SOURCE_KEYS = ["context_line", "pre_context", "post_context", "vars"];

function redactText(value) {
  return value.replace(EMAIL_PATTERN, REDACTED_EMAIL).replace(NUMBER_PATTERN, REDACTED_NUMBER);
}

function redactLeftovers(value, depth = 0, key = "") {
  if (typeof value === "string") {
    return NO_NUMBER_REDACTION_KEYS.has(key) ? value.replace(EMAIL_PATTERN, REDACTED_EMAIL) : redactText(value);
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_SCRUB_DEPTH) return REDACTED_DEPTH;
  if (Array.isArray(value)) return value.map((item) => redactLeftovers(item, depth + 1, key));
  const out = {};
  for (const [childKey, item] of Object.entries(value)) out[childKey] = redactLeftovers(item, depth + 1, childKey);
  return out;
}

const KEEP = (message) => message;
const SAFE_MESSAGE_RULES = [
  [/^(Payment ledger is not configured yet|Payment was not found|Payment return signature could not be verified|Payment claim write could not be verified|Payment activation did not return a bot ID|Admin key is required for paid activation)\.$/, KEEP],
  [/^(Dodo webhook key is not configured|Dodo API key is not configured|Dodo pricing is not available for checkout|Dodo preview did not return a display price|Dodo did not return a trusted checkout URL|Dodo checkout was not found)\.$/, KEEP],
  [/^(MCP body too large|MCP body length required|Only http and https domains are supported|Feedback rating must be up or down|Add a domain or origin first)\.$/, KEEP],
  [/^(CITEREP_STORE KV binding|CITEREP_COORDINATOR Durable Object binding) is not configured\.$/, KEEP],
  [/^(Activation failed|Dodo billing status sync failed) with \d{3}\.$/, KEEP],
  [/^(Dodo checkout|Dodo preview|Razorpay) returned \d{3}\.$/, KEEP],
  [/^Dodo product is not configured for (Free|Starter|Growth|Pro|Agency)\.$/, KEEP],
  [/^Razorpay is missing keys, currency, or RAZORPAY_(STARTER|GROWTH|PRO|AGENCY)_AMOUNT_SUBUNITS\.$/, KEEP],
  [/^Cannot (read|set) properties of (undefined|null) \((reading|setting) .*\)$/s, (message) => message.replace(/\((reading|setting) .*\)$/s, "($1 '[key]')")],
  [/^.+ is not (a function|a constructor|iterable|defined)$/s, (message) => message.replace(/^.+ (is not (a function|a constructor|iterable|defined))$/s, "[expression] $1")],
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
    return undefined;
  }
}

function scrubTransaction(transaction) {
  if (typeof transaction !== "string") return undefined;
  const match = transaction.match(/^([A-Z]+ )?(\/\S*)$/);
  if (match) return `${match[1] || ""}${redactPath(match[2].split("?")[0])}`;
  return /^Scheduled Cron [\d*/,\- ]+$/.test(transaction) ? transaction : undefined;
}

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
  captureException(error);
}
