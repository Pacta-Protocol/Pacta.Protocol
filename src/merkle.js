'use strict';
// Base Readiness (ADR-002): domain-separated Merkle tree over event-log entry
// hashes. The verifier reimplements this independently - keep it in sync with
// packages/verifier and its README.
//
// Construction (precise enough to reimplement without reading this code):
//   - A leaf's value is SHA-256(0x00 || entry_hash_bytes): the 32 raw bytes of
//     the entry_hash, prefixed with a single 0x00 domain-separation byte.
//   - An internal node's value is SHA-256(0x01 || left_bytes || right_bytes),
//     over the two 32-byte child values, prefixed with 0x01.
//   - Leaves are ordered by seq. A level with an odd node count duplicates its
//     last node before pairing.
//   - The tree of a single leaf has that leaf's value as its root:
//     root = SHA-256(0x00 || entry_hash_bytes). With domain separation a raw
//     entry_hash is never itself a root, which is the point (a leaf preimage
//     can never collide with an internal-node preimage).
//   - The root of an empty window is the zero root, 32 zero bytes.
// Proofs are arrays of { hash, pos } siblings walked leaf -> root, where `hash`
// is a sibling node value (already domain-separated) and `pos` says whether the
// sibling sits to the 'left' or 'right' of the accumulator.
const crypto = require('node:crypto');

const ZERO_ROOT = `0x${'0'.repeat(64)}`;
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const toBuf = (hex) => Buffer.from(strip0x(hex), 'hex');

// Leaf value: SHA-256(0x00 || entry_hash_bytes).
const leafHash = (entryHash) => `0x${crypto.createHash('sha256')
  .update(LEAF_PREFIX).update(toBuf(entryHash)).digest('hex')}`;

// Internal node: SHA-256(0x01 || left_bytes || right_bytes).
const nodeHash = (a, b) => `0x${crypto.createHash('sha256')
  .update(NODE_PREFIX).update(toBuf(a)).update(toBuf(b)).digest('hex')}`;

function merkleRoot(leaves) {
  if (!leaves.length) return ZERO_ROOT;
  let level = leaves.map(leafHash);
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

function merkleProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf index ${index} out of range`);
  const proof = [];
  let level = leaves.map(leafHash);
  let i = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    proof.push({ hash: level[sibling], pos: i % 2 === 0 ? 'right' : 'left' });
    const next = [];
    for (let j = 0; j < level.length; j += 2) next.push(nodeHash(level[j], level[j + 1]));
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

// The accumulator starts as the leaf's own value (domain-separated), then each
// step folds in a sibling node value.
function verifyProof(entryHash, proof, root) {
  let acc = leafHash(entryHash);
  for (const step of proof) {
    acc = step.pos === 'right' ? nodeHash(acc, step.hash) : nodeHash(step.hash, acc);
  }
  return acc === root;
}

module.exports = { merkleRoot, merkleProof, verifyProof, leafHash, nodeHash, ZERO_ROOT };
