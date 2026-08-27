# Feature: Public demo chat (widget + homepage)

The public demo bot (`site-rep-demo` / `sr_demo_source_backed_widget_key`) is
Nish's marketing surface: a visitor asks a question and gets an answer cited
from `PUBLIC_DEMO_SOURCES`, or an honest refusal when the approved sources do
not cover it. It powers both the homepage chat preview and the embeddable widget.

## How users reach it

- Homepage: the `ChatPreview` on `/` with the suggested questions
  `What does it cost?`, `How do I install it?`, `What trust controls are
  confirmed?`, `Can it file my taxes?` (`publicDemoQuestions` in `src/App.tsx`).
- Widget: any site loads `public/widget.js` with
  `botId=site-rep-demo&publicKey=sr_demo_source_backed_widget_key`; the widget
  calls `/api/public/config` then `/api/public/chat`.

## How to drive it

HTTP drive (the canonical path — `monitor:local` runs four chat journeys):

```bash
curl -fsS -X POST http://127.0.0.1:8787/api/public/chat \
  -H 'content-type: application/json' \
  -H 'origin: https://siterep.net' \
  -H 'referer: https://siterep.net/' \
  -d '{"botId":"site-rep-demo","publicKey":"sr_demo_source_backed_widget_key","question":"What does it cost?","sessionId":"verify-cited"}'
```

The `origin`/`referer` headers MUST match the demo bot's allowed origin
(`https://siterep.net`). `monitor:local` sets them correctly; forging them by
hand to some other value is the wrong path — use the monitor.

Refusal path:

```bash
curl -fsS -X POST http://127.0.0.1:8787/api/public/chat \
  -H 'content-type: application/json' \
  -H 'origin: https://siterep.net' \
  -d '{"botId":"site-rep-demo","publicKey":"sr_demo_source_backed_widget_key","question":"Can it file my taxes?","sessionId":"verify-refusal"}'
# expect: "unknown":true and "sources":[]
```

Browser drive (widget overlay): load `public/widget-test.html` through the
Worker (`http://127.0.0.1:8787/widget-test.html`), open the widget, ask a
suggested question. Required for any proof about the overlay UI, focus
management, or the source drawer.

## What observable state proves success

- Cited answer (`What does it cost?`): HTTP 200, `answer` is a non-empty string,
  `unknown:false`, `sources` is a non-empty array, `conversation.id` present.
  The pricing answer must quote the named-plan prices verbatim, not paraphrase
  them into an amount (`assertPricingQuotesNamedPlans` in the monitor).
- Install answer (`How do I install it?`): 200, cited answer, `unknown:false`.
- Trust answer (`What trust controls are confirmed?`): 200, cited answer.
- Refusal (`Can it file my taxes?`): 200, `unknown:true`, `sources` empty (or
  absent), `answer` and `conversation.id` still present.
- Public payload is visitor-safe: `conversation` carries only `id` — no
  owner-side fields (tickets, notes, traces, usage) leak.
- `npm run monitor:local` `widget cited chat`, `widget install chat`,
  `widget natural pricing chat`, `widget refusal chat`, and `widget trust chat`
  probes all `ok:true`.

## Notes

- The demo bot is auto-seeded on first request (`ensurePublicDemoBotRecord`),
  so a fresh local store needs no seeding step.
- `/api/public/chat/prepare` and `/api/public/chat/record` are internal widget
  steps, not user-facing question endpoints — do not drive them as the answer
  path. The answer comes from `/api/public/chat`.
- Rate limiting: 60 chat requests per 10 minutes per widget origin. A long
  verify session can trip it; space repeat drives or use a fresh sessionId.
