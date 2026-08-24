# Site Rep

Site Rep is a source-backed website assistant for small business sites. It
answers visitor questions only from pages and sources the site owner has
approved, cites the source behind every answer, and captures high-intent leads
plus follow-up work when the approved sources do not prove an answer. The live
product runs at [siterep.net](https://siterep.net).

This repo holds the public Site Rep codebase: a Cloudflare Worker API, a Vite +
React dashboard, the embeddable widget, and the WordPress plugin.

## How the code is split

- **Worker API** (`worker/`, `server/`) — the Cloudflare Worker that serves the
  public site, the widget endpoints, the dashboard API, and the read-only MCP
  surface. Entry point is `worker/index.js`, wired through `wrangler.jsonc`.
- **Dashboard** (`src/`, `index.html`) — the Vite + React single-page app built
  into `dist/` and served as Worker static assets.
- **Widget** (`public/widget.js`) — the embeddable script sites install to show
  the Site Rep chat.
- **WordPress plugin** (`wordpress-plugin/`) — injects the widget from a
  Workspace ID + widget key. See
  [wordpress-plugin/README.md](wordpress-plugin/README.md) for layout,
  packaging, and the install contract.

## Run it locally

Two processes run side by side: the Worker API and the Vite dev server.

```sh
npm install
npm run cf:dev   # Worker API on http://127.0.0.1:8787 (wrangler dev)
npm run dev      # Vite dashboard on http://127.0.0.1:5173
```

`npm run dev:all` starts both. The Worker needs Cloudflare bindings (KV, D1,
R2, Durable Objects, Workers AI) defined in `wrangler.jsonc`; `wrangler dev`
provides local equivalents.

## Test, build, and check

```sh
npm test          # node --test tests/*.test.js
npm run build     # tsc -b && vite build
npm run cf:check  # wrangler deploy --dry-run (validates config and bundle)
```

CI (`.github/workflows/ci.yml`) runs the tests, build, layout/widget smoke
scripts, and the wrangler dry-run on every pull request.

## Deeper context

- [wordpress-plugin/README.md](wordpress-plugin/README.md) — plugin layout,
  what it injects, security, and packaging.
- [public/llms.txt](public/llms.txt) — the product description, public offer,
  and live MCP surface as plain text for agents and crawlers.
- [public/robots.txt](public/robots.txt) and [public/sitemap.xml](public/sitemap.xml)
  — crawl surface for the live site.
