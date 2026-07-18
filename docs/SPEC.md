# Pacta Protocol Specification

**Spec version:** 0.1.0 (Draft)
**Covers:** reference implementation `pacta` 0.1.x
**License:** MIT

This document specifies the Pacta protocol precisely enough that an independent party
can implement a compatible marketplace, client, or provider without reading the
reference implementation. Where the reference implementation and this document
disagree, that is a bug in one of them; please open an issue.

The spec is versioned separately from the implementation. Breaking changes to the
rules in this document bump the spec minor version while it stays 0.x, and will bump
the major version once stabilized.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are to
be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Overview

Pacta is a protocol for **agentic commerce with real-world counterparties**: an AI
agent hires a registered small business (SMB) under a contract that enforces itself.
Trust is manufactured from four mechanisms, all specified here:

1. **Escrow** — the buyer's money is held by a neutral account; neither side can
   touch it until the work is verified (§6, §7).
2. **Staking** — providers post collateral; the "vetted" badge exists only while
   collateral is at risk, and open work is capped relative to it (§8).
3. **Registry verification** — deliverables anchor to records in a public registry
   that the buyer independently re-checks (§9).
4. **Slashing** — losing a dispute costs the provider part of its stake (§8.4).

A conforming marketplace exposes the protocol over two equivalent surfaces:

- a **REST API** (normatively described by [`openapi.yaml`](./openapi.yaml), which
  is part of this specification), and
- an **MCP server** wrapping the buyer-side lifecycle as tools any MCP-capable
  agent can call (§12).

### 1.1 Profiles

The protocol defines two profiles. A server MUST report which one it runs via
`GET /api/config`:

| Profile | `plan` value | Behavior |
| --- | --- | --- |
| **Base** | `base` | Vetting is granted at registration (trust is asserted). No staking, no exposure caps, no slashing, no registry verification. |
| **Pacta** | `pacta` | Vetting is collateralized (§8). Registry-anchored steps require verifiable proofs (§9). Adverse rulings slash the stake (§8.4). |

Everything in this document applies to both profiles unless marked **[Pacta]**.
The Base profile exists as a contrast baseline; new deployments SHOULD run Pacta.

### 1.2 Architecture

One engine, two equivalent surfaces. The MCP server holds no state and no
privileged path: it wraps the public REST API 1:1, so an agent going through
MCP can do exactly what a backend going through REST can, and nothing more.

```mermaid
flowchart LR
  subgraph consumers ["Agents and applications"]
    AG["MCP agents<br/>(Claude, ROMA, any MCP client)"]
    BE["Backends and scripts"]
    UI["Reference explorer UI"]
  end
  MCP["MCP server<br/>(stdio, 12 tools)"]
  API["REST API"]
  subgraph engine ["Protocol engine"]
    LC["Lifecycle state machine (§4)"]
    ES["Escrow and settlement (§5, §7)"]
    ST["Staking, caps, slashing (§8)"]
    RG["Registry verification (§9)"]
  end
  DB[("SQLite<br/>double-entry ledger (§6)")]
  AG --> MCP
  MCP --> API
  BE --> API
  UI --> API
  API --> LC
  API --> ES
  API --> ST
  API --> RG
  LC --> DB
  ES --> DB
  ST --> DB
  RG --> DB
```

Example applications (LandBridge, MedVoyage) live outside this diagram: they
are MCP or REST consumers like any other, and MUST NOT require protocol
modifications to function.

---

## 2. Actors

| Actor | Description |
| --- | --- |
| **Agent** | The buying side: an AI agent (or program) acting for a person or company, with a money balance. |
| **SMB / provider** | A registered business selling real-world services as offers. Owns a money balance and, under Pacta, a stake (collateral) balance. |
| **Arbiter** | A neutral party that rules on disputes. The arbiter controls only escrowed funds and slashing, never party balances directly. |
| **Marketplace** | The neutral system of record: it hosts the ledger, enforces every state transition server-side, and never trusts a client. |
| **Public registry** | An external source of official records (company registry, permits, tax authority) used to verify proofs. The reference implementation mocks it; production deployments plug real registries in via the same lookup contract (§9.1). |

---

## 3. Data model

### 3.1 Money

- All amounts are **integer cents** of a single currency. Implementations MUST NOT
  use floating-point money anywhere in the protocol surface.
- Account balances MUST NOT go negative (§6.2).

### 3.2 Entities

| Entity | Key fields | Notes |
| --- | --- | --- |
| `agent` | `id`, `name` | Unique name. |
| `smb` | `id`, `name`, `category`, `location`, `description`, `capabilities`, `vetted` | Unique name. `vetted` is derived state under Pacta (§8.1). |
| `arbiter` | `id`, `name` | |
| `offer` | `id`, `smb_id`, `title`, `description`, `price_cents > 0`, `upfront_pct ∈ [0,100]`, `active`, steps | A published, reusable service listing. |
| `offer_step` | `position`, `title`, `description`, `verification_kind?` | Ordered. `verification_kind` marks a registry-anchored step **[Pacta]**. |
| `engagement` | `id`, `offer_id`, `agent_id`, `smb_id`, `title`, `price_cents`, `upfront_pct`, `state`, `dispute_reason?`, `resolution?` | One contract instance. Terms and steps are **snapshotted** from the offer at creation; later offer edits MUST NOT affect existing engagements. |
| `engagement_step` | `position`, `title`, `description`, `status ∈ {pending, done}`, `proof_text?`, `proof_url?`, `verification_kind?`, `proof_registry_ref?`, `proof_verified` | |
| `account` | `kind ∈ {agent, smb, escrow, stake}`, `ref_id`, `balance_cents ≥ 0` | One per `(kind, ref_id)`. `escrow` accounts reference an engagement; the others reference their owner. |
| `transaction` | `engagement_id?`, `from_account_id?`, `to_account_id`, `amount_cents > 0`, `type`, `memo` | Append-only journal. `from_account_id = NULL` denotes a mint (§6.1). |
| `registry_record` | `ref` (unique), `kind`, `title`, `issued_to`, `details` | The public registry's record shape (§9). |
| `rating` | `engagement_id` (unique), `smb_id`, `value ∈ {good, bad}` | At most one rating per engagement (§11). |

---

## 4. Engagement lifecycle

### 4.1 States

```
draft → agreed → funded → in_progress → submitted → completed
                                                  ↘ disputed → resolved
```

`completed` and `resolved` are terminal.

### 4.2 Transitions

Every transition MUST be validated server-side; a request from a state not listed
in "From" MUST fail with `409` and MUST NOT change anything.

| # | Action | From | To | Actor | Preconditions and effects |
| --- | --- | --- | --- | --- | --- |
| T1 | `create` | — | `draft` | agent | Snapshots the offer's title, price, upfront % and steps. **[Pacta]** MUST fail `409` if the SMB is not vetted (§8.1). If an open `draft` already exists for the same `(offer, agent)`, the server MUST return it instead of creating a duplicate. |
| T2 | `agree` | `draft` | `agreed` | both parties | Locks the contract. **[Pacta]** MUST fail `409` if it would push the SMB past its exposure cap (§8.3). After this point steps are immutable (§4.3). |
| T3 | `fund` | `agreed` | `funded` | agent | Transfers `upfront_cents` (§5) from the agent's account to the engagement's escrow account. Fails `409` on insufficient funds, leaving the state unchanged. |
| T4 | *first step completion* | `funded` | `in_progress` | provider | Implicit: completing any step while `funded` moves the engagement to `in_progress`. |
| T5 | `submit` | `funded`, `in_progress` | `submitted` | provider | MUST fail `409` unless **every** step is `done` with a non-empty `proof_text`. |
| T6 | `approve` | `submitted` | `completed` | agent | Settlement (§7.2). |
| T7 | `reject` | `submitted` | `disputed` | agent | Requires a `reason`; stored as `dispute_reason`. Escrow stays held. |
| T8 | `resolve` | `disputed` | `resolved` | arbiter | Requires a `ruling ∈ {release, refund, split}` (§7.3). **[Pacta]** Applies slashing (§8.4). |

Step completion (allowed in `funded` and `in_progress`) is not a state transition
but has its own preconditions: the step MUST NOT already be `done`, a non-empty
`proof_text` is REQUIRED, and registry-anchored steps have additional requirements
(§9.2). Completing a step in `agreed` MUST fail `409` — escrow first, work second.

### 4.3 Contract immutability

While `draft`, either party MAY edit a step's title and description. From `agreed`
onward, any attempt to modify steps MUST fail with `409`. This is the protocol's
core promise: **the contract an agent funds is the contract that gets verified.**

---

## 5. Escrow terms

For an engagement with price `P` and upfront percentage `u`:

- `upfront_cents = round(P × u / 100)` (half-up rounding to the nearest cent)
- `remaining_cents = P − upfront_cents`

The upfront part moves to escrow at T3 (`fund`); the remainder is drawn from the
agent at T6 (`approve`) — see §7.2. A dispute therefore adjudicates only what is in
escrow at the time (the upfront money plus nothing else), which bounds each side's
loss: the agent risks at most the downpayment, the provider risks unpaid work plus
its slashable stake.

---

## 6. Ledger

The ledger is the marketplace's system of record for money. It is double-entry in
journal form: every movement is one row in the transaction journal plus balance
updates on the affected accounts.

### 6.1 Minting

Money enters the system only by **minting**: a transaction whose
`from_account_id` is `NULL`. Mints represent external deposits (seed balances,
stake deposits — money that exists outside the marketplace and enters it). All
other transactions MUST move money between two existing accounts.

### 6.2 Transfer rules

A transfer MUST:

- have a positive integer `amount_cents`,
- fail (`409`, "insufficient funds") if the source balance is lower than the
  amount — overdrafts are impossible by construction,
- atomically debit the source, credit the destination, and append exactly one
  journal row.

Any multi-step money operation (fund, approve, resolve) MUST run inside a single
database transaction so that a partial failure rolls back completely (§7.4).

### 6.3 Transaction types

| `type` | Meaning |
| --- | --- |
| `seed` | Mint: external deposit (seed balance or stake deposit — distinguishable by the destination account kind and memo). |
| `escrow_fund` | Agent → escrow (downpayment at T3, remainder at T6). |
| `escrow_release` | Escrow → SMB (full release on approval, or `release` ruling). |
| `refund` | Escrow → agent (`refund` ruling). |
| `split_release` / `split_refund` | Escrow → SMB / escrow → agent halves of a `split` ruling. |
| `stake_slash` | Stake → agent **[Pacta]** (§8.4). |

### 6.4 The invariant

At all times:

> **INV-1:** Σ all account balances = Σ all minted amounts, and
> **INV-2:** every account's balance = Σ its credits − Σ its debits, replayed from
> the journal.

A conforming server MUST expose the invariant check (`GET /api/ledger/invariant`)
and it MUST hold after every request. Auditors SHOULD verify it after settlement
and after every dispute resolution.

---

## 7. Settlement

### 7.1 Escrow account

Each engagement has its own escrow account (`kind = escrow`, `ref_id =
engagement id`), created lazily at funding. Neither party has any operation that
withdraws from it; only settlement (§7.2) and rulings (§7.3) move escrowed money.

### 7.2 Approval (T6)

In one atomic transaction:

1. If `remaining_cents > 0`, transfer it agent → escrow (`escrow_fund`). Fails
   `409` on insufficient funds, in which case nothing changes and the engagement
   stays `submitted`.
2. Transfer the entire escrow balance escrow → SMB (`escrow_release`).
3. Set state `completed`.

Because the release and the state flip share one transaction, **double release is
structurally impossible** — a second `approve` fails the state check (T6) before
any money moves.

### 7.3 Rulings (T8)

The ruling disposes of the **escrow balance held at ruling time** (`H`):

| Ruling | Escrow disposition | Journal types |
| --- | --- | --- |
| `release` | all `H` → SMB | `escrow_release` |
| `refund` | all `H` → agent | `refund` |
| `split` | `floor(H/2)` → agent, `H − floor(H/2)` → SMB (the odd cent goes to the SMB) | `split_refund`, `split_release` |

The ruling is recorded as `resolution` and the state set to `resolved`, atomically
with the transfers and any slashing (§8.4).

### 7.4 Atomicity

Fund, approve and resolve MUST each be all-or-nothing. If any internal transfer
fails, the whole operation MUST roll back — no state change, no partial payout,
invariant intact.

---

## 8. Staking and vetting [Pacta]

Trust is collateralized, not asserted. All constants in this section are protocol
parameters with the reference values given; a deployment MAY tune them but MUST
publish them.

### 8.1 The vetted badge

> **vetted ⇔ stake balance > 0**

- Registering with `stake_cents > 0` grants the badge immediately; registering
  without a stake creates an **unvetted** SMB.
- Posting stake (at registration or any later top-up) is a mint into the SMB's
  stake account and MUST set `vetted = 1`.
- A stake drained to zero (by slashing) MUST clear the badge automatically (§8.4).
- Creating an engagement against an unvetted SMB MUST fail `409` (T1). Unvetted
  SMBs and their offers remain visible in search (marked `vetted: false`) so the
  gate is observable, but they cannot be hired.

### 8.2 Stake deposits

Stake arrives from outside the platform (in production: a bank deposit or bond;
in the reference implementation: a simulated deposit). It is therefore a **mint**
into the SMB's stake account — INV-1 keeps holding. `amount_cents` MUST be a
positive integer.

### 8.3 Exposure cap

An SMB's open contract value is capped relative to what it has at risk and what
it has proven:

> **cap = 5 × stake + floor(0.5 × completed GMV)**

where *completed GMV* is the summed price of its engagements in state
`completed` (lifetime). An engagement counts against the cap while in any of the
**active states** `{agreed, funded, in_progress, submitted, disputed}` (a `draft`
costs nothing; terminal states release the exposure).

`agree` (T2) MUST fail `409` — with the cap, current exposure and the shortfall
in the message — if `active exposure + price > cap`. New SMBs therefore start
with small engagements and graduate: more stake or more completed work raises
the cap.

Reference constants: `CAP_STAKE_MULTIPLE = 5`, `CAP_GMV_SHARE = 0.5`.

### 8.4 Slashing

An adverse ruling costs the SMB part of its stake, paid **to the agent** as
compensation, in the same atomic transaction as the ruling:

| Ruling | Slash (% of engagement price) |
| --- | --- |
| `release` | 0% |
| `split` | 10% |
| `refund` | 20% |

> **penalty = min(stake balance, round(price × pct / 100))**

The transfer has type `stake_slash`. If the slash empties the stake, the badge
MUST be cleared (`vetted = 0`) in the same transaction — a provider that cheated
loses both money and status, and must re-stake to sell again.

---

## 9. Registry verification [Pacta]

### 9.1 The registry contract

The public registry is a lookup: `ref → { ref, kind, title, issued_to, details,
created_at }`, or not-found. The reference implementation ships a mock registry
table; a production deployment substitutes real sources (company registry,
municipal permits, tax authority) behind the same contract. `kind` is an open
vocabulary (the seed data uses `incorporation`, `land_eligibility`, `permit`,
`tax_filing`); a deployment MUST document its kinds.

### 9.2 Registry-anchored steps

A step with a `verification_kind` can only be completed with evidence that
verifies itself. On step completion the server MUST:

1. require a `registry_ref` (else `400`),
2. fail `409` if no registry record has that `ref`,
3. fail `409` if the record's `kind` ≠ the step's `verification_kind` — a real
   record of the wrong kind is not proof,
4. on success, store the ref and mark the step `proof_verified`.

### 9.3 Independent re-verification

Server-side checking does not replace buyer diligence: the agent SHOULD re-verify
every `proof_registry_ref` itself via the registry lookup before approving
(the MCP tool `verify_registry_reference` exists for exactly this). The trust
model is *trust, but verify, twice*: once by the platform at completion time,
once by the buyer at settlement time.

---

## 10. Search and ranking

`GET /api/offers` implements discovery:

- Only `active` offers are searchable.
- `q` is split on whitespace into tokens; each token MUST match
  (case-insensitive substring, AND semantics) against the combined haystack of
  offer title + description, all step titles + descriptions, and the SMB's name,
  category, location and capabilities.
- Optional filters: `category` (exact, case-insensitive), `location`
  (substring), `vetted` (truthy value keeps only vetted SMBs).
- Ranking MUST be: SMB rating score (good − bad) descending, then price
  ascending, then id ascending. **Reputation outranks price** — that ordering is
  what makes ratings (and the settled money behind them) economically meaningful.

Note: matching is byte-level on lowercased text; implementations SHOULD consider
Unicode/accent normalization an extension (e.g. `habilitación` vs `habilitacion`)
but MUST document their behavior.

---

## 11. Ratings

- Only the engagement's agent MAY rate, only after settlement (state `completed`
  or `resolved`), value `good` or `bad`.
- At most **one rating per engagement** — reputation is tied 1:1 to real settled
  contracts, which makes it expensive to farm: each `good` costs a real, escrowed,
  verified engagement.
- The aggregate (`good`, `bad`, `score = good − bad`) feeds search ranking (§10).

---

## 12. MCP surface

A conforming marketplace SHOULD ship an MCP (Model Context Protocol) server
exposing the buyer-side lifecycle over stdio, so any MCP-capable agent can
transact without custom integration. The reference server is configured by two
environment variables — `MARKETPLACE_URL` and `AGENT_ID` (the agent it acts as)
— and it presents **summarized** payloads (formatted dollar strings, trimmed
fields) rather than raw API responses: smaller context, clearer decisions.
Tool failures MUST be reported as MCP tool errors (`isError`) carrying the
API's HTTP status and message, not as protocol crashes.

The 12 tools and their REST mappings:

| Tool | Arguments | REST call | Notes |
| --- | --- | --- | --- |
| `search_offers` | `query`, `category?` | `GET /api/offers?q=…` | Ranked per §10. |
| `get_offer` | `offer_id` | `GET /api/offers/{id}` | Steps flag `requires_registry_proof` where applicable. |
| `create_engagement` | `offer_id` | `POST /api/engagements` | Acts as `AGENT_ID`. Draft; nothing binding yet. |
| `agree_to_contract` | `engagement_id` | `POST …/agree` | T2; locks the contract. |
| `fund_escrow` | `engagement_id` | `POST …/fund` | T3; downpayment into escrow. |
| `get_engagement` | `engagement_id` | `GET …/engagements/{id}` | State, steps, proofs, verification flags, escrow balance. |
| `wait_for_provider_submission` | `engagement_id`, `timeout_seconds? (1–120, default 60)` | polls `GET …/engagements/{id}` | Returns when state leaves `funded`/`in_progress`, or with `timed_out: true`. |
| `verify_registry_reference` | `ref` | `GET /api/registry/{ref}` | §9.3 — the buyer's independent check. Not-found is an error result, which is the point. |
| `approve_and_release_payment` | `engagement_id` | `POST …/approve` | T6. Irreversible; the description MUST warn the agent to verify proofs first. |
| `reject_and_open_dispute` | `engagement_id`, `reason` | `POST …/reject` | T7. |
| `rate_provider` | `engagement_id`, `value ∈ {good, bad}` | `POST …/rate` | §11. |
| `get_my_balance` | — | `GET /api/agents/{AGENT_ID}` | |

The server also publishes a machine-readable manifest of the underlying REST
lifecycle at `GET /api/agent/manifest` for non-MCP integrators.

---

## 13. Error model

Errors are JSON: `{ "error": "human-readable message" }` with:

| Status | Meaning |
| --- | --- |
| `400` | Validation: missing/invalid fields, invalid JSON, non-integer or non-positive amounts. |
| `404` | Unknown entity, registry ref, or route. |
| `409` | Conflict with protocol rules: illegal state transition, locked contract, insufficient funds, unvetted SMB, exposure cap, wrong-kind or unknown registry record, duplicate rating, duplicate SMB name. |
| `500` | Unexpected server error (never used for rule violations). |

Messages SHOULD state the rule that was violated and, where useful, the exact
amounts involved (e.g. the exposure-cap message includes cap, current exposure
and the price being added) — agents read these.

---

## Appendix A — Reference protocol parameters

| Parameter | Value |
| --- | --- |
| `CAP_STAKE_MULTIPLE` | 5 |
| `CAP_GMV_SHARE` | 0.5 |
| `SLASH_PCT` | refund 20 · split 10 · release 0 |
| Active (exposure-counting) states | `agreed`, `funded`, `in_progress`, `submitted`, `disputed` |
| Split odd cent | goes to the SMB |
| `wait_for_provider_submission` timeout | default 60 s, max 120 s |

## Appendix B — What the reference implementation simulates

The reference implementation is a working proof of concept: the mechanics above
are fully implemented and tested, while three boundaries with the outside world
are simulated — money (minted ledger currency instead of a payment rail), the
public registry (a local table instead of live government APIs), and identity
(no authentication; clients declare who they act for). Production hardening of
those boundaries is deployment work, not protocol work: the state machine,
ledger rules, staking math and verification contract specified here are the
protocol.
