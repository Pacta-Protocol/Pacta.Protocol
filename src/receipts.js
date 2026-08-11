'use strict';
// Phase 0 (ADR-001): signed receipts with Merkle inclusion proofs.
//
// A receipt is the portable object a party keeps outside Pacta:
//   { entry, merkle_proof, anchor, pacta_sig }
// pacta_sig (Pacta's EIP-712 signature over entry_hash) is written the moment
// the entry is appended; merkle_proof and anchor stay null until an anchor
// covering the entry lands, then get backfilled on read. Receipts are
// recomputed from the immutable log on demand - there is nothing to keep
// consistent.
const eventlog = require('./eventlog');
const { merkleProof } = require('./merkle');

// The earliest non-heartbeat anchor whose range covers this seq.
function anchorCovering(db, seq) {
  const row = db.prepare(
    'SELECT * FROM anchors WHERE heartbeat = 0 AND from_seq <= ? AND to_seq >= ? ORDER BY id LIMIT 1',
  ).get(seq, seq);
  return row || null;
}

function anchorPublic(a) {
  return {
    root: a.root,
    from_seq: Number(a.from_seq),
    to_seq: Number(a.to_seq),
    chain_id: Number(a.chain_id),
    tx_hash: a.tx_hash,
    block_number: a.block_number === null ? null : Number(a.block_number),
    block_time: a.block_time,
  };
}

function buildReceipt(db, entry) {
  const sig = db.prepare('SELECT pacta_sig FROM receipt_sigs WHERE seq = ?').get(entry.seq);
  const anchor = anchorCovering(db, entry.seq);
  let proof = null;
  if (anchor) {
    const leaves = db.prepare(
      'SELECT entry_hash FROM event_log WHERE seq BETWEEN ? AND ? ORDER BY seq',
    ).all(anchor.from_seq, anchor.to_seq).map((r) => r.entry_hash);
    proof = merkleProof(leaves, entry.seq - Number(anchor.from_seq));
  }
  return {
    entry,
    merkle_proof: proof,
    anchor: anchor ? anchorPublic(anchor) : null,
    pacta_sig: sig ? sig.pacta_sig : null,
  };
}

// Every receipt for one engagement (keyed by agreement_hash, or the
// 'pre-phase0:<id>' marker for engagements that predate Phase 0).
function engagementReceipts(db, engagementKey) {
  return eventlog.entriesFor(db, engagementKey).map((entry) => buildReceipt(db, entry));
}

function receiptForSeq(db, seq) {
  const row = db.prepare('SELECT * FROM event_log WHERE seq = ?').get(seq);
  return row ? buildReceipt(db, eventlog.rowToEntry(row)) : null;
}

module.exports = { buildReceipt, engagementReceipts, receiptForSeq, anchorCovering };
