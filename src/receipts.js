'use strict';
// Base Readiness (ADR-002): signed receipts with Merkle inclusion proofs.
//
// A receipt is the portable object a party keeps outside Pacta:
//   { entry, merkle_proof, anchor, pacta_sig }
// pacta_sig (Pacta's EIP-712 signature over entry_hash) is written the moment
// the entry is appended; merkle_proof and anchor stay null until an anchor
// whose window covers the entry lands, then get backfilled on read. Receipts
// are recomputed from the immutable log on demand - nothing to keep consistent.
const eventlog = require('./eventlog');
const { merkleProof } = require('./merkle');
const { windowEntries, unixSeconds } = require('./anchor');

// The anchor whose window (windowStart, windowEnd] covers this entry's
// timestamp. Empty-window anchors (leaf_count 0) never cover an entry.
function anchorCovering(db, entry) {
  const t = unixSeconds(entry.at);
  const row = db.prepare(
    'SELECT * FROM anchors WHERE leaf_count > 0 AND window_start < ? AND window_end >= ? ORDER BY sequence LIMIT 1',
  ).get(t, t);
  return row || null;
}

function anchorPublic(a) {
  return {
    sequence: Number(a.sequence),
    root: a.root,
    window_start: Number(a.window_start),
    window_end: Number(a.window_end),
    leaf_count: Number(a.leaf_count),
    chain_id: Number(a.chain_id),
    tx_hash: a.tx_hash,
    block_number: a.block_number === null ? null : Number(a.block_number),
    block_time: a.block_time,
  };
}

function buildReceipt(db, entry) {
  const sig = db.prepare('SELECT pacta_sig FROM receipt_sigs WHERE seq = ?').get(entry.seq);
  const anchor = anchorCovering(db, entry);
  let proof = null;
  if (anchor) {
    // Rebuild the exact leaf set that produced the anchored root, then the path.
    const rows = windowEntries(db, anchor.window_start, anchor.window_end);
    const index = rows.findIndex((r) => Number(r.seq) === entry.seq);
    if (index >= 0) proof = merkleProof(rows.map((r) => r.entry_hash), index);
  }
  return {
    entry,
    merkle_proof: proof,
    anchor: anchor && proof ? anchorPublic(anchor) : null,
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
