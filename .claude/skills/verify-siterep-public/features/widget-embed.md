# Feature: Widget embed `public/widget.js` + `/api/public/config`

The embeddable widget (`public/widget.js`) is what a customer installs on their
site. It fetches its config from `/api/public/config`, reports installs to
`/api/public/install`, and asks questions through `/api/public/chat` (driven in
`public-demo-chat.md`). This feature covers the config + install contract.

## How users reach it

A site owner adds `<script src="…/widget.js" data-bot-id="…" data-public-key="…">`
to their page. The widget reads `window.siterep` / `data-*` attributes, defaults
`apiBase` to `http://127.0.0.1:8787` on loopback hosts and `https://siterep.net`
otherwise, then calls `/api/public/config?botId=…&publicKey=…`.

## How to drive it

HTTP drive (config + install, the canonical path):

```bash
# Config
curl -fsS "http://127.0.0.1:8787/api/public/config?botId=site-rep-demo&publicKey=sr_demo_source_backed_widget_key" \
  -H 'origin: https://siterep.net' -H 'referer: https://siterep.net/'
# expect: 200, { botId, widgetSettings:{...}, sourceManifest:{sourceCount}, abuseProtection:{enabled:false} }

# Install ping
curl -fsS -X POST http://127.0.0.1:8787/api/public/install \
  -H 'content-type: application/json' -H 'origin: https://siterep.net' -H 'referer: https://siterep.net/' \
  -d '{"botId":"site-rep-demo","publicKey":"sr_demo_source_backed_widget_key","href":"https://siterep.net/","title":"Site Rep verify"}'
# expect: 200, { ok:true, installs:[...] }
```

Widget host smoke (browser — proves the widget renders on a real docs-style host
with sidebars, sticky headers, and a host overlay):

```bash
npm run smoke:widget-host
```

Widget preview HTML (served by the Worker, no browser needed for the contract):

```bash
curl -fsS http://127.0.0.1:8787/widget-test.html | grep -c 'Site Rep Install Preview'  # >= 1
```

## What observable state proves success

- `/api/public/config` → 200, `botId` matches, `widgetSettings` present,
  `sourceManifest.sourceCount` is a number, `abuseProtection.enabled === false`
  by default.
- `/api/public/install` → 200, `ok:true`, `installs` array present.
- `/widget-test.html` → 200, body contains `Site Rep Install Preview`.
- `npm run monitor:local` `widget config`, `widget install`, and
  `widget preview html` probes all `ok:true`.
- `npm run smoke:widget-host` exits 0 (or skips cleanly with no playwright).

## Notes

- The widget has a `docs` mode (`data-mode="docs"`) with a `mod+k` hotkey and
  docs-flavored copy; the default is `site` mode. Both share `/api/public/config`.
- Abuse protection (Turnstile) is off by default and only enabled per-bot in
  `widgetSettings`; the local drive never needs a Turnstile token.
- `public/widget.js` is a static asset served as-is; do not assert it is bundled
  or hashed. It must be served with `text/javascript; charset=utf-8`.
