'use strict';

// Simulated USD ledger. All amounts are integer cents. Every movement of money is a
// row in `transactions` plus balance updates on the affected accounts; callers that
// move money as part of a larger state change must wrap everything in withTx().

class LedgerError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

function getOrCreateAccount(db, kind, refId) {
  const existing = db
    .prepare('SELECT * FROM accounts WHERE kind = ? AND ref_id = ?')
    .get(kind, refId);
  if (existing) return existing;
  db.prepare('INSERT INTO accounts (kind, ref_id, balance_cents) VALUES (?, ?, 0)').run(kind, refId);
  return db.prepare('SELECT * FROM accounts WHERE kind = ? AND ref_id = ?').get(kind, refId);
}

function getAccount(db, kind, refId) {
  return db.prepare('SELECT * FROM accounts WHERE kind = ? AND ref_id = ?').get(kind, refId) || null;
}

// Mint simulated USD into an account (seed only): from_account_id is NULL.
function mint(db, toAccountId, amountCents, memo) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new LedgerError('mint amount must be a positive integer number of cents', 400);
  }
  db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(
    amountCents, toAccountId,
  );
  db.prepare(
    'INSERT INTO transactions (from_account_id, to_account_id, amount_cents, type, memo) VALUES (NULL, ?, ?, ?, ?)',
  ).run(toAccountId, amountCents, 'seed', memo || 'seed mint');
}

// Move money between two accounts. Throws LedgerError on insufficient funds.
function transfer(db, { fromAccountId, toAccountId, amountCents, type, memo, engagementId }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new LedgerError('transfer amount must be a positive integer number of cents', 400);
  }
  const from = db.prepare('SELECT * FROM accounts WHERE id = ?').get(fromAccountId);
  const to = db.prepare('SELECT * FROM accounts WHERE id = ?').get(toAccountId);
  if (!from || !to) throw new LedgerError('account not found', 404);
  if (from.balance_cents < amountCents) {
    throw new LedgerError(
      `insufficient funds: account has $${(Number(from.balance_cents) / 100).toFixed(2)}, ` +
      `needs $${(amountCents / 100).toFixed(2)}`,
    );
  }
  db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, fromAccountId);
  db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, toAccountId);
  db.prepare(
    'INSERT INTO transactions (engagement_id, from_account_id, to_account_id, amount_cents, type, memo) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(engagementId ?? null, fromAccountId, toAccountId, amountCents, type, memo || '');
}

// The system-wide invariant: money is only ever created by seed mints, so the sum of
// all balances must equal the sum of all mints, and every individual balance must
// equal its replayed credits minus debits.
function checkInvariant(db) {
  const totalBalances = Number(
    db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS s FROM accounts').get().s,
  );
  const totalMinted = Number(
    db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE from_account_id IS NULL').get().s,
  );
  const mismatches = [];
  const accounts = db.prepare('SELECT * FROM accounts').all();
  for (const acct of accounts) {
    const credits = Number(
      db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE to_account_id = ?').get(acct.id).s,
    );
    const debits = Number(
      db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE from_account_id = ?').get(acct.id).s,
    );
    if (credits - debits !== Number(acct.balance_cents)) {
      mismatches.push({ account_id: Number(acct.id), expected: credits - debits, actual: Number(acct.balance_cents) });
    }
  }
  return {
    ok: totalBalances === totalMinted && mismatches.length === 0,
    total_balances_cents: totalBalances,
    total_minted_cents: totalMinted,
    mismatches,
  };
}

module.exports = { LedgerError, getOrCreateAccount, getAccount, mint, transfer, checkInvariant };
