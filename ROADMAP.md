# Roadmap

Where Pacta is going, in order. Versions are intentions, not promises: the
[CHANGELOG](CHANGELOG.md) records what actually shipped, and the
[spec](docs/SPEC.md) is versioned separately from the implementation.

## v0.1.0 - shipped

The full trust loop, working end to end: engagement lifecycle, escrow on a
double-entry ledger, collateralized vetting with exposure caps and slashing,
registry-anchored proofs, dispute rulings, ratings, and the MCP server that
exposes all of it to any agent. Two example apps (LandBridge, MedVoyage) consume
the protocol without modifying it. See the
[v0.1.0 release](https://github.com/Pacta-Protocol/Pacta.Protocol/releases/tag/v0.1.0).

## v0.2.0 - registries get real

The proof-of-concept simulates the public registry in its own database. This
release makes that boundary pluggable:

- [x] A registry adapter interface between the protocol and any source of
  official records (`src/registry.js`). The in-database registry is now the
  `local` reference adapter, and a generic `http` adapter plugs in any gateway
  speaking a minimal JSON contract. Shipped on `main`.
- [x] A first external adapter against a real public source: the `hacienda-cr`
  adapter queries the public lookup of Costa Rica's tax authority (Ministerio
  de Hacienda), which unlike the Registro Nacional needs no login. Read-only
  and best-effort, but real records. Shipped on `main`.
- [ ] Conformance notes in the spec so third parties can write adapters for
  their own jurisdictions.

This is the jump from demo to infrastructure: same protocol, real registries.

## Phase 0 - cryptographic agreement immutability - shipped

Removing the "trust Pacta not to rewrite history" assumption, per
[ADR-001](docs/adr/001-cryptographic-immutability.md). The Certificate
Transparency pattern applied to agreements, not an on-chain lifecycle:

- [x] Canonical agreements (RFC 8785 + SHA-256, `agreement_hash` as the
  universal engagement id) dually signed with EIP-712. Custodial keys are the
  disclosed launch default; self-custody is a one-call upgrade. Shipped on `main`.
- [x] Hash-chained append-only event log guarded by triggers; signed receipts
  with Merkle inclusion proofs. Shipped on `main`.
- [x] Public anchoring through an event-only `AnchorRegistry` contract written by
  a single authorized anchorer, one domain-separated Merkle root per 12h window,
  always emitting (empty windows included); `local` adapter by default, `rpc`
  adapter for Base/any EVM chain ([ADR-002](docs/adr/002-windowed-anchoring-base.md)).
  Shipped on `main`.
- [x] An independent open-source verifier (`packages/verifier`, plus a browser
  page) that proves history intact, or tampering, without Pacta. Shipped on `main`.
- [ ] Deploy `AnchorRegistry` to **Base mainnet** and run the anchoring loop
  against it once a funded anchorer wallet and RPC are provisioned
  (`scripts/deploy-anchor-registry.js` is ready); add receipts-trie verification
  to the indexer.

Deliberately out of scope: custody of funds stays on the internal ledger. Phase
1 (a minimal non-custodial escrow vault) is designed but gated behind an
explicit market trigger.

## v0.3.0 - production hardening

What separates a trustworthy PoC from something you can point real money at:

- [x] API keys for agents and SMBs, opt-in via `REQUIRE_API_KEYS=1`; the open
  default remains the documented simulation boundary. Shipped on `main`.
- [x] Rate limiting (`RATE_LIMIT_PER_MIN`, default 600). Shipped on `main`.
- [x] Idempotency keys on money-moving operations. Shipped on `main`.
- [x] Webhooks for the provider side, HMAC-signed, replacing polling for state
  changes. Shipped on `main`.
- [ ] An honest gaps document listing anything that still separates the
  implementation from production use
  ([#9](https://github.com/Pacta-Protocol/Pacta.Protocol/issues/9)).

## Exploring - unscheduled

- **Settlement adapters.** The ledger is integer-cents double-entry with a
  conservation invariant; a stablecoin or on-chain settlement adapter is a
  natural module. Note this is distinct from the anchoring that already shipped
  in Phase 0: anchoring publishes tamper-evidence roots (no funds), settlement
  would move value on-chain (funds). Documented as roadmap so it never derails
  the core.
- **Second vertical example: agriculture.** Agronomists and soil labs with
  registry-verified certifications, following the LandBridge template.
- **Real-world pilot.** 3 to 5 Costa Rican SMBs in a sandbox, with published
  metrics: engagements settled through escrow, proofs verified against the
  registry, disputes exercised end to end.
- **The rest of the game theory.** Vouching, loser-pays dispute fees and staked
  juries are designed in
  [the game theory of vetting](https://pactaprotocol.org/docs/vetting.html)
  but not yet wired in.

## Contributing

Small, focused PRs are welcome at any point on this map. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).
