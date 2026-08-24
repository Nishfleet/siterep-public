// Privacy-safe public funnel instrumentation for the public site.
//
// Best-effort by design: every failure is swallowed, the visitor journey is
// never affected, and nothing is stored on the client or server except daily
// aggregate counters (see docs/funnel-instrumentation.md). No cookies are
// written or read here and no identifiers leave the page — the payload is a
// single allow-listed event name.

const FUNNEL_EVENT_NAMES = [
  "demo_opened",
  "demo_question_submitted",
  "demo_answer_completed",
  "signup_submitted",
  "signup_succeeded",
  "signup_failed",
  "checkout_opened",
  "checkout_succeeded",
  "checkout_failed",
  "signin_opened",
  "signin_succeeded",
  "signin_failed",
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENT_NAMES)[number];

const FUNNEL_API_BASE =
  import.meta.env.VITE_SITEREP_API_BASE ||
  import.meta.env.VITE_CITEREP_API_BASE ||
  (["127.0.0.1", "localhost"].includes(window.location.hostname) ? "http://127.0.0.1:8787" : window.location.origin);

const FUNNEL_EVENT_ENDPOINT = `${FUNNEL_API_BASE}/api/public/funnel-event`;

export function funnelEvent(name: FunnelEventName) {
  try {
    // Best-effort fire-and-forget. text/plain keeps this a CORS "simple
    // request" (no preflight anywhere, including cross-origin dev), and
    // credentials are explicitly omitted so no cookie could ever ride along.
    fetch(FUNNEL_EVENT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ event: name }),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  } catch {
    // Best-effort: never break the customer journey.
  }
}
