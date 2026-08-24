# ADR-002: Windowed Anchoring on Base (Base Readiness)

- **Status:** Accepted (August 2026) — **deployed and source-verified on Base mainnet** (`AnchorRegistry` `0x866316ae68b297cc2b3ed2daaf3cabd4f5e39de1`, chain id 8453) and Base Sepolia (`0xb1cb4c8d26e2457705f0ffaa823019c2ba0c4fa2`, chain id 84532) on 2026-08-23.
- **Deciders:** CTO / core team
- **Tags:** trust-layer, cryptography, base, anchoring
- **Relates to:** revises the anchoring mechanics of [ADR-001](001-cryptographic-immutability.md); the trust analysis and the Certificate-Transparency decision there still stand.

## Context

ADR-001 established the Certificate Transparency pattern: canonical dually-signed
agreements, a hash-chained append-only event log, public anchoring of Merkle
roots, and an independent verifier. It left the anchoring *mechanics*
deliberately loose: a permissionless event-only contract
(`Anchored(root, fromSeq, toSeq, sender)`), a hybrid cadence (debounced batching
plus a daily heartbeat), and a plain SHA-256 Merkle tree without domain
separation.

Making Pacta credibly "Base First" for the Base Batches 004 application (see
`INTERNAL_SPECS/Pacta-Base-Readiness-Spec.md`) requires the anchoring surface to
read as production, not as an exercise. Three concrete gaps drove this revision:

1. **Sole-writer honesty.** A permissionless contract where "verifiers filter by
   sender" invites confusion about who the writer is. Pacta is the sole writer of
   its own log; the contract should say so.
2. **Cadence legibility.** A reviewer who opens Basescan and sees sporadic
   debounced anchors plus heartbeats cannot easily tell activity from liveness.
   Two code paths (batch + heartbeat) also mean two ways to have a bug.
3. **Second-preimage resistance.** A Merkle tree without domain separation lets a
   crafted internal node be presented as a leaf. Cheap to prevent, worth
   preventing before third parties reimplement the verifier.

## Decision

Revise the anchoring mechanics; keep everything else in ADR-001.

1. **Authorized-anchorer contract.** Replace the permissionless contract with a
   single authorized anchorer:

   ```solidity
   event RootAnchored(
       uint256 indexed sequence, bytes32 indexed root,
       uint64 windowStart, uint64 windowEnd, uint32 leafCount
   );
   function anchor(bytes32 root, uint64 windowStart, uint64 windowEnd, uint32 leafCount) external; // onlyAnchorer
   function setAnchorer(address next) external;                                                    // onlyAnchorer
   ```

   Only `count` is stored (the sequence). Roots live in events. No proxy, no
   upgrade, no owner beyond rotating the anchorer key via `setAnchorer`. The
   security property is still that publication is irreversible, not access
   control; the gate simply makes the sole-writer fact explicit and keeps the log
   free of third-party noise. Deploy to **Base mainnet** (`chainId 8453`).

2. **Fixed 12h windows, always emit.** One code path. Every window (default
   `ANCHOR_WINDOW_HOURS=12`) the service anchors the entries whose timestamp
   falls in `(windowStart, windowEnd]`, **including empty windows**, which go out
   with `leafCount = 0` and the zero root. Windows are contiguous — each starts
   where the last ended — so there are no gaps; a window is recorded only after a
   successful anchor, so retries never double-anchor. A gap in the on-chain
   `sequence` is itself the liveness alarm, so no separate heartbeat path exists.
   Convention to document everywhere: **a zero-leaf anchor means "no activity in
   this window", not hidden activity.**

3. **Domain-separated Merkle tree.** Prefix leaf preimages with `0x00` and
   internal-node preimages with `0x01`:

   - leaf value = `SHA-256(0x00 || entry_hash_bytes)`
   - node value = `SHA-256(0x01 || left_bytes || right_bytes)`
   - leaves ordered by `seq`; an odd level duplicates its last node
   - a single leaf's root is its own leaf value (with domain separation a raw
     `entry_hash` can never itself be a root)
   - an empty window's root is the zero root (32 zero bytes)

   This removes the second-preimage ambiguity between leaves and nodes.

4. **Key management.** A dedicated EOA funded with a small amount of ETH on Base
   is the anchorer. Its private key comes from the environment
   (`ANCHOR_SIGNER_KEY`), never committed. Rotate via `setAnchorer(next)` from the
   current anchorer key.

## Consequences

**Positive**
- The on-chain record is legible: a monotonic sequence of ~12h anchors, each
  carrying its window and leaf count, from one known anchorer. Missing sequence
  numbers are an unambiguous alarm.
- One anchoring code path instead of two; empty windows exercise the same path,
  so the "system is alive" signal and the "system anchored real work" signal are
  the same mechanism.
- Domain separation closes a second-preimage gap before external reimplementation.
- The event carries `windowStart/windowEnd/leafCount`, so the verifier can
  cross-check a receipt's window and leaf count against the chain, not just the
  root.

**Negative / accepted trade-offs**
- Anchoring is no longer permissionless: a lost anchorer key halts anchoring
  until rotation. Accepted — Pacta is the sole legitimate writer regardless, and
  `setAnchorer` is the documented recovery path.
- Empty-window anchors cost gas for no new data. On Base this is fractions of a
  cent per window and buys an unambiguous liveness signal, so cost is not a
  factor in the cadence.
- Changing the Merkle construction and event shape is a breaking change to any
  receipt or verifier built against ADR-001's mechanics. This is pre-production
  (no external receipts exist yet), so the break is free now and expensive later.

## Alternatives considered

- **Keep the permissionless contract, add domain separation only.** Rejected: it
  leaves the sole-writer confusion and the two-path cadence, which are exactly
  what reads as "exercise" to a reviewer.
- **Owner/pause/upgrade on the contract.** Rejected: an anchor registry moves no
  funds and reads no storage; smaller is more credible, and `setAnchorer` covers
  the only real operational need (key rotation).
- **Skip empty windows (anchor only on activity) plus a heartbeat.** Rejected:
  that is ADR-001's two-path design; it makes "dead" and "quiet" hard to tell
  apart on Basescan and doubles the bug surface.
- **Store roots in contract storage.** Rejected (as in ADR-001): events are far
  cheaper and nothing on-chain needs to read an anchor.

## Revisit triggers

- A funds-bearing Phase 1 vault ships → the vault's own events/receipts may
  warrant a shared anchoring/verification surface; revisit whether anchoring and
  settlement should share a contract or stay separate (they stay separate by
  default; anchoring must never gain custody).
- Real receipts exist in the wild and a construction change becomes necessary →
  it must then be versioned, not swapped, unlike this pre-production revision.
