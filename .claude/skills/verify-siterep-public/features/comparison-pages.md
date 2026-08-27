# Feature: Comparison pages `/vs/*`

The `/vs/*` cluster compares Site Rep with named competitors. Each page must
render the durable free-start CTA anchor `href="/?surface=free-start"` in the
Worker-rendered HTML (no JS needed) and the comparison cluster section. A past
live-delivery defect (scout 2026-08-08) was a comparison CTA that looked right
but never reached the signup surface, so the monitor pins the real anchor in
server HTML.

## How users reach it

- The `/vs` hub and per-competitor pages: `/vs/customgpt`, `/vs/chatbase`,
  `/vs/intercom-fin`, `/vs/tidio-lyro`, `/vs/webspeaker`, `/vs/chatling`.
- Linked from the homepage / SEO; advertised in `public/sitemap.xml`.

## How to drive it

HTTP drive (the canonical path — server HTML, no browser needed):

```bash
for path in /vs /vs/customgpt /vs/chatbase /vs/intercom-fin /vs/tidio-lyro /vs/webspeaker /vs/chatling; do
  echo "== $path =="
  curl -fsS "http://127.0.0.1:8787$path" | grep -c 'href="/?surface=free-start"'   # >= 1
  curl -fsS "http://127.0.0.1:8787$path" | grep -c 'Compare Site Rep with'         # >= 1
done
```

Browser drive: `npm run smoke:public-layout` covers the SPA handoff of the
`/?surface=free-start` entry (the click-through from a comparison page to the
signup surface).

## What observable state proves success

- Every `/vs/*` page → 200, HTML contains `href="/?surface=free-start"` and
  `Compare Site Rep with`.
- `public/sitemap.xml` advertises every `/vs/*` URL with a `lastmod` at or after
  the pinned floor (see `defaultSitemapLastmodFloors` in
  `scripts/siterep-live-synthetic.mjs`).
- `npm run monitor:local` `vs hub`, `vs customgpt`, `vs chatbase`,
  `vs intercom-fin`, `vs tidio-lyro`, `vs webspeaker`, `vs chatling` probes all
  `ok:true`, and the `sitemap` probe confirms every pinned URL is present with a
  fresh enough `lastmod`.

## Notes

- The durable CTA anchor is the contract — a comparison page that renders
  copy but omits `href="/?surface=free-start"` is a regression even if it looks
  fine visually.
- Adding a new `/vs/<name>` page requires a new sitemap entry with a `lastmod`
  floor pinned in the monitor, or the sitemap probe fails loudly.
