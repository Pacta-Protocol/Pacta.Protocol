'use strict';
// Pacta: staking-based vetting. Trust is collateralized, not asserted.
//   - vetted  ⇔  stake balance > 0
//   - exposure cap = CAP_STAKE_MULTIPLE × stake + CAP_GMV_SHARE × completed GMV
//   - losing a dispute slashes the stake in favor of the agent
//
// This module is the collateral *policy* (percentages, exposure formula, vetting
// flag) plus the deposit primitive. Moving collateral out — the slash itself — is
// a settlement operation and lives behind the SettlementBackend (src/settlement.js),
// so it works the same whether the stake sits in this ledger or in an onchain vault.
const { getOrCreateAccount, getAccount, mint } = require('./ledger');

const CAP_STAKE_MULTIPLE = 5;
const CAP_GMV_SHARE = 0.5; // half of lifetime completed GMV counts toward the cap
const SLASH_PCT = { refund: 20, split: 10, release: 0 };

// States in which an engagement counts against the SMB's exposure cap.
const ACTIVE_STATES = ['agreed', 'funded', 'in_progress', 'submitted', 'disputed'];

function stakeBalanceCents(db, smbId) {
  const acct = getAccount(db, 'stake', smbId);
  return acct ? Number(acct.balance_cents) : 0;
}

function isVetted(db, smbId) {
  return stakeBalanceCents(db, smbId) > 0;
}

function completedGmvCents(db, smbId) {
  return Number(db.prepare(
    "SELECT COALESCE(SUM(price_cents), 0) AS s FROM engagements WHERE smb_id = ? AND state = 'completed'",
  ).get(smbId).s);
}

function activeExposureCents(db, smbId) {
  const placeholders = ACTIVE_STATES.map(() => '?').join(',');
  return Number(db.prepare(
    `SELECT COALESCE(SUM(price_cents), 0) AS s FROM engagements WHERE smb_id = ? AND state IN (${placeholders})`,
  ).get(smbId, ...ACTIVE_STATES).s);
}

// The graduated cap, as a pure formula. The stake balance is supplied by the
// caller (from the settlement backend) so the cap is correct no matter where the
// collateral is held; the GMV share is read from the engagement history, which is
// backend-independent.
function exposureCapCents(stakeCents, gmvCents) {
  return CAP_STAKE_MULTIPLE * stakeCents + Math.floor(CAP_GMV_SHARE * gmvCents);
}

// Money enters the stake from outside the platform (a simulated bank deposit),
// so it is minted — the ledger invariant (Σ balances = Σ minted) keeps holding.
// Must be called inside withTx. Updates the vetted flag.
function depositStake(db, smbId, amountCents, memo) {
  const acct = getOrCreateAccount(db, 'stake', smbId);
  mint(db, acct.id, amountCents, memo || `stake deposit for SMB #${smbId}`);
  db.prepare('UPDATE smbs SET vetted = 1 WHERE id = ?').run(smbId);
}

// The penalty an adverse ruling costs the provider, as a policy amount in cents
// (capped to the available balance by the settlement backend that executes it).
function penaltyCentsForRuling(priceCents, ruling) {
  const pct = SLASH_PCT[ruling] || 0;
  if (pct === 0) return 0;
  return Math.round((Number(priceCents) * pct) / 100);
}

module.exports = {
  CAP_STAKE_MULTIPLE, CAP_GMV_SHARE, SLASH_PCT, ACTIVE_STATES,
  stakeBalanceCents, isVetted, completedGmvCents, activeExposureCents, exposureCapCents,
  depositStake, penaltyCentsForRuling,
};
