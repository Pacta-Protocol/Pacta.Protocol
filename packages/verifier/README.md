# pacta-verify

Independent verifier for Pacta Phase 0 receipts ([ADR-001](../../docs/adr/001-cryptographic-immutability.md)).

Every Pacta agreement is canonically hashed and dually signed; every lifecycle
event lands in a hash-chained append-only log whose Merkle roots are anchored
to a public chain. Each party receives signed receipts. This package lets
**anyone** confirm a receipt's integrity, or produce mathematical evidence of
tampering, **without Pacta's cooperation**: it imports zero backend code,
needs no credentials, and talks only to the receipt file and (optionally) any
EVM RPC node you choose.

## Usage

```bash
# a single receipt, or the full bundle from GET /api/engagements/:id/proof
pacta-verify receipt.json

# with the platform pubkey pinned and an on-chain check via your own RPC node
pacta-verify receipt.json --pubkey 0x04… --rpc https://mainnet.base.org --sender 0x…

# machine-readable
pacta-verify receipt.json --json
```

Exit code `0` means every executed check passed; `1` means at least one FAIL.

## Checks, in order

1. **entry_hash** - recompute `SHA-256(prev_hash || canonical(entry))` from the
   receipt's own contents and compare.
2. **pacta_sig** - verify Pacta's EIP-712 signature over `entry_hash` against
   the published platform pubkey (`GET /api/keys/platform`, or `--pubkey`).
3. **agreement_hash + party signatures** (for `AgreementLocked` entries) -
   recompute the agreement hash from the embedded canonical terms and verify
   the buyer's and provider's EIP-712 signatures.
4. **merkle_proof** - walk the inclusion proof from `entry_hash` to the
   anchored root.
5. **anchor_on_chain** (`--rpc`) - fetch the anchoring transaction and confirm
   the `RootAnchored(sequence, root, windowStart, windowEnd, leafCount)` event
   matches the receipt (root, sequence, window and leaf count). With `--sender`
   it also checks the transaction's `from` matches the expected anchorer. Anchors
   with `chain_id: 0` are simulated local-development anchors and are skipped.

## Protocol formulas (reimplemented here, independently)

- **Canonical JSON**: RFC 8785 (JCS) - object keys sorted by UTF-16 code
  units, scalars serialized as `JSON.stringify` does.
- **Entry hash**: `SHA-256( utf8(prev_hash_with_0x) || canonical({seq, engagement, type, payload, at}) )`,
  hex with `0x` prefix. Genesis `prev_hash` is 32 zero bytes (`0x00…00`).
- **Merkle tree** (domain-separated): leaves are the entries whose timestamp is
  in `(windowStart, windowEnd]`, in `seq` order. A leaf's value is
  `SHA-256(0x00 || entry_hash_bytes)`; an internal node is
  `SHA-256(0x01 || left_value || right_value)`; a level with an odd node count
  duplicates its last node; a single leaf's root is its own leaf value; an empty
  window's root is 32 zero bytes. Proof steps are `{ hash, pos }` sibling values
  walked leaf → root: start the accumulator at the leaf value
  `SHA-256(0x00 || entry_hash)`, then fold each sibling with `SHA-256(0x01 || …)`.
- **Signatures**: EIP-712 over secp256k1, domain
  `{ name: "Pacta", version: "1", chainId }`, types
  `Agreement(bytes32 agreementHash,string role,string nonce)` and
  `LogEntry(bytes32 entryHash)`. Wire format `r||s||v` (65 bytes, v ∈ {27,28}).

## Trust model

- The receipt is self-contained: checks 1-4 run fully offline.
- Check 5 trusts your chosen RPC node's response for the transaction receipt
  and its logs. Run it against a node you trust (or several); receipts-trie
  proof verification against block headers is a planned hardening step.
- What this proves: the events in your receipts existed, in this order, with
  these contents, when the covering root was anchored. If Pacta (or anyone)
  rewrites history, your receipt becomes the proof of it.
