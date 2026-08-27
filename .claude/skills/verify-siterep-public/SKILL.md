---
name: verify-siterep-public
description: Launch, health-check, drive, and prove the Site Rep public app (siterep-public) locally. Use before claiming any siterep-public change works end-to-end.
---

Site Rep (repo `siterep-public`) is a Cloudflare Worker plus a Vite + React SPA.
The Worker (`worker/index.js`, wired through `wrangler.jsonc`) serves the public
site, the widget endpoints, the dashboard API, and the read-only MCP surface; it
also serves the built SPA from `./dist` as static assets (`run_worker_first`,
single-page-application `not_found_handling`). The dashboard (`src/`, Vite) is
only the authoring surface for those assets — the *product* a visitor hits is the
Worker, so the harness drives the Worker, not `vite dev`.

Agents doing E2E verification MUST use this harness instead of improvising a
launch, and whoever ships a feature updates the matching file in `features/` in
the same PR.

## LAUNCH

### Primary — local Worker (use this)

The Worker is the whole public surface. Build the SPA first, then run the Worker
on loopback in fully-local mode:

```bash
npm run build          # tsc -b && vite build  -> ./dist (the assets the Worker serves)
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

`--local` is required for a token-less run: `wrangler dev` (and the repo's
`npm run cf:dev` script, which omits the flag) opens a remote proxy session for
the bindings and exits with `Failed to start the remote proxy session … set a
CLOUDFLARE_API_TOKEN` when no token is present. `--local` keeps every binding
local (Miniflare/workerd-backed KV, D1, R2, Durable Object, Workers AI), so no
Cloudflare account is touched and local state lives under `.wrangler/`. If a
`CLOUDFLARE_API_TOKEN` is exported in the environment, `npm run cf:dev` works
too — but prefer `--local` for deterministic proof that does not depend on a
live account.

- Base URL: `http://127.0.0.1:8787`. Loopback only — `cf:dev` binds
  `--ip 127.0.0.1`. Never use `localhost` for an assertion (it can resolve to
  `::1` and miss the bind).
- Readiness: `curl -fsS http://127.0.0.1:8787/api/health/live` returns 200 with
  `mode:"fast"` and `runtime:"cloudflare-worker"`. Allow up to 60s for the first
  `wasm`/asset compile. The log prints `Ready on http://127.0.0.1:8787` when
  the Worker is accepting requests.
- Launch it in the background with stdout+stderr captured to a log file, and
  record the PID:

```bash
mkdir -p /tmp/verify-siterep-public
npx wrangler dev --local --ip 127.0.0.1 --port 8787 > /tmp/verify-siterep-public/worker.log 2>&1 &
echo $! > /tmp/verify-siterep-public/worker.pid
```

A bare `&` is reaped when the launching shell exits (the dev server dies with
`ERR_IPC_CHANNEL_CLOSED`). For a verify run that outlives the launching command,
start it under `setsid` so it owns its own session, then kill the session in
CLEANUP:

```bash
setsid bash -c 'npx wrangler dev --local --ip 127.0.0.1 --port 8787 > /tmp/verify-siterep-public/worker.log 2>&1 & echo $! > /tmp/verify-siterep-public/worker.pid' < /dev/null
```

The public demo bot (`site-rep-demo` / `sr_demo_source_backed_widget_key`) is
auto-seeded from `PUBLIC_DEMO_SOURCES` on first request that needs it
(`ensurePublicDemoBotRecord`), so the widget drive works on a fresh local store
with no seeding step.

### Secondary — Vite dashboard (visual/authoring only)

```bash
npm run dev            # vite --host 127.0.0.1, port 5173
```

Hot-reloads `src/`. It does NOT serve the Worker API or the widget endpoints, so
it cannot prove any product path. Use it only for fast visual iteration on SPA
markup, then re-run the primary launch before claiming anything works.

### Never

- `npm run preview` — `vite preview` serves the built SPA statically with no
  Worker, so `/api/*`, SPA fallback routing through the Worker, and
  `run_worker_first` are all absent. It proves nothing about the product.
- `npm run dev:all` for an assertion — it backgrounds `cf:dev` with a bare `&`
  that dies when the launching shell ends and leaves the port occupied if you
  forget to kill it. Use the primary launch with a recorded PID instead.
- `wrangler deploy` from the harness — that is the production deploy path
  (`.github/workflows/deploy-production.yml`). Local proof never deploys.

## DOCTOR

`GET /api/health/live` — fast liveness, never touches storage. Healthy means
HTTP 200 with `mode:"fast"`, `runtime:"cloudflare-worker"`, and `ok:true`. The
release marker is pinned to `launch-hygiene-proof-health-2026-08-26` and the
deploy identity falls back to a worker-code stamped commit + timestamp when
`SITEREP_RELEASE_COMMIT` is unset (which is the case for `cf:dev`).

```bash
curl -fsS http://127.0.0.1:8787/api/health/live
# {"ok":true,"mode":"fast","runtime":"cloudflare-worker","release":{...}}
```

`GET /api/health/deep` — actively proves storage. Without an admin key it runs
in public-safe mode: it asserts the deep proof ran and that no owner-side counts
leak, but it does NOT assert the overall `status:"ok"`. `billing` and
`notifications` are normally `not ready` on a fresh local Worker (no Dodo /
email secrets loaded) — that is a warning, not a failure. Assert
`deepProof.recordLedger.ready`, `deepProof.sourceContent.ready`, and
`accountRbac.configured` are present; do not assert `selfServe.ready` locally
(secrets are absent by design).

```bash
curl -s http://127.0.0.1:8787/api/health/deep | grep -o '"recordLedger":{"ready":true}'
```

Page-level proof the instance is actually serving the SPA — the Worker returns
full HTML for `/`, so curl + grep is a legitimate check and a browser is only
needed for interaction or visual proof:

```bash
curl -fsS http://127.0.0.1:8787/ | grep -c 'Site Rep'
```

## DRIVE

The repo ships a canonical end-to-end drive: `scripts/siterep-live-synthetic.mjs`,
the same script the live monitor runs against `siterep.net`. Pointed at the local
Worker it exercises every public path — health, pricing, homepage (HTML +
markdown), legal pages, trust/honesty, docs install, comparison pages, release
status, honesty check, funnel instrumentation, llms.txt, sitemap, widget
preview, widget config, widget install, and four widget chat journeys (cited
pricing, install, refusal, trust).

```bash
npm run monitor:local
```

`monitor:local` sets `SITEREP_MONITOR_BASE_URL=http://127.0.0.1:8787` and
`SITEREP_MONITOR_ORIGIN=https://siterep.net` and runs in non-strict mode, so the
Dodo/email `not ready` warnings are tolerated and the public-demo bot is used by
default. It exits 0 only when every probe passes and prints a JSON summary with
`ok:true`. That single command IS the drive — run it, read its summary.

Per-feature steps and the exact observable state that proves each one live in
`features/`:

| Feature | File |
| --- | --- |
| Public marketing site `/` | `features/public-site.md` |
| Public demo chat (widget + homepage) | `features/public-demo-chat.md` |
| Pricing `/api/public/pricing` + `#public-pricing` | `features/pricing.md` |
| Widget embed `public/widget.js` + `/api/public/config` | `features/widget-embed.md` |
| Trust & honesty `/trust`, `/honesty`, `/api/public/*` | `features/trust-honesty.md` |
| Comparison pages `/vs/*` | `features/comparison-pages.md` |

Two drive styles:

- **HTTP drive** — curl against the Worker, or `npm run monitor:local`. Enough
  for CI-less proof on a server, and it sees everything the Worker rendered.
  This is the default.
- **Browser drive** — `npm run smoke:public-layout` (Playwright, chromium) or an
  interactive browser tool. Required for anything about clicking, focus, the
  widget overlay, or visual proof. `playwright` is a devDependency; if it is not
  installed the layout smoke skips itself (tests already gate on this).

### Deterministic inputs on the 8787 Worker

Fully deterministic on a plain anonymous request, no headers:

- `GET /` → 200, HTML contains `Site Rep` (title/meta) and the
  `/#public-pricing` anchor link. The rendered `#public-pricing` section is
  client-hydrated — prove it with the browser drive, not curl.
- `GET /api/public/pricing` → 200, `plans` array with `Starter` (price loaded
  from Dodo vars in `wrangler.jsonc`; locally the preview price is present).
- `POST /api/public/chat` with `{botId:"site-rep-demo",
  publicKey:"sr_demo_source_backed_widget_key", question:"What does it cost?"}`
  and headers `origin: https://siterep.net` → 200, a cited answer quoting the
  named-plan prices, `unknown:false`, and a `conversation.id`. The
  `origin`/`referer` headers must match the demo bot's allowed origin — the
  widget drive in `monitor:local` sets them correctly; forging them by hand is
  the wrong path.
- `POST /api/public/chat` with `question:"Can it file my taxes?"` → 200,
  `unknown:true`, no citations (the honest refusal path).

### Test-only surfaces — never drive these

They exist for the unit/integration suites. A manual drive of any of them proves
nothing about a real user:

- `tests/*.test.js` import paths and any `*test*` / `__test*` fixtures.
- The `x-citerep-admin-key` header against `/api/health/deep` (unlocks owner-side
  counts; the public drive never sends it).
- `/api/funnel/stats` and `/api/mcp/stats` (admin-gated owner reads).
- `scripts/siterep-live-synthetic.mjs --strict` (production launch mode; demands
  live Dodo preview pricing and fresh deploy identity that local `cf:dev` does
  not have).

## EVIDENCE

**Worker log.** `wrangler dev` prints single-line request logs and any
`console.*` output to stdout/stderr. There is no separate log file — the captured
launch log IS the log evidence.

**Monitor summary.** `npm run monitor:local` prints a JSON summary with `ok`,
`checks` (per-probe `ok`/`ms`), `warnings`, and `failures`. Save it:

```bash
npm run monitor:local > /tmp/verify-siterep-public/monitor.json 2>/tmp/verify-siterep-public/monitor.err
# then assert: jq -e '.ok == true' /tmp/verify-siterep-public/monitor.json
```

**HTML proof.** Save the fetched HTML (or the matching excerpt) for any curl
drive, e.g. `curl -fsS http://127.0.0.1:8787/ > /tmp/verify-siterep-public/home.html`.

**Screenshots** (browser drives): `npm run smoke:public-layout` writes Playwright
artifacts under its own temp dir. For an interactive browser tool, save
screenshots of `/`, `#public-pricing`, and the widget overlay to the run
directory.

**What counts as proof:** readiness 200 + doctor pass + `monitor:local` summary
`ok:true` (or the feature's observable state from its `features/` file),
captured to files outside the repo tree. A claim in a transcript is not proof.

Store evidence OUTSIDE the repo tree — a run directory under `/tmp`, or the
caller's evidence directory. Never commit evidence into this repo.

## CLEANUP

Kill the Worker by its recorded PID, and kill the process group: `wrangler dev`
spawns a `workerd` child that survives a bare SIGINT.

```bash
kill -- -"$(ps -o pgid= -p "$(cat /tmp/verify-siterep-public/worker.pid)" | tr -d ' ')" 2>/dev/null
lsof -i :8787   # must print nothing
```

- `.wrangler/` local state may be deleted or left in place; `wrangler dev`
  recreates it on next launch. Deleting it wipes the local KV/D1/R2 fixtures
  (including any widget install proofs you recorded) — fine for a clean
  re-drive.
- Leave `node_modules`, `dist/`, and `package-lock.json` untouched. `dist/` is
  gitignored and rebuilt by `npm run build`; do not commit it.
- Do not run `npm run build` as part of cleanup — it rewrites `dist/` and can
  dirty the tree if a prior build was checked in.
- Cleanup preserves evidence. Teardown never deletes the captured log, monitor
  summary, HTML, or screenshots.
