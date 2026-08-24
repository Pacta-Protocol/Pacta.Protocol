# @pacta/settlement-base

The reference **on-chain settlement backend** for the [Pacta protocol](../../README.md):
a single USDC **EscrowVault** on Base. It implements the core's `SettlementBackend`
interface (`src/settlement.js`) and registers itself as
`SETTLEMENT_BACKEND=base-escrow-vault`. **The core never imports this package.**

---

## ⚠️ Status: unaudited testnet code

- The vault contract (`contracts/EscrowVault.sol`) is **unaudited**. Do not put
  real value in it.
- It ships with a **TVL cap** (max USDC the vault will ever custody) and a
  **pause** (a minimal guardian can freeze all fund/settle/slash calls). These
  exist precisely because this is pre-audit custody code.
- No proxy, no upgradeability. The only admin surface is: pause, set the TVL cap,
  rotate the guardian.
- **Deployed address:** _not yet deployed_ — see [`.primos/blockers-wp3.md`](../../.primos/blockers-wp3.md).
  Target network is **Base Sepolia** (chainId `84532`). Nothing here claims
  mainnet.
- USDC is **Circle's official token**, not a mock ERC-20:
  Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
  Base mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

The core protocol does **not** depend on this package. Run Pacta on the default
`ledger` backend and it needs no wallet, no chain, and no crypto RPC. Base is the
reference implementation, not a requirement.

---

## What the vault does

One deployed contract holds USDC for **every** engagement — not one contract per
deal. Engagements are keyed by the `agreement_hash` (the SHA-256 identity of the
RFC-8785 canonicalized agreement, as `bytes32`).

- **Escrow per engagement.** The buyer funds an engagement; funds are accounted
  per `agreement_hash` and can never move between engagements.
- **Collateral per provider.** Provider stake lives in the same vault under a
  separate per-provider balance.
- **Settlement only against signatures.** The contract distributes escrow only
  when it recovers valid **EIP-712 secp256k1** signatures bound to the
  `agreement_hash`: either **both parties** (mutual) or the **designated arbiter**
  (dispute ruling). It does not trust a Pacta-controlled caller to assert an
  outcome — a relayer may *submit* the transaction, but only the signatures decide.
- **Slashing in code.** An adverse ruling takes provider collateral to the buyer:
  **20%** of the engagement price on a full refund, **10%** on a split, capped at
  the free collateral. The percentages live in the contract.

Passkey (WebAuthn / P-256) signatures are not verifiable on the EVM; passkey
parties map to the vault through the disclosed custodial secp256k1 fallback
(Phase 0 plan, PA-2). Same signature format on the wire.

**Out of scope by design:** on-chain lifecycle micro-states, evidence/KYB/terms
text on-chain (only hashes), oracles, per-deal contracts, any bespoke token.

---

## Address binding (the decision)

For "the contract verifies signatures" to mean anything, the contract must know
**which addresses may sign** for buyer, provider, and arbiter — and whoever
assigns those addresses must not be able to do so *after the fact*, or they would
control settlement.

**Decision:** the three EVM addresses travel **inside the canonicalized
agreement**, and therefore inside the `agreement_hash` itself. The agreement gains
an **optional, opaque `settlement` block**:

```jsonc
// inside the pacta/agreement@1 object, present only when an onchain backend is used
"settlement": {
  "backend": "base-escrow-vault",
  "chain_id": 84532,
  "vault": "0x…",            // the EscrowVault address
  "token": "0x036CbD…",      // USDC
  "addresses": { "buyer": "0x…", "provider": "0x…", "arbiter": "0x…" }
}
```

Why this is safe for the ledger flow and for existing signatures:

- The core (`src/canonical.js`) treats the block as **opaque data**. It never
  reads a chain concept from it. No chain type enters a mandatory core model.
- `canonicalize()` (RFC 8785) drops `undefined` keys, so an agreement **without**
  a settlement block hashes **byte-for-byte identically** to before. The ledger
  backend, every existing signature, and the Phase 0 receipts are unchanged. (The
  full test suite passes with the block absent.)

On-chain, the addresses are fixed at `openEngagement` and immutable after. The
open call is authenticated by **both the buyer's and the provider's** EIP-712
`OpenEngagement` signatures over the exact address set. The provider's collateral
is at stake, so it must consent to being bound to this engagement and to this
arbiter — requiring only the buyer would let a griefer open a junk engagement
naming a victim as provider and itself as arbiter, then "rule" a slash and drain
the victim's collateral. Both signatures mirror the dual-signed agreement. Anyone
can independently confirm the three on-chain addresses equal the three inside the
agreement that hashes to `agreement_hash`.

---

## How it registers (no core edit)

The core exposes `registerSettlementBackend(id, factory)` in `src/settlement.js`.
This package calls it — the core never calls this package. The **single permitted
point of contact** is `server-pacta.js`, which loads the package only when
selected and fails loudly if it is missing:

```js
// server-pacta.js
if ((process.env.SETTLEMENT_BACKEND || '').toLowerCase() === 'base-escrow-vault') {
  const { registerSettlementBackend } = require('./src/settlement');
  require('./packages/settlement-base').register(registerSettlementBackend);
}
```

`register()` receives the core's registration function, so this package has no
knowledge of the core's module layout. The chain-neutrality check
(`scripts/check-neutrality.js`) scans only the core (`src/`, `mcp/`, `server*.js`)
and does not scan this package — by design, an onchain adapter is allowed chain
code. This package happens to use **no** chain library anyway: raw JSON-RPC over
`fetch`, RLP + secp256k1 from `@noble`, exactly like `src/anchor.js`.

Selection is config, not code:

```
SETTLEMENT_BACKEND=ledger              # default — no wallet, no chain, no crypto RPC
SETTLEMENT_BACKEND=base-escrow-vault   # this package
```

Adapter env (read by `backendFromEnv`):

| Var | Meaning |
|---|---|
| `VAULT_RPC_URL` | Base RPC (e.g. `https://sepolia.base.org`) |
| `VAULT_CONTRACT_ADDRESS` | deployed EscrowVault address |
| `VAULT_CHAIN_ID` | `84532` (Base Sepolia, default) or `8453` (mainnet) |
| `VAULT_SIGNER_KEY` | relayer EOA that submits txs and pays gas |
| `VAULT_USDC_ADDRESS` | defaults to Circle USDC for the chain |

---

## Settlement authorization scheme

Distinct from the Phase 0 "I agree to the terms" signatures. The vault domain is
`EIP712Domain(name:"PactaEscrowVault", version:"1", chainId, verifyingContract)`,
so an agreement signature can never be replayed as a settlement authorization.

| Message | Signed by | Authorizes |
|---|---|---|
| `OpenEngagement(bytes32 agreementHash,address buyer,address provider,address arbiter,address token,uint256 amount)` | **buyer AND provider** | binding the address set at open |
| `Settlement(bytes32 agreementHash,uint8 outcome,uint256 buyerAmount,uint256 providerAmount)` | both parties, or arbiter | release / refund / split of escrow |
| `Slash(bytes32 agreementHash,uint8 outcome)` | both parties, or arbiter | slashing provider collateral to the buyer |

`outcome`: `1 = release`, `2 = refund`, `3 = split`. Signatures are Ethereum
`r‖s‖v` (65 bytes, v ∈ {27,28}); the contract rejects high-s (malleable)
signatures. Custodial parties are signed for platform-side; self-custody parties
supply their own signature — same rule as `/agree`.

Each engagement can be **slashed at most once** (`e.slashed` guard), since the
`Slash` digest has no nonce and would otherwise be replayable. Opening an
engagement **reserves** the provider's maximum slash exposure
(`SLASH_REFUND_PCT` of the price); that reserve cannot be withdrawn
(`withdrawCollateral` only releases `collateralOf − reserved`) until the
engagement resolves — a release settle frees it, a slash consumes it — so a
provider cannot front-run a pending slash by withdrawing.

---

## Runbooks (what the human runs after deploy)

The agent drives **the same MCP tools** in both flows; there is no agent-visible
difference from the ledger backend.

### 1. Happy path — fund → deliver → verify → release

1. Buyer `approve`s the vault to spend USDC, then the engagement is opened
   on-chain (`openEngagement`, signed by **both** buyer and provider) with the
   bound addresses. Opening reserves the provider's slash exposure.
2. `fund_escrow` → `fund(agreementHash, amount)` pulls USDC into the engagement.
3. Provider delivers; the agent verifies proofs (off-chain, unchanged).
4. `approve` → `settle(agreementHash, RELEASE, 0, funded, sigBuyer, sigProvider)`
   releases the full escrow to the provider. Visible on Basescan as a `Settled`
   event and a USDC transfer.

### 2. Dispute — refund + slash (collateral reduction visible on-chain)

1. Fund as above; provider delivers; agent `reject`s → dispute.
2. Arbiter rules `refund`:
   - `settle(agreementHash, REFUND, funded, 0, sigArbiter, 0x)` returns the escrow
     to the buyer.
   - `slashCollateral(agreementHash, REFUND, sigArbiter, 0x)` moves **20%** of the
     price from provider collateral to the buyer. The `Slashed` event and the
     provider's reduced `collateralOf` are visible on Basescan.
   - A `split` ruling is the same with `SPLIT` and a **10%** slash.

---

## Live integration (remaining wiring)

The contract and adapter are complete and unit-tested in isolation. Driving the
**live** vault through the existing `src/api.js` needs a bounded set of changes,
because the core's settlement flow is **synchronous** (it runs inside a
`better-sqlite`-style `withTx`) while an RPC vault is **async**. These are tracked
in [`.primos/blockers-wp3.md`](../../.primos/blockers-wp3.md):

1. **Async settlement.** Execute vault calls **outside** the SQLite transaction
   (the vault's atomicity comes from the contract, not from `BEGIN/COMMIT`), and
   `await` them in the `approve`/`resolve` routes.
2. **Key by `agreement_hash`.** The ledger keys escrow by numeric engagement id;
   the vault is keyed by `agreement_hash`. Build the handle with
   `engagementId: e.agreement_hash` when the vault backend is active.
3. **Open with both signatures.** `openEngagement` now needs the buyer AND the
   provider `OpenEngagement` signatures; produce both at open time (custodial
   signing for custodial parties) and pass them in `authorization.openSigs`.
4. **Outcome/slash signatures.** Produce the `Settlement` / `Slash` EIP-712
   signatures at approve/resolve time (custodial signing for custodial parties),
   and pass them in `authorization`.
5. **Address block + party→address.** Populate the agreement `settlement` block at
   `/agree` and resolve `PartyRef` → EVM address from the key registry.

Until then, `SETTLEMENT_BACKEND=base-escrow-vault` constructs the backend and
fails loudly on missing config rather than settling incorrectly.

---

## Security regressions

Three findings were confirmed against the first version with executed EVM
exploits and are now fixed, with regression tests that model each attack on a
real EVM (Foundry). Run them:

```
forge test -vv     # contracts/test/EscrowVault.t.sol
```

| Finding | Attack | Fix |
|---|---|---|
| Critical — collateral theft w/o provider consent | attacker opens a junk engagement naming a victim as provider and itself as arbiter, then "rules" a slash and drains the victim's global collateral | `openEngagement` requires **both** buyer and provider signatures over the address set |
| Critical — slash replay | the constant `Slash` digest is re-submitted N times to drain collateral | one slash per engagement (`e.slashed` guard) |
| Medium — slash evasion | provider front-runs a pending slash by withdrawing collateral | opening **reserves** the slash exposure; `withdrawCollateral` only frees the unreserved balance and is now also `notPaused` |

The suite also covers the happy path (open → fund → settle-release frees the
reserve) and the dispute path (refund + slash, collateral reduced 20%). Foundry
is separate from `npm test`; the Node adapter suite stays `node --test`.

## Known limitations (testnet, unaudited)

Two low-severity hardening observations from adversarial review remain **open by
design** for the current testnet posture (unaudited, TVL cap, pause, guardian).
They are not exploitable for theft and do not reopen any of the fixed findings;
we document them honestly rather than overstate readiness on custody code. Each
has a recommended fix for the program's hardening pass.

1. **`slashCollateral` does not check `e.settled`.** The arbiter can apply a slash
   (≤ 20% of price, taken only from *free* collateral, once) even after a clean
   `settle(RELEASE)`. It is gated by the arbiter's signature — a party the provider
   consented to when it co-signed the open — and capped and one-shot, so it is an
   authorized action, not theft. Under the protocol a RELEASE ruling never carries
   a slash, so this does not arise in normal operation.
   *Hardening:* block `slashCollateral` when the engagement was settled as RELEASE.

2. **Stranded reservation.** A `settle(REFUND/SPLIT)` that is **not** followed by
   the slash leaves the provider's reserved 20% locked: only a slash or a
   `settle(RELEASE)` frees `e.locked`, and there is no cancel/expiry. This never
   happens under the protocol (refund/split *always* carry a slash), but if the
   slash transaction is never mined after an already-executed refund, that portion
   of the provider's own collateral is stuck (locked, **not** stolen — no other
   party can take it).
   *Hardening:* couple settle+slash in one transaction, or free the reservation on
   any settle, or add an expiry that releases `e.locked`.

Both are acceptable for testnet given the pause and TVL cap; neither is a fund-loss
path. They are frozen (not changed) here to keep the verified contract state
intact.

## Develop

```
npm --prefix packages/settlement-base install   # gets @noble + pinned solc 0.8.24
npm run test:settlement-base                     # adapter unit tests (mock RPC, no network)
node packages/settlement-base/scripts/compile.js # compile the contract → build/
node packages/settlement-base/scripts/deploy.js  # DRY RUN (add --broadcast to deploy)
forge test -vv                                   # security regressions on a real EVM
```

The adapter tests run against a mock JSON-RPC — no chain, no network. They verify
call encoding, view/event decoding, uniform receipts, and that the EIP-712
signatures the adapter puts on-chain recover to the right parties under the vault
domain.
