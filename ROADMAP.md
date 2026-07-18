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

- A `RegistryAdapter` interface between the protocol and any source of official
  records. The current in-database registry becomes the reference adapter.
- A first external adapter against a real public source: Costa Rica's Registro
  Nacional exposes public lookups. Read-only and best-effort, but real records.
- Conformance notes in the spec so third parties can write adapters for their
  own jurisdictions.

This is the jump from demo to infrastructure: same protocol, real registries.

## v0.3.0 - production hardening

What separates a trustworthy PoC from something you can point real money at:

- API keys for agents and SMBs (today the API is deliberately open; the spec
  documents this as a simulation boundary).
- Rate limiting.
- Idempotency keys on money-moving operations.
- Webhooks for the provider side (today providers poll for state changes).
- An honest gaps document listing anything that still separates the
  implementation from production use.

## Exploring - unscheduled

- **Settlement adapters.** The ledger is integer-cents double-entry with a
  conservation invariant; a stablecoin or on-chain settlement adapter is a
  natural module. Documented as roadmap so it never derails the core.
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
