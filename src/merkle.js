'use strict';
// Phase 0 (ADR-001): Merkle tree over event-log entry hashes.
//
// Construction (the verifier reimplements this independently - keep in sync
// with packages/verifier and its README):
//   - Leaves are the 32-byte entry_hash values, in seq order.
//   - Parent = SHA-256(left_bytes || right_bytes) over the raw 32-byte values.
//   - A level with an odd node count duplicates its last node.
//   - A single leaf is its own root.
// Proofs are arrays of { hash, pos } siblings, walked leaf → root.
const crypto = require('node:crypto');

const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const toBuf = (hex) => Buffer.from(strip0x(hex), 'hex');
const pairHash = (a, b) => `0x${crypto.createHash('sha256').update(toBuf(a)).update(toBuf(b)).digest('hex')}`;

function merkleRoot(leaves) {
  if (!leaves.length) throw new Error('cannot build a Merkle tree with no leaves');
  let level = leaves.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

function merkleProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf index ${index} out of range`);
  const proof = [];
  let level = leaves.slice();
  let i = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    proof.push({ hash: level[sibling], pos: i % 2 === 0 ? 'right' : 'left' });
    const next = [];
    for (let j = 0; j < level.length; j += 2) next.push(pairHash(level[j], level[j + 1]));
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

function verifyProof(leaf, proof, root) {
  let acc = leaf;
  for (const step of proof) {
    acc = step.pos === 'right' ? pairHash(acc, step.hash) : pairHash(step.hash, acc);
  }
  return acc === root;
}

module.exports = { merkleRoot, merkleProof, verifyProof };
