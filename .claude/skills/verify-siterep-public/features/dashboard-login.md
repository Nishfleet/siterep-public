# Feature: Dashboard sign-up and sign-in `/api/free/start`, `/api/customer/login`

A site owner starts a free workspace, then signs in to the dashboard with the
workspace id and its dashboard access key. The sign-in issues a customer
session token that every owner route (`/api/leads`, `/api/customer/bot`) needs.

## How users reach it

- Homepage: "Start free — no card" opens the sign-up modal (`siteUrl`, `email`).
  It calls `POST /api/free/start` and lands on the dashboard ("Lead inbox").
- Dashboard sign-in form: site id + dashboard access key -> `POST /api/customer/login`.
- Emailed link: `POST /api/customer/access-email` sends it, `POST /api/customer/magic-session`
  claims it. Not drivable locally: there is no mailbox, so drive the key path.

## How to drive it

Each run signs up a new site and email. A repeat sign-up of the same site on
the same local store returns `status:"existing"` with no access key, because the
first sign-in keeps only a hash of the key. A repeat email returns 409.

```bash
B=http://127.0.0.1:8787; E=/tmp/verify-siterep-public; mkdir -p $E; RUN=$(date +%s)
curl -sS -o $E/free-start.json -w '%{http_code}\n' -X POST $B/api/free/start -H 'content-type: application/json' -H "origin: $B" \
  -d "{\"siteUrl\":\"verify-$RUN.example.com\",\"email\":\"verify-$RUN@example.com\",\"startedAt\":\"$(( $(date +%s%3N) - 10000 ))\"}" > $E/free-start.code
BOT=$(jq -r .customerAccess.botId $E/free-start.json); KEY=$(jq -r .customerAccess.accessKey $E/free-start.json)
curl -sS -o $E/login-ok.json -w '%{http_code}\n' -X POST $B/api/customer/login -H 'content-type: application/json' \
  -d "{\"botId\":\"$BOT\",\"accessKey\":\"$KEY\"}" > $E/login-ok.code
curl -sS -o $E/login-bad.json -w '%{http_code}\n' -X POST $B/api/customer/login -H 'content-type: application/json' \
  -d "{\"botId\":\"$BOT\",\"accessKey\":\"wrong\"}" > $E/login-bad.code
A="authorization: Bearer $(jq -r .authSession.token $E/login-ok.json)"
curl -sS -o $E/leads.json -w '%{http_code}\n' "$B/api/leads?botId=$BOT" -H "$A" > $E/leads.code
```

`startedAt` must be a few seconds in the past: the sign-up trap rejects a form
filled faster than a person can. Repeated wrong keys hit the failed-sign-in rate
limit (429), so drive the wrong key once.

Browser drive: `npm run smoke:stranger-path` does the same sign-up through the UI.

## What observable state proves success

- `free-start.code` is 200. `free-start.json` has `customerAccess.botId`,
  `customerAccess.accessKey` and `authSession.token`.
- `login-ok.code` is 200. `login-ok.json` has `authSession.role == "customer"`
  and a non-empty `authSession.token`.
- `login-bad.code` is 401. `login-bad.json` is
  `{"error":"Site ID or dashboard access key is wrong."}`.
- `leads.code` is 200. `leads.json` is a JSON array (empty for a new site).
