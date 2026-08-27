# Feature: Public marketing site `/`

The homepage at `/` is the Worker-served SPA entry. A visitor lands here from
search, ads, or the comparison pages.

## How users reach it

Direct navigation to `http://127.0.0.1:8787/` (production: `https://siterep.net`).
The Worker serves the built SPA from `./dist` with `run_worker_first`, so the
HTML is fully server-rendered for the shell and the React app hydrates.

## How to drive it

HTTP drive (default):

```bash
curl -fsS http://127.0.0.1:8787/ | grep -c 'Site Rep'                 # >= 1 (title + meta)
curl -fsS http://127.0.0.1:8787/ | grep -c '/#public-pricing"'        # >= 1 (anchor link in the shell)
curl -fsS -H 'Accept: text/markdown' http://127.0.0.1:8787/ | grep -c '# Site Rep'  # >= 1
```

The homepage is a Vite SPA: the Worker serves the `dist/index.html` shell with
`run_worker_first` and `not_found_handling: single-page-application`, so curl
sees the shell (title, meta, the SPA bundle reference, and anchor links like
`/#public-pricing`) but NOT the React-rendered sections — `#public-pricing`,
the demo chat, and the feature grid are hydrated client-side. To prove those
render, use the browser drive. The markdown variant (`Accept: text/markdown`)
is the shell rendered as markdown for crawlers/agents; `public/llms.txt` is the
agent-facing product description.

Browser drive (visual — required to prove the hydrated sections render):

```bash
npm run smoke:public-layout
```

Loads `/` in chromium, firefox, and webkit via Playwright and asserts the layout
shell renders. Skips itself if `playwright` browsers are not installed.

## What observable state proves success

- `GET /` → HTTP 200, HTML contains `Site Rep` (title/meta) and the
  `/#public-pricing` anchor link.
- `GET /` with `Accept: text/markdown` → 200, body contains `# Site Rep`.
- `npm run monitor:local` `homepage html` and `homepage markdown` probes both
  `ok:true`, and the `funnel instrumentation bundle` probe confirms the SPA
  asset bundle is referenced (`/assets/index-*.js`) and contains the
  `/api/public/funnel-event` path and every allow-listed `FUNNEL_EVENT_NAMES`
  entry.
- `npm run smoke:public-layout` exits 0 (or skips cleanly with no playwright).

## Notes

- The homepage embeds the public demo chat (see `public-demo-chat.md`) and the
  pricing grid (see `pricing.md`); those are proven by their own feature files.
  Both are client-rendered, so curl alone cannot prove them — use the browser
  drive or the JSON endpoints.
- `vite preview` is NOT a valid drive for this feature — it serves the SPA with
  no Worker, so SPA fallback routing and `run_worker_first` are absent.
