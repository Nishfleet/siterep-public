import { captureException, withSentry } from "@sentry/cloudflare";

// Error reporting is opt-in: with no SENTRY_DSN secret the plain handlers run
// untouched, so local dev, tests, and unconfigured deploys behave exactly as
// before.
export function sentryEnabled(env) {
  return typeof env?.SENTRY_DSN === "string" && env.SENTRY_DSN.trim() !== "";
}

export function sentryOptions(env) {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || "production",
    release: env.SITEREP_RELEASE_COMMIT || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
  };
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const REDACTED_EMAIL = "[email]";
const MAX_SCRUB_DEPTH = 12;

function redactStrings(value, depth = 0) {
  if (typeof value === "string") return value.replace(EMAIL_PATTERN, REDACTED_EMAIL);
  if (!value || typeof value !== "object" || depth > MAX_SCRUB_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactStrings(item, depth + 1);
  return out;
}

// Visitor leads (names, emails, phone numbers, chat text) arrive in request
// bodies, so an error report keeps only the method and path of the request:
// no body, query string, cookies, headers, or user identity, and any
// email-shaped string left anywhere in the event is redacted.
export function scrubSentryEvent(event) {
  if (!event || typeof event !== "object") return event;
  const scrubbed = { ...event };
  delete scrubbed.user;
  if (scrubbed.request) {
    const request = {};
    if (scrubbed.request.method) request.method = scrubbed.request.method;
    if (scrubbed.request.url) {
      try {
        const url = new URL(scrubbed.request.url);
        request.url = `${url.origin}${url.pathname}`;
      } catch {
        // Unparseable URL: drop it rather than risk a query string leaking.
      }
    }
    scrubbed.request = request;
  }
  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(({ data, ...crumb }) => crumb);
  }
  return redactStrings(scrubbed);
}

export function reportError(error) {
  // No-op when no Sentry client is active (SENTRY_DSN unset).
  captureException(error);
}

// Wraps a Worker export object. Every handler on it (fetch, scheduled, and any
// email/queue handler added later) goes through withSentry when SENTRY_DSN is
// set and straight to the original handler when it is not. `overrides` swaps
// in a Sentry-only variant of a handler.
export function withOptionalSentry(handler, overrides = {}) {
  const instrumented = withSentry(sentryOptions, { ...handler, ...overrides });
  const exported = {};
  for (const name of Object.keys(handler)) {
    exported[name] = (input, env, ctx) =>
      sentryEnabled(env) ? instrumented[name](input, env, ctx) : handler[name](input, env, ctx);
  }
  return exported;
}
