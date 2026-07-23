# Governance

Pacta is open trust infrastructure for agentic commerce. Anything built on top of it
depends on the protocol staying predictable, so changes to the protocol carry more
weight than changes to a demo or the docs. This document describes how decisions are
made. It is intentionally lightweight for the project's current stage and will grow
more formal as the community does.

## Maintainers

The project is currently maintained by **Jaf** (`@JafCR`). Maintainers review
and merge pull requests, triage issues, and decide on protocol-level proposals.

## Two tiers of change

### 1. Ordinary changes — just open a pull request

Bug fixes, tests, documentation, refactors, and changes to the reference explorer
(`public/`) or demo scripts. Open a PR, keep it focused, keep the tests green. A
maintainer reviews and merges.

### 2. Protocol-level changes — open a proposal first

A change is **protocol-level** if it alters any of:

- the REST or MCP API shape (routes, request/response fields, tool surface);
- the staking, slashing, or collateral economics;
- the graduated exposure cap;
- the engagement state machine (`draft → agreed → funded → in_progress → submitted →
  completed | disputed → resolved`);
- the registry-verification rules for proofs.

A purely **additive, read-only, unauthenticated** route that leaves every existing
route's shape and behavior untouched is not protocol-level and needs no proposal; the
issue that specifies it is enough. The `GET /api/health` liveness check is the
reference example.

Because these ripple out to every agent and app on the protocol, open a **proposal**
before writing the code. A proposal is just a GitHub issue (or Discussion) that lays
out:

- **Motivation** — the problem, and who feels it.
- **Design** — the proposed change, concretely.
- **Backward compatibility** — what breaks for existing integrations, and the
  migration path.
- **Alternatives** — what else was considered, and why this option.
- **Impact** — security, escrow-safety, and trust implications.

A maintainer marks the proposal accepted (rough consensus, no sustained objection)
before the implementing pull request is merged.

## Decision process

Decisions are made by rough consensus among maintainers. When there is no objection, a
change proceeds. When there is disagreement, maintainers discuss in the open on the
issue or Discussion until a decision is reached; the maintainers have the final say.

## Evolving this process

As external contribution grows, this will graduate to numbered **Pacta Improvement
Proposals (PIPs)** with a dedicated template and an index. Until there is real volume,
the two-tier process above is deliberately kept simple.
