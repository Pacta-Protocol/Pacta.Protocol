# ADR-001: Cryptographic Agreement Immutability (Phase 0)

- **Status:** Accepted (August 2026)
- **Deciders:** CTO / core team
- **Tags:** trust-layer, cryptography, blockchain, architecture

## Context

Pacta manufactures trust from mechanisms: staking, escrow, registry-anchored proofs, rules-based arbitration. However, agreements, ratings, stake balances and dispute rulings live solely in Pacta's database. Every guarantee therefore rests on an unstated assumption: that Pacta never rewrites history. Feedback from advisors and early reviewers challenged this and suggested representing each agreement as an immutable smart contract managing its lifecycle on-chain.

A full architecture review (see the "Smart Contracts & the Trust Layer" review document) decomposed Pacta's trust assumptions:

- **S1 Custody:** Pacta holds escrow and stake funds. Heaviest assumption; removable only by an on-chain vault or a regulated escrow partner.
- **S2 History integrity:** Pacta could silently rewrite agreements/ratings/rulings. Cheaply removable with cryptography.
- **S3 Verification:** connecting real-world work to digital state (the oracle problem). Not removable by any chain; already mitigated by registry-anchored proofs that buyers re-verify independently.

The review identified the **sole-writer problem** with the suggested design: with verification, custody and arbitration all off-chain, an on-chain lifecycle contract only records what Pacta's key relays. It removes S2 at maximum cost while leaving S1 and S3 untouched, and adds gas, key management, immutable-bug risk and iteration drag pre-product-market-fit.

## Decision

Adopt the **Certificate Transparency pattern** for agreements (Phase 0), and defer any funds-bearing smart contract (Phase 1) behind an explicit market trigger.

1. **Canonical agreements, dually signed.** Agreement terms are serialized with RFC 8785 (JCS) and hashed with SHA-256; `agreement_hash` is the universal engagement ID. Buyer and provider sign the hash via EIP-712 (secp256k1). EIP-712 is chosen over Ed25519 solely for forward compatibility with a potential Phase 1 escrow vault.
2. **Hash-chained append-only event log.** Every lifecycle event appends an entry containing the previous entry's hash. Database triggers forbid UPDATE/DELETE. Evidence bytes and free text never enter the log; only hashes and metadata.
3. **Public anchoring, event-only contract.** A permissionless ~10-line `AnchorRegistry` contract on a low-cost L2 emits `Anchored(root, fromSeq, toSeq, sender)`; it writes no storage and holds no funds. Anchoring runs on a hybrid cadence: debounced batching minutes after activity, plus a daily heartbeat anchor whose absence itself signals a problem. No business data ever reaches the chain.
4. **Receipts and an independent verifier.** Each party receives signed receipts with Merkle inclusion proofs to anchored roots. An open-source verifier (CLI + browser page) with zero backend dependencies lets anyone confirm integrity, or prove tampering, without Pacta's cooperation.

## Consequences

**Positive**
- S2 is eliminated as a trust assumption: tampering by anyone, including Pacta, becomes mathematically provable by receipt holders.
- Cost is weeks of engineering and cents per day of gas; no user-facing crypto friction (clients never touch a chain; SMBs sign via passkeys, custodially at launch with disclosure).
- The data model (agreement hash as ID, EIP-712 signatures) is exactly what a Phase 1 vault would consume, so the future option is bought without building it.
- Strictly reduces attack surface: no money-moving code is added, silent-rewrite attacks are removed.

**Negative / accepted trade-offs**
- Custody (S1) is unchanged: users still trust Pacta's ledger for funds. Deliberate; revisit when custody objections appear in real deals or regulation forces the issue (defined trigger, see roadmap).
- The guarantee is detectability, not physical prevention; it depends on receipts living outside Pacta and on the verifier being usable. Hence both are open source and receipts ride in MCP responses by default.
- Events not yet anchored (minutes-scale window) carry a weaker guarantee, mitigated by immediate counter-signed receipts.
- New (small) ops surface: gas wallet, anchoring monitor, chain choice.

## Alternatives considered

- **Full on-chain agreement lifecycle (as suggested by reviewers):** rejected for the sole-writer problem; highest cost, weakest incremental guarantee. Intent honored via this ADR's mechanism instead.
- **On-chain lifecycle + AI verifiers as settlement authority:** rejected; makes prompt injection a money-moving exploit and re-centralizes trust in the model operator.
- **Decentralized oracle network for registry facts:** rejected; Pacta's facts are bespoke and single-source (government APIs), so N oracle nodes re-serve one trust root at added cost. Buyer-side re-verification already collapses relay trust.
- **Trusted timestamping (RFC 3161) or witness co-signing instead of a chain:** viable for existence proofs, weaker for the no-fork/uniqueness property and for permissionless verification; a public L2 anchor is cheaper to verify globally. May be added as a complementary witness later.
- **Storage-writing anchor contract:** rejected in favor of event-only logs (receipts-trie commitment is equally immutable at a fraction of gas; no contract needs to read anchors on-chain).

## Revisit triggers

- Custody objections in three or more real deals, or regulatory guidance making internal-ledger custody untenable → activate Phase 1 (minimal non-custodial escrow vault; design already specified).
- Agent-economy standards convergence (ERC-8004 / AP2 / x402) with concrete partner pull → evaluate interop adapters (Phase 2).
- Evidence that the passkey/custodial signing UX blocks SMB onboarding → re-evaluate key custody modes.
