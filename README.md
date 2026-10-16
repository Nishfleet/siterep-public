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

Error reporting uses the Sentry Cloudflare SDK and stays off (`enabled: false`)
unless the `SENTRY_DSN` Worker secret is set. Reports carry the exception type,
the stack trace, the request method, and the request path with every segment
that is not a literal route segment replaced by `:id`. An exception message is
kept only when it has a known safe shape (the Worker's own fixed messages and
runtime messages built from code identifiers); any other message is withheld.
Request bodies, query strings, cookies, headers, console lines, breadcrumb text
and URLs, extra data, and custom contexts are dropped.

## Test, build, and check

```sh
npm test          # node --test tests/*.test.js
npm run build     # tsc -b && vite build
npm run cf:check  # wrangler deploy --dry-run (validates config and bundle)
```

CI (`.github/workflows/ci.yml`) runs the tests, build, layout/widget smoke
scripts, and the wrangler dry-run on every pull request.

A scheduled workflow (`.github/workflows/honesty-check.yml`) runs
`node --test tests/honesty-live.check.js` every six hours: one read-only GET of
`/api/public/honesty-check` on the live site. It fails when an answer loses its
citation, when the endpoint is unreachable, or when the answer it reads is
older than 15 minutes. A red run opens or updates the `honesty-check-red`
issue. It is not part of `npm test`, because it needs the deployed worker.
Switch it off by disabling or deleting that workflow file, or run it against a
preview host with `SITEREP_HONESTY_CHECK_URL` (and `SITEREP_HONESTY_CHECK_ORIGIN`
when the preview host is not the origin the worker expects).

## Deeper context

- [wordpress-plugin/README.md](wordpress-plugin/README.md) — plugin layout,
  what it injects, security, and packaging.
- [public/llms.txt](public/llms.txt) — the product description, public offer,
  and live MCP surface as plain text for agents and crawlers.
- [public/robots.txt](public/robots.txt) and [public/sitemap.xml](public/sitemap.xml)
  — crawl surface for the live site.
# Mon Sep  7 09:07:55 PM IST 2026
# post-fix Mon Sep  7 09:20:47 PM IST 2026
