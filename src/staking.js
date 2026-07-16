'use strict';
// Pacta: staking-based vetting. Trust is collateralized, not asserted.
//   - vetted  ⇔  stake balance > 0
//   - exposure cap = CAP_STAKE_MULTIPLE × stake + CAP_GMV_SHARE × completed GMV
//   - losing a dispute slashes the stake in favor of the agent
const { getOrCreateAccount, getAccount, mint, transfer } = require('./ledger');

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

function exposureCapCents(db, smbId) {
  return CAP_STAKE_MULTIPLE * stakeBalanceCents(db, smbId)
    + Math.floor(CAP_GMV_SHARE * completedGmvCents(db, smbId));
}

// Money enters the stake from outside the platform (a simulated bank deposit),
// so it is minted — the ledger invariant (Σ balances = Σ minted) keeps holding.
// Must be called inside withTx. Updates the vetted flag.
function depositStake(db, smbId, amountCents, memo) {
  const acct = getOrCreateAccount(db, 'stake', smbId);
  mint(db, acct.id, amountCents, memo || `stake deposit for SMB #${smbId}`);
  db.prepare('UPDATE smbs SET vetted = 1 WHERE id = ?').run(smbId);
}

// Compensate the agent from the SMB's stake after an adverse ruling.
// Must be called inside withTx (shares the ruling's transaction).
// Returns the amount actually slashed.
function slashForRuling(db, engagement, ruling) {
  const pct = SLASH_PCT[ruling] || 0;
  if (pct === 0) return 0;
  const stakeAcct = getOrCreateAccount(db, 'stake', engagement.smb_id);
  const balance = Number(db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(stakeAcct.id).balance_cents);
  const penalty = Math.min(balance, Math.round((Number(engagement.price_cents) * pct) / 100));
  if (penalty > 0) {
    const agentAcct = getOrCreateAccount(db, 'agent', engagement.agent_id);
    transfer(db, {
      fromAccountId: stakeAcct.id,
      toAccountId: agentAcct.id,
      amountCents: penalty,
      type: 'stake_slash',
      memo: `stake slashed ${pct}% for '${ruling}' ruling on engagement #${engagement.id}`,
      engagementId: engagement.id,
    });
  }
  if (balance - penalty <= 0) {
    db.prepare('UPDATE smbs SET vetted = 0 WHERE id = ?').run(engagement.smb_id);
  }
  return penalty;
}

module.exports = {
  CAP_STAKE_MULTIPLE, CAP_GMV_SHARE, SLASH_PCT, ACTIVE_STATES,
  stakeBalanceCents, isVetted, completedGmvCents, activeExposureCents, exposureCapCents,
  depositStake, slashForRuling,
};
