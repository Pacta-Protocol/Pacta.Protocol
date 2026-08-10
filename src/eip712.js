'use strict';
// Phase 0 (ADR-001): EIP-712 typed-data signatures over secp256k1.
//
// EIP-712 is chosen over Ed25519 solely for forward compatibility with a
// potential Phase 1 escrow vault: the exact signatures produced here are what
// an on-chain contract could verify with ecrecover, so activating Phase 1
// would require no re-signing. Signature wire format is Ethereum-style
// r||s||v (65 bytes, v in {27,28}), 0x-prefixed hex.
//
// Two message types are signed:
//   Agreement(bytes32 agreementHash,string role,string nonce)  — by each party
//   LogEntry(bytes32 entryHash)                                — by the platform (receipts)
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { keccak_256 } = require('@noble/hashes/sha3.js');

const DOMAIN_NAME = 'Pacta';
const DOMAIN_VERSION = '1';

// The signing domain is bound to the anchor chain (default: Base Sepolia) so
// signatures stay valid for a potential Phase 1 vault on that chain.
const chainId = () => Number(process.env.ANCHOR_CHAIN_ID || 84532);

const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const toBytes = (hex) => Uint8Array.from(Buffer.from(strip0x(hex), 'hex'));
const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const keccakHex = (input) => toHex(keccak_256(typeof input === 'string' ? Buffer.from(input, 'utf8') : input));

// abi.encode for the static types used here: every value is one 32-byte word.
const word = (hex) => strip0x(hex).padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');

const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId)';
const AGREEMENT_TYPE = 'Agreement(bytes32 agreementHash,string role,string nonce)';
const LOG_ENTRY_TYPE = 'LogEntry(bytes32 entryHash)';

function domainSeparator(chainId) {
  const encoded = [
    word(keccakHex(DOMAIN_TYPE)),
    word(keccakHex(DOMAIN_NAME)),
    word(keccakHex(DOMAIN_VERSION)),
    uintWord(chainId),
  ].join('');
  return keccakHex(toBytes(encoded));
}

// digest = keccak256(0x1901 || domainSeparator || hashStruct(message))
function typedDigest(chainId, structHashHex) {
  return keccak_256(toBytes(`1901${strip0x(domainSeparator(chainId))}${strip0x(structHashHex)}`));
}

function agreementDigest({ agreementHash, role, nonce, chainId }) {
  const structHash = keccakHex(toBytes([
    word(keccakHex(AGREEMENT_TYPE)),
    word(agreementHash),
    word(keccakHex(role)),
    word(keccakHex(nonce)),
  ].join('')));
  return typedDigest(chainId, structHash);
}

function logEntryDigest({ entryHash, chainId }) {
  const structHash = keccakHex(toBytes([
    word(keccakHex(LOG_ENTRY_TYPE)),
    word(entryHash),
  ].join('')));
  return typedDigest(chainId, structHash);
}

// ---------- key + signature primitives ----------------------------------------

const newPrivateKey = () => toHex(secp256k1.utils.randomSecretKey());
const publicKeyOf = (privHex) => toHex(secp256k1.getPublicKey(toBytes(privHex), false));

// noble's 'recovered' layout is recovery||r||s; rewrap as Ethereum r||s||v.
function signDigest(digest, privHex) {
  const sig = secp256k1.sign(digest, toBytes(privHex), { format: 'recovered' });
  return toHex(Uint8Array.from([...sig.slice(1), 27 + sig[0]]));
}

function verifyDigest(digest, sigHex, pubkeyHex) {
  const sig = toBytes(sigHex);
  if (sig.length !== 65) return false;
  try {
    return secp256k1.verify(sig.slice(0, 64), digest, toBytes(pubkeyHex));
  } catch {
    return false;
  }
}

function recoverPubkey(digest, sigHex) {
  const sig = toBytes(sigHex);
  if (sig.length !== 65) return null;
  try {
    const recovered = secp256k1.recoverPublicKey(
      Uint8Array.from([sig[64] - 27, ...sig.slice(0, 64)]), digest,
    );
    return toHex(secp256k1.Point.fromBytes(recovered).toBytes(false));
  } catch {
    return null;
  }
}

// Ethereum address of an uncompressed pubkey — the identity the AnchorRegistry
// contract sees as msg.sender when this key sends anchor transactions.
function addressOf(pubkeyHex) {
  const raw = toBytes(pubkeyHex);
  const body = raw.length === 65 ? raw.slice(1) : raw;
  return `0x${Buffer.from(keccak_256(body)).toString('hex').slice(-40)}`;
}

module.exports = {
  DOMAIN_NAME, DOMAIN_VERSION, AGREEMENT_TYPE, LOG_ENTRY_TYPE, chainId,
  domainSeparator, agreementDigest, logEntryDigest,
  newPrivateKey, publicKeyOf, signDigest, verifyDigest, recoverPubkey, addressOf,
  keccakHex,
};
