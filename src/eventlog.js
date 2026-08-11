'use strict';
// Phase 0 (ADR-001): hash-chained append-only event log.
//
//   entry_hash = SHA-256( prev_hash || canonical({seq, engagement, type, payload, at}) )
//
// prev_hash of the first entry is the 32-byte zero genesis constant. The
// concatenation operates on the UTF-8 bytes of the 0x-prefixed prev_hash
// string followed by the canonical JSON bytes - the verifier reimplements
// this formula independently (packages/verifier), so any change here is a
// breaking protocol change.
//
// append() must run inside the same transaction as the state change it
// records; UPDATE/DELETE on the table are blocked by triggers (src/db.js).
// Alongside each entry, Pacta's EIP-712 signature over the entry_hash is
// stored (receipt_sigs) - the seed of the receipt both parties get.
const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');
const eip712 = require('./eip712');
const keys = require('./keys');

const GENESIS = `0x${'0'.repeat(64)}`;

const entryHashOf = (prevHash, entry) => `0x${crypto.createHash('sha256')
  .update(prevHash)
  .update(canonicalize({
    seq: entry.seq, engagement: entry.engagement, type: entry.type,
    payload: entry.payload, at: entry.at,
  }))
  .digest('hex')}`;

// Append one event. `engagement` is the agreement_hash, 'platform' for global
// events, or 'pre-phase0:<id>' for engagements that predate Phase 0. payload
// must contain hashes and metadata only - never evidence bytes or free text.
function append(db, { engagement, type, payload }) {
  const last = db.prepare('SELECT seq, entry_hash FROM event_log ORDER BY seq DESC LIMIT 1').get();
  const seq = last ? Number(last.seq) + 1 : 1;
  const prevHash = last ? last.entry_hash : GENESIS;
  const at = new Date().toISOString();
  const entry = { seq, engagement, type, payload, at };
  const entryHash = entryHashOf(prevHash, entry);
  db.prepare(
    'INSERT INTO event_log (seq, engagement, type, payload, at, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(seq, engagement, type, JSON.stringify(payload), at, prevHash, entryHash);
  const pactaSig = eip712.signDigest(
    eip712.logEntryDigest({ entryHash, chainId: eip712.chainId() }),
    keys.platformPrivkey(),
  );
  db.prepare('INSERT INTO receipt_sigs (seq, pacta_sig) VALUES (?, ?)').run(seq, pactaSig);
  return { ...entry, prev_hash: prevHash, entry_hash: entryHash, pacta_sig: pactaSig };
}

const rowToEntry = (row) => ({
  seq: Number(row.seq),
  engagement: row.engagement,
  type: row.type,
  payload: JSON.parse(row.payload),
  at: row.at,
  prev_hash: row.prev_hash,
  entry_hash: row.entry_hash,
});

function entriesFor(db, engagement) {
  return db.prepare('SELECT * FROM event_log WHERE engagement = ? ORDER BY seq').all(engagement).map(rowToEntry);
}

// Recompute every entry_hash from genesis and match against the stored chain.
// This is the tamper detector: any mutation of a past row (however it got
// past the triggers) breaks every link from that row forward.
function replay(db) {
  const rows = db.prepare('SELECT * FROM event_log ORDER BY seq').all().map(rowToEntry);
  let prev = GENESIS;
  for (const entry of rows) {
    if (entry.prev_hash !== prev) {
      return { ok: false, checked: rows.length, broken_at: entry.seq, reason: 'prev_hash does not match previous entry' };
    }
    if (entryHashOf(prev, entry) !== entry.entry_hash) {
      return { ok: false, checked: rows.length, broken_at: entry.seq, reason: 'entry_hash does not match recomputed hash' };
    }
    prev = entry.entry_hash;
  }
  return { ok: true, checked: rows.length, broken_at: null, reason: null };
}

module.exports = { GENESIS, entryHashOf, append, entriesFor, replay, rowToEntry };
