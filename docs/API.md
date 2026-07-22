# REST API

> Formal companions to this walkthrough: [SPEC.md](./SPEC.md) (the normative protocol
> rules) and [openapi.yaml](./openapi.yaml) (the machine-readable API description —
> point an OpenAPI client generator at it for a typed SDK).

The full agent-side lifecycle a real AI agent would call. The web UI consumes this exact
API. Base URL: `http://localhost:3210/api`. All bodies are JSON; all amounts are
**integer cents** of simulated USD. Errors return `{"error": "message"}` with `400`
(validation), `404` (not found), or `409` (state/ledger conflict).

Seeded ids used in the examples: agent `1` (Realtor Assistant Agent), Bufete Herrera's
offer `1`.

## Agent lifecycle

### 1. Search offers

```bash
curl -s "http://localhost:3210/api/offers?q=lawyer+Costa+Rica+company+hotel"
# optional filters: &category=legal|tourism|real-estate|accounting  &location=costa+rica
```

Keywords are AND-matched (case- and accent-insensitive) across the offer title/description/steps
and the SMB name/category/location/capabilities, so `habilitacion` finds `habilitación`. Results are ranked by **SMB rating score
(good − bad) desc, then price asc**. Each result carries the SMB profile, vetted badge,
rating aggregate, price, escrow terms, and the granular step list.

### 2. Create an engagement (contract draft)

```bash
curl -s -X POST http://localhost:3210/api/engagements \
  -H 'content-type: application/json' \
  -d '{"offer_id": 1, "agent_id": 1}'
```

Snapshots the offer's steps into a `draft` engagement. Steps are editable only in draft
(`PATCH /engagements/:id/steps/:stepId` with `{"title","description"}`); posting the
same offer+agent again returns the existing draft instead of a duplicate.

### 3. Agree — lock the contract

```bash
curl -s -X POST http://localhost:3210/api/engagements/1/agree
```

`draft → agreed`. Steps and terms are now immutable — any step modification returns 409.

### 4. Fund escrow (downpayment)

```bash
curl -s -X POST http://localhost:3210/api/engagements/1/fund
```

`agreed → funded`. Moves the upfront % (e.g. 20% of $5,000 = $1,000) from the agent's
account into the engagement's escrow account. 409 with `insufficient funds` if the agent
cannot cover it. The SMB cannot mark steps before this.

### 5. Poll engagement status

```bash
curl -s http://localhost:3210/api/engagements/1
```

Returns state, steps with proofs, escrow balance, terms, parties, rating.
List with filters: `GET /engagements?agent_id=1&state=submitted`.

### 6. Verify: approve or reject

```bash
# Approve → settlement: remaining 80% auto-drawn from the agent, full price released
# to the SMB, escrow zeroed, state 'completed'. Atomic; double release impossible.
curl -s -X POST http://localhost:3210/api/engagements/1/approve

# …or reject → state 'disputed', held for the arbiter
curl -s -X POST http://localhost:3210/api/engagements/1/reject \
  -H 'content-type: application/json' \
  -d '{"reason": "Step 3 permit number does not verify"}'
```

### 7. Rate the SMB

```bash
curl -s -X POST http://localhost:3210/api/engagements/1/rate \
  -H 'content-type: application/json' -d '{"value": "good"}'   # or "bad"
```

Only after settlement (`completed`/`resolved`), once per engagement. Feeds the SMB's
aggregate and re-ranks search results.

## SMB side

```bash
# Register (vetting badge auto-granted)
curl -s -X POST http://localhost:3210/api/smbs -H 'content-type: application/json' -d '{
  "name": "Nuevo Notarios", "category": "legal", "location": "Costa Rica",
  "description": "Notary services", "capabilities": "notary, apostille"}'

# Publish an offer with granular steps and escrow terms
curl -s -X POST http://localhost:3210/api/offers -H 'content-type: application/json' -d '{
  "smb_id": 8, "title": "Apostille a document bundle", "price_cents": 25000,
  "upfront_pct": 50,
  "steps": [{"title": "Receive documents"}, {"title": "Apostille at ministry"},
            {"title": "Return bundle"}]}'

# Mark a step complete with proof (engagement must be funded / in_progress)
curl -s -X POST http://localhost:3210/api/engagements/1/steps/2/complete \
  -H 'content-type: application/json' \
  -d '{"proof_text": "Registered — receipt #CR-1001", "proof_url": "https://example.com/r.pdf"}'

# Submit for verification (409 unless ALL steps are done with proof)
curl -s -X POST http://localhost:3210/api/engagements/1/submit
```

## Arbiter

```bash
curl -s http://localhost:3210/api/disputes         # disputed + resolved engagements
curl -s -X POST http://localhost:3210/api/engagements/1/resolve \
  -H 'content-type: application/json' -d '{"ruling": "split"}'   # release | refund | split
```

Rulings apply to the escrowed funds: `release` → SMB, `refund` → agent, `split` → 50/50.

## Health

```bash
curl -s http://localhost:3210/api/health  # {"status":"ok","plan":"base","ledger_ok":true}
```

Unauthenticated, never mutates anything — cheap enough for systemd/Caddy/uptime checks
to poll directly. `ledger_ok` is the same invariant `/ledger/invariant` reports.

## Ledger & lookups

```bash
curl -s http://localhost:3210/api/ledger            # accounts + transactions + invariant
curl -s http://localhost:3210/api/ledger/invariant  # {"ok":true,...} — must always hold
curl -s http://localhost:3210/api/users             # role dropdown: agents, smbs, arbiters
curl -s http://localhost:3210/api/agents/1          # agent balance
curl -s http://localhost:3210/api/smbs/1            # SMB profile: rating, balance, offers
curl -s http://localhost:3210/api/offers/1          # one offer with steps
```

## State machine (server-enforced)

```
draft → agreed → funded → in_progress → submitted → completed
                                                  ↘ disputed → resolved
```

Server-side invariants: escrow funded before work starts · submit only with 100% steps
proven · funds released only on approve or arbiter ruling · no double release ·
sum(balances) always equals sum(minted).

## Pacta endpoints (server started with `npm run start:pacta`, port 3220)

```bash
curl -s http://localhost:3220/api/config              # {"plan":"pacta","features":{...}}
curl -s http://localhost:3220/api/agent/manifest      # machine-readable tool list (MCP-ready)
curl -s http://localhost:3220/api/registry/CR-RN-2026-104512   # public-record lookup

# Post stake (simulated external deposit; grants/restores the Vetted badge)
curl -s -X POST http://localhost:3220/api/smbs/9/stake \
  -H 'content-type: application/json' -d '{"amount_cents": 50000}'

# Registration accepts an initial stake; without one the SMB is NOT vetted
curl -s -X POST http://localhost:3220/api/smbs -H 'content-type: application/json' -d '{
  "name": "Bonded Legal SA", "category": "legal", "location": "Costa Rica",
  "stake_cents": 50000}'

# Registry-anchored steps require a matching registry_ref to complete
curl -s -X POST http://localhost:3220/api/engagements/1/steps/1/complete \
  -H 'content-type: application/json' \
  -d '{"proof_text": "S.R.L. incorporated", "registry_ref": "CR-RN-2026-104512"}'
```

Pacta behavior changes: engagements against unvetted SMBs → 409 · `agree` enforces the
exposure cap (5× stake + 50% completed GMV) → 409 with the exact amounts · adverse
arbiter rulings slash the stake (`refund` 20%, `split` 10% of price, bounded by the
stake) and auto-revoke the badge at zero · SMB payloads include `stake_cents`,
`exposure_cap_cents`, `active_exposure_cents`.

## MCP server

`mcp/server.js` exposes the full agent lifecycle as MCP tools over stdio
(`search_offers`, `get_offer`, `create_engagement`, `agree_to_contract`,
`fund_escrow`, `get_engagement`, `wait_for_provider_submission`,
`verify_registry_reference`, `approve_and_release_payment`,
`reject_and_open_dispute`, `rate_provider`, `get_my_balance`).

```json
{ "mcpServers": { "marketplace": {
    "command": "node", "args": ["mcp/server.js"],
    "env": { "MARKETPLACE_URL": "http://localhost:3220", "AGENT_ID": "1" } } } }
```

Point any MCP-capable agent at it (e.g. `claude --mcp-config that-file.json`), or run
the packaged end-to-end demo: `npm run demo:agent` / `npm run demo:agent:claude`.
