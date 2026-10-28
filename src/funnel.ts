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
    fetch(FUNNEL_EVENT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ event: name }),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  } catch {}
}
