'use strict';
// SettlementBackend interface, factory selection, uniform receipts, and the
// chain-neutrality guard. These tests exercise the settlement seam directly,
// below the REST API — the API-level behavior is covered by api/pacta tests,
// which stay green precisely because this refactor is behavior-preserving.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, withTx } = require('../src/db');
const { seedIfEmpty } = require('../src/seed');
const {
  createSettlementBackend, registerSettlementBackend, LedgerSettlementBackend, SettlementError,
} = require('../src/settlement');

const RECEIPT_FIELDS = ['backend', 'currency', 'operation', 'engagement_id', 'amount_minor', 'movements', 'onchain'];

function assertUniformReceipt(r, { operation }) {
  assert.deepEqual(Object.keys(r).sort(), [...RECEIPT_FIELDS].sort(), 'receipt has exactly the uniform fields');
  assert.equal(r.backend, 'ledger');
  assert.equal(r.currency, 'USD');
  assert.equal(r.operation, operation);
  assert.equal(typeof r.amount_minor, 'bigint', 'amounts are integer minor units (bigint)');
  assert.ok(Array.isArray(r.movements));
  assert.equal(r.onchain, null, 'ledger receipts carry no onchain block');
}

function freshDb() {
  const db = openDb(':memory:');
  seedIfEmpty(db, { pacta: true });
  return db;
}

test('factory: defaults to the ledger backend', () => {
  const db = freshDb();
  const def = createSettlementBackend(db, {});
  assert.ok(def instanceof LedgerSettlementBackend);
  assert.equal(def.id, 'ledger');
  assert.equal(def.currency, 'USD');

  const explicit = createSettlementBackend(db, { SETTLEMENT_BACKEND: 'ledger' });
  assert.equal(explicit.id, 'ledger');

  // Case-insensitive and whitespace-tolerant, mirroring the other adapters.
  assert.equal(createSettlementBackend(db, { SETTLEMENT_BACKEND: '  LEDGER  ' }).id, 'ledger');
});

test('factory: an unknown backend fails loudly', () => {
  const db = freshDb();
  assert.throws(
    () => createSettlementBackend(db, { SETTLEMENT_BACKEND: 'base-escrow-vault' }),
    /unknown SETTLEMENT_BACKEND 'base-escrow-vault'/,
  );
});

test('extension point: a third backend registers without touching core', () => {
  const db = freshDb();
  const fake = { id: 'test-vault', currency: 'USDC' };
  registerSettlementBackend('test-vault', () => fake);
  const chosen = createSettlementBackend(db, { SETTLEMENT_BACKEND: 'test-vault' });
  assert.equal(chosen, fake, 'selection returns the externally-registered backend');
  // Registration validates its inputs.
  assert.throws(() => registerSettlementBackend('', () => {}), SettlementError);
  assert.throws(() => registerSettlementBackend('x', null), SettlementError);
});

test('ledger backend: escrow lifecycle returns uniform receipts and moves money', () => {
  const db = freshDb();
  const s = createSettlementBackend(db, {});
  const handle = s.openEscrow({
    engagementId: 90001, buyer: { kind: 'agent', id: 1 }, provider: { kind: 'smb', id: 1 },
    amountMinor: 100_000n,
  });

  const fundR = withTx(db, () => s.fund(handle, 100_000n, { memo: 'test fund' }));
  assertUniformReceipt(fundR, { operation: 'fund' });
  assert.equal(fundR.amount_minor, 100_000n);
  assert.equal(fundR.engagement_id, 90001);

  // A zero-value fund is a no-op that still returns a well-formed receipt.
  const zeroR = withTx(db, () => s.fund(handle, 0n));
  assertUniformReceipt(zeroR, { operation: 'fund' });
  assert.equal(zeroR.amount_minor, 0n);
  assert.equal(zeroR.movements.length, 0);

  const releaseR = withTx(db, () => s.release(handle, { agreementHash: null, signatures: null }, { memo: 'test release' }));
  assertUniformReceipt(releaseR, { operation: 'release' });
  assert.equal(releaseR.amount_minor, 100_000n, 'release pays out the full escrow balance');
});

test('ledger backend: refund and split settle the escrow', () => {
  const db = freshDb();
  const s = createSettlementBackend(db, {});

  const rHandle = s.openEscrow({ engagementId: 90002, buyer: { kind: 'agent', id: 1 }, provider: { kind: 'smb', id: 1 } });
  withTx(db, () => s.fund(rHandle, 50_000n));
  const refundR = withTx(db, () => s.refund(rHandle, {}, {}));
  assertUniformReceipt(refundR, { operation: 'refund' });
  assert.equal(refundR.amount_minor, 50_000n);

  const sHandle = s.openEscrow({ engagementId: 90003, buyer: { kind: 'agent', id: 1 }, provider: { kind: 'smb', id: 1 } });
  withTx(db, () => s.fund(sHandle, 10_001n));
  const splitR = withTx(db, () => s.split(sHandle, 5_000n, 5_001n, {}, {}));
  assertUniformReceipt(splitR, { operation: 'split' });
  assert.equal(splitR.amount_minor, 10_001n, 'split distributes the whole escrow');
  assert.equal(splitR.movements.length, 2);
});

test('ledger backend: collateral deposit, balance read, and capped slash', () => {
  const db = freshDb();
  const s = createSettlementBackend(db, {});
  const provider = { kind: 'smb', id: 1 };
  const before = s.stakeBalance(provider);
  assert.equal(typeof before, 'bigint');

  const stakeR = withTx(db, () => s.stake(provider, 20_000n, { memo: 'top up' }));
  assertUniformReceipt(stakeR, { operation: 'stake' });
  assert.equal(s.stakeBalance(provider), before + 20_000n);

  // Slash is capped at the available balance and returns the amount actually taken.
  const balance = s.stakeBalance(provider);
  const slashR = withTx(db, () => s.slash(provider, balance + 999_999n, {}, {
    beneficiary: { kind: 'agent', id: 1 }, engagementId: 90004, memo: 'slash all',
  }));
  assertUniformReceipt(slashR, { operation: 'slash' });
  assert.equal(slashR.amount_minor, balance, 'slash is capped at the collateral balance');
  assert.equal(s.stakeBalance(provider), 0n);

  // A slash requires a beneficiary when there is something to move.
  withTx(db, () => s.stake(provider, 1_000n));
  assert.throws(() => withTx(db, () => s.slash(provider, 500n, {}, {})), SettlementError);
});

test('ledger backend: rejects non-integer minor units (no floats)', () => {
  const db = freshDb();
  const s = createSettlementBackend(db, {});
  const handle = s.openEscrow({ engagementId: 90005, buyer: { kind: 'agent', id: 1 }, provider: { kind: 'smb', id: 1 } });
  assert.throws(() => s.fund(handle, 1.5), /integer number of minor units/);
});

test('neutrality: no core file imports a chain, wallet, or RPC library', () => {
  const { scan } = require('../scripts/check-neutrality');
  const violations = scan();
  assert.deepEqual(violations, [], `core imports a chain library: ${JSON.stringify(violations)}`);
});
