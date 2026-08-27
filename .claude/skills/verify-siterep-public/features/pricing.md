# Feature: Pricing `/api/public/pricing` + `#public-pricing`

Pricing is live-loaded from Dodo Payments (`app/lib/dodo-pricing.server.ts`-style
logic in the Worker, vars in `wrangler.jsonc`), rendered both as the
`#public-pricing` section on the homepage and as the `/api/public/pricing` JSON
endpoint. The demo chat's pricing answer must quote these prices verbatim.

## How users reach it

- Homepage: the `#public-pricing` section (`<section className="pricing
  public-pricing" id="public-pricing">`), reached by scroll or the
  `Pricing` nav link (`href="#public-pricing"`).
- API: `GET /api/public/pricing` (public, no auth).

## How to drive it

HTTP drive:

```bash
curl -fsS http://127.0.0.1:8787/api/public/pricing
# expect: 200, { ok:true, provider:"dodo", plans:[{name:"Starter", displayPrice, amountSubunits, source:"dodo_checkout_preview"}, ...] }

curl -fsS http://127.0.0.1:8787/ | grep -c '/#public-pricing"'   # >= 1 (anchor link in the shell)
```

The `#public-pricing` section itself is client-rendered (React-hydrated), so curl
only sees the `/#public-pricing` anchor link in the SPA shell, not the rendered
grid. The JSON endpoint `/api/public/pricing` is the deterministic curl proof of
the price catalog; the rendered grid is proven by the browser drive.

Browser drive: `npm run smoke:public-layout` loads `/`, then scroll to / focus
`#public-pricing` and confirm the four plans (Starter, Growth, Pro, Agency)
render with prices.

## What observable state proves success

- `GET /api/public/pricing` → 200, `plans` array contains `Starter` with a
  `displayPrice` and `amountSubunits`. Locally the Dodo product ids are
  configured in `wrangler.jsonc`, so the preview price is present; in non-strict
  mode a missing live Dodo secret is a warning, not a failure.
- Homepage HTML contains the `/#public-pricing` anchor link (the rendered
  `id="public-pricing"` section is client-side — prove it with the browser drive).
- The demo chat pricing answer quotes the same named-plan prices
  (`public-demo-chat.md`).
- `npm run monitor:local` `public pricing` probe `ok:true` (or a tolerated
  warning in non-strict local mode).

## Notes

- Region-aware pricing was removed; pricing is a single USD catalog loaded from
  Dodo. Do not assert region variants.
- `/api/pricing-preview` (if referenced anywhere) is the legacy name; the public
  contract is `/api/public/pricing`.
- Strict mode (`monitor:local --strict`) demands `provider:"dodo"` and
  `source:"dodo_checkout_preview"` — that is the production launch gate, not the
  local harness default.
