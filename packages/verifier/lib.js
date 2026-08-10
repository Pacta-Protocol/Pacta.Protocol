'use strict';
// pacta-verify — independent verifier for Pacta Phase 0 receipts (ADR-001).
//
// HARD RULE: this package must never import Pacta backend code or require
// Pacta credentials. Every formula below is reimplemented from the protocol
// definition so that a receipt can be checked by anyone, offline, against any
// RPC node, without Pacta's cooperation. If a check fails here, either the
// receipt is forged or history was tampered with — that is the product.
//
// Protocol formulas (must match docs; changing any is a breaking change):
//   canonical JSON      RFC 8785 (JCS): sorted keys, JSON.stringify scalars
//   entry_hash          SHA-256( prev_hash_utf8 || canonical({seq, engagement, type, payload, at}) )
//   agreement_hash      SHA-256( canonical(agreement) ), agreement schema pacta/agreement@1
//   Merkle tree         SHA-256 over raw 32-byte values, leaves in seq order,
//                       odd level duplicates its last node, single leaf = root
//   signatures          EIP-712, domain {name:"Pacta", version:"1", chainId},
//                       types Agreement(bytes32 agreementHash,string role,string nonce)
//                       and LogEntry(bytes32 entryHash); sig format r||s||v
const crypto = require('node:crypto');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { keccak_256 } = require('@noble/hashes/sha3.js');

// ---------- canonical JSON (RFC 8785) -----------------------------------------

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`cannot canonicalize ${typeof value}`);
}

const sha256hex = (input) => `0x${crypto.createHash('sha256').update(input).digest('hex')}`;
const strip0x = (h) => (String(h).startsWith('0x') ? String(h).slice(2) : String(h));
const toBytes = (hex) => Uint8Array.from(Buffer.from(strip0x(hex), 'hex'));
const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

// ---------- protocol hashes ----------------------------------------------------

const entryHashOf = (prevHash, entry) => `0x${crypto.createHash('sha256')
  .update(prevHash)
  .update(canonicalize({ seq: entry.seq, engagement: entry.engagement, type: entry.type, payload: entry.payload, at: entry.at }))
  .digest('hex')}`;

const agreementHashOf = (agreement) => sha256hex(canonicalize(agreement));

// ---------- Merkle -------------------------------------------------------------

const pairHash = (a, b) => `0x${crypto.createHash('sha256')
  .update(Buffer.from(strip0x(a), 'hex')).update(Buffer.from(strip0x(b), 'hex')).digest('hex')}`;

function walkProof(leaf, proof) {
  let acc = leaf;
  for (const step of proof) {
    acc = step.pos === 'right' ? pairHash(acc, step.hash) : pairHash(step.hash, acc);
  }
  return acc;
}

// ---------- EIP-712 ------------------------------------------------------------

const keccakHex = (input) => toHex(keccak_256(typeof input === 'string' ? Buffer.from(input, 'utf8') : input));
const word = (hex) => strip0x(hex).padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');

const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId)';
const AGREEMENT_TYPE = 'Agreement(bytes32 agreementHash,string role,string nonce)';
const LOG_ENTRY_TYPE = 'LogEntry(bytes32 entryHash)';

function domainSeparator(chainId) {
  return keccakHex(toBytes([
    word(keccakHex(DOMAIN_TYPE)), word(keccakHex('Pacta')), word(keccakHex('1')), uintWord(chainId),
  ].join('')));
}

const typedDigest = (chainId, structHash) => keccak_256(
  toBytes(`1901${strip0x(domainSeparator(chainId))}${strip0x(structHash)}`),
);

const agreementDigest = ({ agreementHash, role, nonce, chainId }) => typedDigest(chainId, keccakHex(toBytes([
  word(keccakHex(AGREEMENT_TYPE)), word(agreementHash), word(keccakHex(role)), word(keccakHex(nonce)),
].join(''))));

const logEntryDigest = ({ entryHash, chainId }) => typedDigest(chainId, keccakHex(toBytes([
  word(keccakHex(LOG_ENTRY_TYPE)), word(entryHash),
].join(''))));

function verifySig(digest, sigHex, pubkeyHex) {
  const sig = toBytes(sigHex);
  if (sig.length !== 65) return false;
  try {
    return secp256k1.verify(sig.slice(0, 64), digest, toBytes(pubkeyHex));
  } catch {
    return false;
  }
}

// ---------- receipt verification ----------------------------------------------

// Runs every offline check on one receipt. Returns { pass, checks } where each
// check is { name, status: 'PASS'|'FAIL'|'SKIP', detail }. The on-chain check
// (fetching the Anchored event) needs an RPC and lives in checkAnchorOnChain.
function verifyReceipt(receipt, { platformPubkey, chainId } = {}) {
  const checks = [];
  const push = (name, status, detail) => checks.push({ name, status, detail });
  const entry = receipt.entry || {};

  // 1. entry_hash recomputes from the entry's own contents.
  try {
    const recomputed = entryHashOf(entry.prev_hash, entry);
    push('entry_hash', recomputed === entry.entry_hash ? 'PASS' : 'FAIL',
      recomputed === entry.entry_hash
        ? `entry_hash recomputed identically (${entry.entry_hash.slice(0, 18)}…)`
        : `recomputed ${recomputed} but receipt says ${entry.entry_hash} — the entry was altered`);
  } catch (err) {
    push('entry_hash', 'FAIL', `cannot recompute: ${err.message}`);
  }

  // 2. Pacta's signature over entry_hash against the published platform key.
  if (!platformPubkey) {
    push('pacta_sig', 'SKIP', 'no platform pubkey provided (use --pubkey or GET /api/keys/platform)');
  } else if (!receipt.pacta_sig) {
    push('pacta_sig', 'FAIL', 'receipt has no pacta_sig');
  } else {
    const ok = verifySig(logEntryDigest({ entryHash: entry.entry_hash, chainId }), receipt.pacta_sig, platformPubkey);
    push('pacta_sig', ok ? 'PASS' : 'FAIL',
      ok ? 'platform signature valid for this entry_hash' : 'platform signature does NOT verify');
  }

  // 3. AgreementLocked: recompute agreement_hash from the embedded canonical
  //    terms and verify both party signatures.
  if (entry.type === 'AgreementLocked' && entry.payload && entry.payload.agreement) {
    const { agreement, agreement_hash: claimed, signatures = {} } = entry.payload;
    const recomputed = agreementHashOf(agreement);
    push('agreement_hash', recomputed === claimed ? 'PASS' : 'FAIL',
      recomputed === claimed
        ? `agreement terms hash to the claimed identity (${claimed.slice(0, 18)}…)`
        : `terms hash to ${recomputed}, not the claimed ${claimed} — terms were altered`);
    for (const role of ['buyer', 'provider']) {
      const pubkey = agreement[role] && agreement[role].pubkey;
      const sig = signatures[role];
      if (!pubkey || !sig) {
        push(`${role}_sig`, 'FAIL', `missing ${role} pubkey or signature`);
        continue;
      }
      const ok = verifySig(
        agreementDigest({ agreementHash: recomputed, role, nonce: agreement.nonce, chainId }), sig, pubkey,
      );
      push(`${role}_sig`, ok ? 'PASS' : 'FAIL',
        ok ? `${role} signed these exact terms` : `${role} signature does NOT verify against these terms`);
    }
  }

  // 4. Merkle path from entry_hash to the anchored root.
  if (!receipt.merkle_proof || !receipt.anchor) {
    push('merkle_proof', 'SKIP', 'entry not yet covered by an anchor (minutes-scale window, or local-only run)');
  } else {
    const root = walkProof(entry.entry_hash, receipt.merkle_proof);
    push('merkle_proof', root === receipt.anchor.root ? 'PASS' : 'FAIL',
      root === receipt.anchor.root
        ? `Merkle path reaches the anchored root (${root.slice(0, 18)}…)`
        : `path reaches ${root} but the anchor root is ${receipt.anchor.root}`);
  }

  return { pass: checks.every((c) => c.status !== 'FAIL'), checks };
}

// 5. On-chain check: fetch the Anchored event via RPC and confirm root, range
// and sender. Anchors with chain_id 0 are simulated local-development anchors
// and cannot be checked against a public chain.
const ANCHORED_TOPIC = () => toHex(keccak_256(Buffer.from('Anchored(bytes32,uint64,uint64,address)', 'utf8')));

async function checkAnchorOnChain(anchor, { rpcUrl, senderAddress } = {}) {
  if (!anchor) return { name: 'anchor_on_chain', status: 'SKIP', detail: 'receipt has no anchor yet' };
  if (Number(anchor.chain_id) === 0) {
    return { name: 'anchor_on_chain', status: 'SKIP', detail: 'chain_id 0 is a simulated local anchor — nothing on a public chain to check' };
  }
  if (!rpcUrl) return { name: 'anchor_on_chain', status: 'SKIP', detail: 'no --rpc provided' };
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [anchor.tx_hash] }),
  });
  const data = await res.json();
  if (data.error || !data.result) {
    return { name: 'anchor_on_chain', status: 'FAIL', detail: `transaction ${anchor.tx_hash} not found on chain` };
  }
  const log = (data.result.logs || []).find((l) => (l.topics || [])[0] === ANCHORED_TOPIC());
  if (!log) return { name: 'anchor_on_chain', status: 'FAIL', detail: 'transaction has no Anchored event' };
  const root = `0x${strip0x(log.topics[1])}`;
  const fromSeq = Number(BigInt(`0x${strip0x(log.data).slice(0, 64)}`));
  const toSeq = Number(BigInt(`0x${strip0x(log.data).slice(64, 128)}`));
  const sender = `0x${strip0x(log.topics[2]).slice(-40)}`;
  if (root !== anchor.root) return { name: 'anchor_on_chain', status: 'FAIL', detail: `on-chain root ${root} ≠ receipt root ${anchor.root}` };
  if (fromSeq !== Number(anchor.from_seq) || toSeq !== Number(anchor.to_seq)) {
    return { name: 'anchor_on_chain', status: 'FAIL', detail: `on-chain range ${fromSeq}..${toSeq} ≠ receipt range ${anchor.from_seq}..${anchor.to_seq}` };
  }
  if (senderAddress && sender.toLowerCase() !== senderAddress.toLowerCase()) {
    return { name: 'anchor_on_chain', status: 'FAIL', detail: `anchor sent by ${sender}, expected ${senderAddress}` };
  }
  return { name: 'anchor_on_chain', status: 'PASS', detail: `Anchored(root, ${fromSeq}..${toSeq}) confirmed on chain ${anchor.chain_id}${senderAddress ? ` from ${senderAddress}` : ''}` };
}

module.exports = {
  canonicalize, sha256hex, entryHashOf, agreementHashOf, walkProof,
  domainSeparator, agreementDigest, logEntryDigest, verifySig,
  verifyReceipt, checkAnchorOnChain,
};
