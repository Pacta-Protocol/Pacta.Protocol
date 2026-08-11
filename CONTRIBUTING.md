# Contributing to Pacta.Protocol

Thanks for your interest in improving Pacta. This repository holds the **protocol**
— the REST/MCP surface, escrow ledger, staking & vetting, and the reference explorer
(the marketplace dashboard in `public/`).

> First read the org-wide guide: **[Pacta-Protocol contributing guidelines](https://github.com/Pacta-Protocol/.github/blob/main/CONTRIBUTING.md)**.
> It covers the ground rules, the pull-request flow, the sign-off (DCO), and the
> Code of Conduct that apply across every Pacta repository. This file adds only what
> is specific to *this* codebase.

## What lives here

- `src/` - the protocol core: `api.js` (REST), `ledger.js` (double-entry escrow),
  `staking.js` (stake, slashing, graduated exposure cap), `registry.js`
  (pluggable proof verification), `db.js`, `seed.js`. Phase 0 immutability
  (ADR-001) adds `canonical.js` (RFC 8785 hashing), `eip712.js` and `keys.js`
  (signatures + key custody), `eventlog.js` (hash-chained log), `merkle.js`,
  `receipts.js`, and `anchor.js` (anchoring adapters + worker).
- `mcp/` - the MCP server that wraps the REST API 1:1 as agent tools.
- `public/` - the reference explorer (vanilla-JS SPA), including `verify.html`.
  No build step.
- `packages/verifier/` - the independent, zero-backend-dependency receipt
  verifier (`pacta-verify` CLI). Keep it importing nothing from `src/`; run its
  tests with `npm run test:verifier`.
- `contracts/` - `AnchorRegistry.sol`, the event-only anchoring contract.
- `e2e/`, `tests/` - Playwright end-to-end and `node --test` unit tests.
- `scripts/` — demo clients and dev helpers.

## Prerequisites

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite` — no Docker, no external
  services, no API keys). Check with `node --version`.

## Setup

```bash
npm ci
npm run start:pacta      # serves the app on http://localhost:3220
```

## Running the tests

Both suites must pass before you open a pull request:

```bash
npm test                 # unit tests (node --test)
npm run test:e2e         # end-to-end tests (Playwright)
```

If you change behaviour, add or update a test that covers it. New API behaviour
belongs in `tests/`; new user-facing flows belong in `e2e/`.

## Making a change

1. Branch off `main`.
2. Keep the pull request small and focused on one thing.
3. Match the style of the surrounding code — comment density, naming, idioms.
4. Keep the app presentation-only where it is presentation-only: the dashboard and an
   agent both go through the **same** REST API. Don't add a privileged UI-only path.
5. Make sure `npm test` and `npm run test:e2e` are green.
6. Open the PR against `main` and fill in the template.

## Changes that touch the protocol itself

Bug fixes, docs, and tweaks to the reference explorer are ordinary pull requests.

Changes to the **protocol surface** — the REST/MCP API shape, the staking or
slashing economics, the exposure cap, or the engagement state machine — affect
everyone building on top of Pacta. Those need a short proposal first. See
**[GOVERNANCE.md](GOVERNANCE.md)**.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this repository.
