# Feature: Lead deletion `/api/leads/delete`

The owner deletes one lead (a visitor's name and email). The Worker removes the
lead and everything that holds the visitor's data (conversation, ticket,
notifications, events, ledger rows) and writes an audit record. This is the
privacy path for a visitor's deletion request, so a partial delete is a bug.
Code: `worker/lead-deletion.js`, route in `worker/index.js`.

## How users reach it

Dashboard -> Lead inbox -> a lead -> Delete. The SPA calls `POST /api/leads/delete`
with `{botId, leadId}` and the owner session.

## How to drive it

Run `dashboard-login.md` first in the same shell: this drive needs its
`$E/login-ok.json`. `GET /api/leads` returns a bare JSON array of leads.

```bash
B=http://127.0.0.1:8787; E=/tmp/verify-siterep-public
BOT=$(jq -r .botId $E/login-ok.json); A="authorization: Bearer $(jq -r .authSession.token $E/login-ok.json)"
curl -sS -o $E/lead-add.json -w '%{http_code}\n' -X POST $B/api/leads -H "$A" -H 'content-type: application/json' \
  -d "{\"botId\":\"$BOT\",\"name\":\"Verify Visitor\",\"email\":\"visitor-delete-me@example.com\",\"question\":\"Do you ship to Pune?\"}" > $E/lead-add.code
LID=$(jq -r .id $E/lead-add.json)
curl -sS -o $E/leads-before.json "$B/api/leads?botId=$BOT" -H "$A"
curl -sS -o $E/lead-delete-noauth.json -w '%{http_code}\n' -X POST $B/api/leads/delete -H 'content-type: application/json' \
  -d "{\"botId\":\"$BOT\",\"leadId\":$LID}" > $E/lead-delete-noauth.code
curl -sS -o $E/lead-delete.json -w '%{http_code}\n' -X POST $B/api/leads/delete -H "$A" -H 'content-type: application/json' \
  -d "{\"botId\":\"$BOT\",\"leadId\":$LID}" > $E/lead-delete.code
curl -sS -o $E/leads-after.json "$B/api/leads?botId=$BOT" -H "$A"
curl -sS -o $E/lead-delete-again.json -w '%{http_code}\n' -X POST $B/api/leads/delete -H "$A" -H 'content-type: application/json' \
  -d "{\"botId\":\"$BOT\",\"leadId\":$LID}" > $E/lead-delete-again.code
```

## What observable state proves success

- `lead-add.code` is 200. `jq '[.[] | select(.email=="visitor-delete-me@example.com")] | length' $E/leads-before.json` is 1.
- `lead-delete-noauth.code` is 401.
- `lead-delete.code` is 200. In `lead-delete.json`, `deletion.ok`,
  `deletion.complete` and `deletion.audited` are true, `deletion.warnings` is
  `[]`, and `deletion.counts.leads` is 1.
- The same query on `leads-after.json` is 0.
- `lead-delete-again.code` is 404, body `{"error":"Lead not found."}`.
