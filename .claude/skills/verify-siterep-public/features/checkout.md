# Feature: Paid checkout `/api/payments/dodo/checkout`

A buyer picks a paid plan. The Worker creates a Dodo Payments checkout session
and returns its URL. Dodo's webhook (`/api/payments/dodo/webhook`) then activates
the workspace. Money path: never drive it against production.

## How users reach it

Homepage `#public-pricing` -> a paid plan's button -> the checkout modal
(email, website) -> `POST /api/payments/dodo/checkout` -> redirect to Dodo.

## How to drive it

```bash
B=http://127.0.0.1:8787; E=/tmp/verify-siterep-public; mkdir -p $E
curl -sS -o $E/billing.json $B/api/health/deep
curl -sS -o $E/checkout-bad.json -w '%{http_code}\n' -X POST $B/api/payments/dodo/checkout -H 'content-type: application/json' \
  -d '{"email":"nope","siteUrl":"example.com","plan":"starter"}' > $E/checkout-bad.code
curl -sS -o $E/checkout.json -w '%{http_code}\n' -X POST $B/api/payments/dodo/checkout -H 'content-type: application/json' \
  -d '{"email":"verify-buyer@example.com","siteUrl":"example.com","plan":"starter"}' > $E/checkout.code
```

## What observable state proves success

- `checkout-bad.code` is 400, body `{"error":"Valid email is required."}`.
- With no payment keys loaded (local runs and PR previews today):
  `jq '.billing | {ready, reason, dodo: .dodo.configured}' $E/billing.json` gives
  `ready:false`, `reason:"missing_payment_provider_config"`, `dodo:false`, and
  `checkout.code` is 500 with `{"error":"Payment server error."}`. That is the
  expected state, not a pass of the paid path.
- A full pass needs a Dodo test-mode key in `.dev.vars` (never committed). Then
  `billing.dodo.configured` is true and `checkout.code` is 200 with an
  `https://` Dodo test checkout URL. Only the owner can add that key.
