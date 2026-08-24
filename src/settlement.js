'use strict';
// SettlementBackend: the ledger-neutral seam for escrow, collateral and slashing
// (Base Readiness Spec, "P1 · Ledger-neutral settlement").
//
// The core protocol never moves money directly. It moves money through a
// SettlementBackend, and every backend satisfies one interface. Today there is
// one implementation — the internal double-entry ledger. The reference onchain
// implementation (a USDC EscrowVault on Base) is a separate package that
// registers itself here; the core does not import it, does not depend on it, and
// cannot tell which backend is running from anything but the receipt's optional
// `onchain` block.
//
// Interface (JS adaptation of the TS signature in the spec; enforced by every
// implementation):
//
//   readonly id            "ledger" | "base-escrow-vault"
//   readonly currency      "USD" | "USDC"
//
//   openEscrow({ engagementId, buyer, provider, amountMinor }) -> EscrowHandle
//   fund(handle, amountMinor, ctx?)                            -> SettlementReceipt
//   release(handle, authorization, ctx?)                       -> SettlementReceipt
//   refund(handle, authorization, ctx?)                        -> SettlementReceipt
//   split(handle, buyerMinor, providerMinor, authorization, ctx?) -> SettlementReceipt
//   escrowBalance(handle)                                      -> bigint
//   stakeBalance(provider)                                     -> bigint
//   stake(provider, amountMinor, ctx?)                         -> SettlementReceipt
//   slash(provider, amountMinor, authorization, ctx?)         -> SettlementReceipt
//
// escrowBalance(handle) is a small extension to the spec's interface. The core
// needs the held escrow amount to compute a 50/50 split ruling; it used to read
// that from the ledger's SQL directly (api.js), which does not exist against an
// onchain vault. Every backend now exposes it: the ledger reads its escrow
// account, the vault reads the contract. Same shape (integer minor units), so
// the core never branches on backend to know how much is held.
//
// Rules every implementation must hold:
//   - Integer minor units only. Amounts cross the interface as bigint (USD cents
//     and USDC base units are both integers); no floats, ever.
//   - Atomicity. An operation fully happens or fully does not. The ledger backend
//     runs inside the caller's SQLite transaction (withTx); the vault backend
//     gets atomicity from the contract call.
//   - Authorization is data, not identity. `Authorization` carries the signatures
//     bound to the agreement hash that the flow already produced at /agree. The
//     ledger backend records them; the vault backend has the contract verify them.
//     Same input shape, same semantics — no new signature scheme is invented here.
//   - SettlementReceipt is uniform. Same fields regardless of backend, with an
//     optional `onchain` block (tx hash, chain id, block number) that is null on
//     the ledger. Callers must never branch on backend type to read a receipt.
//
// PartyRef  = { kind: 'agent' | 'smb', id: number }
// EscrowHandle (ledger) = { engagementId, buyer, provider, amountMinor }
//   — opaque to callers; only the backend that minted it interprets it.
// Authorization = { agreementHash: string|null, signatures: {buyer,provider}|null }
//
// Selection mirrors src/registry.js and src/anchor.js: SETTLEMENT_BACKEND picks
// the adapter, defaulting to "ledger". External adapters register a factory via
// registerSettlementBackend(id, factory) before startup — no core edit required.

const ledger = require('./ledger');
const staking = require('./staking');

class SettlementError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Coerce an amount that crosses the interface (bigint per the spec, but Number is
// tolerated for call-site ergonomics) to an integer number of minor units. The
// ledger stores cents as JS integers; every value here is a safe integer.
function toCents(amount, label = 'amount') {
  if (typeof amount === 'bigint') {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SettlementError(`${label} exceeds the safe integer range`);
    }
    return Number(amount);
  }
  if (!Number.isInteger(amount)) {
    throw new SettlementError(`${label} must be an integer number of minor units (no floats)`);
  }
  return amount;
}

// A uniform receipt. `onchain` is null for the ledger backend and carries
// { tx_hash, chain_id, block_number } for onchain backends. `movements` is an
// informational breakdown of the double-entry rows the operation produced.
function receipt(backend, operation, { engagementId = null, amountMinor = 0, movements = [], onchain = null } = {}) {
  return {
    backend: backend.id,
    currency: backend.currency,
    operation,
    engagement_id: engagementId,
    amount_minor: BigInt(amountMinor),
    movements,
    onchain,
  };
}

// The reference implementation: the internal double-entry ledger this codebase
// has always settled against. A thin facade over src/ledger.js and src/staking.js
// — the double-entry logic stays there; this class only routes the protocol's
// escrow/collateral operations through it. Every method runs synchronously inside
// the caller's withTx() transaction, which is where its atomicity comes from.
class LedgerSettlementBackend {
  constructor(db) {
    if (!db) throw new SettlementError('LedgerSettlementBackend requires a db handle');
    this.db = db;
    this.id = 'ledger';
    this.currency = 'USD';
  }

  // Ledger escrow is keyed by the engagement; the account is created lazily on
  // the first funding move, exactly as before. The handle just carries context.
  openEscrow({ engagementId, buyer, provider, amountMinor }) {
    return {
      engagementId,
      buyer,
      provider,
      amountMinor: amountMinor === undefined ? null : BigInt(toCents(amountMinor, 'amountMinor')),
    };
  }

  // Buyer moves funds into the engagement escrow. A zero amount is a no-op that
  // still returns a receipt (0% upfront engagements have nothing to move).
  fund(handle, amountMinor, ctx = {}) {
    const cents = toCents(amountMinor, 'fund amount');
    const movements = [];
    if (cents > 0) {
      const from = ledger.getOrCreateAccount(this.db, handle.buyer.kind, handle.buyer.id);
      const to = ledger.getOrCreateAccount(this.db, 'escrow', handle.engagementId);
      ledger.transfer(this.db, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amountCents: cents,
        type: 'escrow_fund',
        memo: ctx.memo || `escrow funding for engagement #${handle.engagementId}`,
        engagementId: handle.engagementId,
      });
      movements.push({ from: handle.buyer, to: { kind: 'escrow', id: handle.engagementId }, amount_minor: BigInt(cents) });
    }
    return receipt(this, 'fund', { engagementId: handle.engagementId, amountMinor: cents, movements });
  }

  // Release the full escrow balance to the provider.
  release(handle, authorization, ctx = {}) {
    return this.#payFromEscrow(handle, [
      { party: handle.provider, amountCents: this.#escrowBalance(handle), type: 'escrow_release', memo: ctx.memo },
    ], 'release');
  }

  // Refund the full escrow balance to the buyer.
  refund(handle, authorization, ctx = {}) {
    return this.#payFromEscrow(handle, [
      { party: handle.buyer, amountCents: this.#escrowBalance(handle), type: 'refund', memo: ctx.memo },
    ], 'refund');
  }

  // Split the escrow: providerMinor to the provider, buyerMinor back to the buyer.
  split(handle, buyerMinor, providerMinor, authorization, ctx = {}) {
    const buyerCents = toCents(buyerMinor, 'buyer split');
    const providerCents = toCents(providerMinor, 'provider split');
    return this.#payFromEscrow(handle, [
      { party: handle.provider, amountCents: providerCents, type: 'split_release', memo: ctx.providerMemo },
      { party: handle.buyer, amountCents: buyerCents, type: 'split_refund', memo: ctx.buyerMemo },
    ], 'split');
  }

  // Held escrow for an engagement, in minor units — read through the backend so
  // the core never touches the ledger's SQL directly (an onchain vault has no
  // such row). See the interface note above.
  escrowBalance(handle) {
    return BigInt(this.#escrowBalance(handle));
  }

  // Provider collateral balance, in minor units.
  stakeBalance(provider) {
    return BigInt(staking.stakeBalanceCents(this.db, provider.id));
  }

  // Post (more) collateral for a provider — a simulated external deposit, minted
  // so the ledger invariant (Σ balances = Σ minted) keeps holding.
  stake(provider, amountMinor, ctx = {}) {
    const cents = toCents(amountMinor, 'stake amount');
    if (cents <= 0) throw new SettlementError('stake amount must be a positive integer');
    staking.depositStake(this.db, provider.id, cents, ctx.memo);
    return receipt(this, 'stake', {
      amountMinor: cents,
      movements: [{ from: null, to: { kind: 'stake', id: provider.id }, amount_minor: BigInt(cents) }],
    });
  }

  // Slash provider collateral in favor of a beneficiary (the buyer/agent). The
  // penalty is capped at the available balance; a provider slashed to zero loses
  // its vetted badge. Returns the amount actually slashed in the receipt.
  slash(provider, amountMinor, authorization, ctx = {}) {
    const requested = toCents(amountMinor, 'slash amount');
    const balance = staking.stakeBalanceCents(this.db, provider.id);
    const penalty = Math.min(balance, requested);
    const movements = [];
    if (penalty > 0) {
      const beneficiary = ctx.beneficiary;
      if (!beneficiary) throw new SettlementError('slash requires a beneficiary');
      const stakeAcct = ledger.getOrCreateAccount(this.db, 'stake', provider.id);
      const toAcct = ledger.getOrCreateAccount(this.db, beneficiary.kind, beneficiary.id);
      ledger.transfer(this.db, {
        fromAccountId: stakeAcct.id,
        toAccountId: toAcct.id,
        amountCents: penalty,
        type: 'stake_slash',
        memo: ctx.memo || `collateral slashed for engagement #${ctx.engagementId ?? '?'}`,
        engagementId: ctx.engagementId ?? null,
      });
      movements.push({ from: { kind: 'stake', id: provider.id }, to: beneficiary, amount_minor: BigInt(penalty) });
    }
    // A provider with no collateral left is no longer vetted.
    if (balance - penalty <= 0 && provider.kind === 'smb') {
      this.db.prepare('UPDATE smbs SET vetted = 0 WHERE id = ?').run(provider.id);
    }
    return receipt(this, 'slash', { engagementId: ctx.engagementId ?? null, amountMinor: penalty, movements });
  }

  #escrowBalance(handle) {
    const acct = ledger.getAccount(this.db, 'escrow', handle.engagementId);
    return acct ? Number(acct.balance_cents) : 0;
  }

  #payFromEscrow(handle, payouts, operation) {
    const escrowAcct = ledger.getOrCreateAccount(this.db, 'escrow', handle.engagementId);
    const movements = [];
    let total = 0;
    for (const p of payouts) {
      const cents = toCents(p.amountCents, `${operation} payout`);
      if (cents <= 0) continue;
      const to = ledger.getOrCreateAccount(this.db, p.party.kind, p.party.id);
      ledger.transfer(this.db, {
        fromAccountId: escrowAcct.id,
        toAccountId: to.id,
        amountCents: cents,
        type: p.type,
        memo: p.memo || `${operation} from escrow for engagement #${handle.engagementId}`,
        engagementId: handle.engagementId,
      });
      movements.push({ from: { kind: 'escrow', id: handle.engagementId }, to: p.party, amount_minor: BigInt(cents) });
      total += cents;
    }
    return receipt(this, operation, { engagementId: handle.engagementId, amountMinor: total, movements });
  }
}

// ---------- factory + extension point ----------------------------------------

const BACKENDS = new Map();

// Register a settlement backend factory under an id. External adapter packages
// (e.g. Pacta.Settlement.Base) call this once at load time so SETTLEMENT_BACKEND
// can select them — the core never imports the adapter.
//   registerSettlementBackend('base-escrow-vault', (db, env) => new BaseVaultBackend(env));
function registerSettlementBackend(id, factory) {
  if (typeof id !== 'string' || !id) throw new SettlementError('backend id must be a non-empty string');
  if (typeof factory !== 'function') throw new SettlementError('backend factory must be a function');
  BACKENDS.set(id.toLowerCase(), factory);
}

registerSettlementBackend('ledger', (db) => new LedgerSettlementBackend(db));

function createSettlementBackend(db, env = process.env) {
  const choice = (env.SETTLEMENT_BACKEND || 'ledger').trim().toLowerCase() || 'ledger';
  const factory = BACKENDS.get(choice);
  if (!factory) {
    throw new SettlementError(
      `unknown SETTLEMENT_BACKEND '${choice}' (registered: ${[...BACKENDS.keys()].join(', ')}). `
      + 'An external adapter package must call registerSettlementBackend() before startup.',
    );
  }
  return factory(db, env);
}

module.exports = {
  SettlementError,
  LedgerSettlementBackend,
  registerSettlementBackend,
  createSettlementBackend,
};
