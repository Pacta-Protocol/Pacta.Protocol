# Changelog

All notable changes to the Pacta reference implementation are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) - while
on 0.x, minor bumps may carry breaking changes and each entry says so explicitly.

The protocol **specification** ([docs/SPEC.md](docs/SPEC.md)) is versioned
separately from this implementation; every release states which spec version it
implements, so independent implementations can target the spec without tracking
this codebase.

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
