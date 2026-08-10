# Changelog

All notable changes to the Pacta reference implementation are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) - while
on 0.x, minor bumps may carry breaking changes and each entry says so explicitly.

The protocol **specification** ([docs/SPEC.md](docs/SPEC.md)) is versioned
separately from this implementation; every release states which spec version it
implements, so independent implementations can target the spec without tracking
this codebase.

## [Unreleased]

Implements **protocol spec 0.1.0**. Additive and backward compatible: with the
default configuration every route behaves exactly as in 0.1.1. Candidate v0.2.0.

### Added

- **Cryptographic agreement immutability (Phase 0,
  [ADR-001](docs/adr/001-cryptographic-immutability.md))** - the Certificate
  Transparency pattern applied to agreements. Agreeing now canonicalizes the
  terms (RFC 8785), hashes them (`agreement_hash`, the engagement's universal
  identity) and requires both parties' EIP-712 signatures (custodial signing
  keys are the disclosed launch default; `POST /{kind}s/{id}/signing-key`
  upgrades to self-custody, with `GET /engagements/{id}/agreement-preview`
  exposing the exact digests to sign). Every lifecycle mutation appends one
  entry to a hash-chained append-only event log (UPDATE/DELETE blocked by
  triggers, free text and evidence bytes never logged - only hashes). Merkle
  roots are anchored on a hybrid cadence (`DEBOUNCE_SECONDS`,
  `HEARTBEAT_HOURS`) through the event-only permissionless
  `contracts/AnchorRegistry.sol`; the `local` adapter (default) keeps CI
  deterministic and the `rpc` adapter posts real transactions to any EVM
  chain. Both parties get signed receipts with Merkle inclusion proofs
  (`GET /api/engagements/{id}/proof`), verifiable by the new independent
  `pacta-verify` CLI (`packages/verifier`, zero backend imports), by the
  in-browser `/verify.html`, or server-side via `POST /api/verify`.
  `GET /api/integrity` replays the whole chain publicly;
  `GET /api/keys/platform` publishes the signing identity. Two new MCP tools:
  `get_agreement_proof` and `verify_agreement_integrity` (12 -> 14).
  Historical engagements are marked `pre-phase0`, never backfilled. New
  runtime dependencies: `@noble/curves`, `@noble/hashes`.
- **Pluggable registry adapters** (`src/registry.js`): the registry a proof
  verifies against is now an adapter behind one contract. The seeded SQLite
  table becomes the `local` reference adapter (still the default); the `http`
  adapter plugs in any gateway speaking a minimal JSON contract
  (`REGISTRY_URL`); the `hacienda-cr` adapter queries Costa Rica's tax
  authority public endpoint and maps a live cedula lookup to a
  `tax_registration` record. A registry that cannot answer surfaces as `502`,
  never as a verified or rejected proof. `GET /api/config` reports the active
  adapter and registry records carry a `source` field.
- **API keys**: SMB registration returns a `pk_`-prefixed key once (only the
  SHA-256 hash is stored); seeded identities claim theirs via
  `POST /agents/{id}/api-key` or `POST /smbs/{id}/api-key`, rotation requires
  the current key. With `REQUIRE_API_KEYS=1` every mutation must carry the
  right actor's key, dispute resolution requires `ARBITER_API_KEY`, and reads
  stay open.
- **Rate limiting**: fixed one-minute window per client,
  `RATE_LIMIT_PER_MIN` (default 600, `0` disables), answered with `429` and
  `Retry-After`.
- **Idempotency keys**: fund, approve, resolve and stake honor an
  `Idempotency-Key` header; the first 2xx response is stored and replayed on
  retries, so a client that times out can never move money twice.
- **Provider webhooks**: an SMB registers a URL at `POST /smbs/{id}/webhook`
  and gets an HMAC signing secret once; engagement state changes are pushed as
  signed events instead of forcing the provider to poll.

## [0.1.1] - 2026-07-23

Implements **protocol spec 0.1.0**. Additive and backward compatible: no
existing route changes shape or behavior, so any 0.1.0 integration keeps working.

### Added

- **Health endpoint** `GET /api/health`: unauthenticated, read-only liveness
  check returning `status`, `plan` (base/pacta) and `ledger_ok` (the ledger
  conservation invariant). Cheap enough for systemd, Caddy or uptime checks to
  poll directly. Pacta's first external contribution (#6, closes #4).
- **Litepaper** in English and Spanish ([docs/LITEPAPER.md](docs/LITEPAPER.md),
  [docs/LITEPAPER.es.md](docs/LITEPAPER.es.md)).
- **Public roadmap** ([ROADMAP.md](ROADMAP.md)) and an architecture diagram in
  the spec.

### Changed

- Offer search is now accent-insensitive for Spanish and Portuguese, so
  "cafe" matches "café".
- **Governance**: a purely additive, read-only, unauthenticated route is not a
  protocol-level change and needs no proposal; the issue that specifies it is
  enough. `GET /api/health` is the reference example.

[0.1.1]: https://github.com/Pacta-Protocol/Pacta.Protocol/releases/tag/v0.1.1

## [0.1.0] - 2026-07-17

First tagged release. Implements **protocol spec 0.1.0**.

### Added

- **Double-entry ledger** in integer cents with an always-checkable invariant
  (sum of balances = sum of mints; every balance replays from the journal),
  exposed at `GET /api/ledger/invariant`.
- **Engagement lifecycle** enforced server-side: `draft - agreed - funded -
  in_progress - submitted - completed`, with `disputed - resolved` as the
  dispute branch; contracts become immutable at agreement, escrow before work,
  settlement is atomic (double release structurally impossible).
- **Staking-based vetting** (Pacta profile): vetted = stake > 0, graduated
  exposure cap (5x stake + 50% of completed GMV), and stake slashing on adverse
  rulings (20% refund / 10% split) with automatic badge revocation at zero.
- **Registry-verified proofs**: steps can require a public-registry reference of
  a specific kind; the platform verifies at completion and buyers re-verify
  independently before paying.
- **MCP server** exposing the full buyer lifecycle as 12 tools over stdio, plus
  a machine-readable REST manifest at `GET /api/agent/manifest`.
- **Reference marketplace explorer** (web UI) covering all three roles: agent,
  provider and arbiter.
- **Formal protocol spec** ([docs/SPEC.md](docs/SPEC.md)) and **OpenAPI 3.1**
  description ([docs/openapi.yaml](docs/openapi.yaml)) of the REST API.
- **CI**: unit/API tests on Node 22 and 24, a 41-check REST verification
  checklist against the live server, OpenAPI lint, and a Playwright e2e suite.

[0.1.0]: https://github.com/Pacta-Protocol/Pacta.Protocol/releases/tag/v0.1.0
