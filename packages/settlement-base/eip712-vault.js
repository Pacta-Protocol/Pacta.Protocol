'use strict';
// EIP-712 digests for the EscrowVault, matching contracts/EscrowVault.sol byte
// for byte. The vault's domain is distinct from the Phase 0 "Pacta" agreement
// domain — it includes verifyingContract and uses name "PactaEscrowVault" — so
// an "I agree to the terms" signature can never be replayed as a settlement
// authorization.
//
// Domain: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//   name "PactaEscrowVault", version "1", chainId = vault chain, verifyingContract = vault
// Types:
//   OpenEngagement(bytes32 agreementHash,address buyer,address provider,address arbiter,address token,uint256 amount)
//   Settlement(bytes32 agreementHash,uint8 outcome,uint256 buyerAmount,uint256 providerAmount)
//
// Signature wire format is Ethereum r||s||v (65 bytes, v in {27,28}), identical
// to src/eip712.js, so the same secp256k1 keys (custodial or self-custody) sign
// both agreements and settlements with no new scheme.
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { keccak_256 } = require('@noble/hashes/sha3.js');

const strip0x = (h) => (String(h).startsWith('0x') ? String(h).slice(2) : String(h));
const toBytes = (hex) => Uint8Array.from(Buffer.from(strip0x(hex), 'hex'));
const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const keccakHex = (input) => toHex(keccak_256(typeof input === 'string' ? Buffer.from(input, 'utf8') : input));

const word = (hex) => strip0x(hex).padStart(64, '0');
const addrWord = (addr) => strip0x(addr).toLowerCase().padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');

const DOMAIN_NAME = 'PactaEscrowVault';
const DOMAIN_VERSION = '1';
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const OPEN_TYPE =
  'OpenEngagement(bytes32 agreementHash,address buyer,address provider,address arbiter,address token,uint256 amount)';
const SETTLE_TYPE = 'Settlement(bytes32 agreementHash,uint8 outcome,uint256 buyerAmount,uint256 providerAmount)';

const OUTCOME = { release: 1, refund: 2, split: 3 };

function domainSeparator({ chainId, verifyingContract }) {
  return keccakHex(toBytes([
    word(keccakHex(DOMAIN_TYPE)),
    word(keccakHex(DOMAIN_NAME)),
    word(keccakHex(DOMAIN_VERSION)),
    uintWord(chainId),
    addrWord(verifyingContract),
  ].join('')));
}

function typedDigest({ chainId, verifyingContract }, structHashHex) {
  return keccak_256(toBytes(`1901${strip0x(domainSeparator({ chainId, verifyingContract }))}${strip0x(structHashHex)}`));
}

function openDigest({ agreementHash, buyer, provider, arbiter, token, amount, chainId, verifyingContract }) {
  const structHash = keccakHex(toBytes([
    word(keccakHex(OPEN_TYPE)),
    word(agreementHash),
    addrWord(buyer),
    addrWord(provider),
    addrWord(arbiter),
    addrWord(token),
    uintWord(amount),
  ].join('')));
  return typedDigest({ chainId, verifyingContract }, structHash);
}

function settlementDigest({ agreementHash, outcome, buyerAmount, providerAmount, chainId, verifyingContract }) {
  const code = typeof outcome === 'number' ? outcome : OUTCOME[outcome];
  if (!code) throw new Error(`unknown settlement outcome '${outcome}'`);
  const structHash = keccakHex(toBytes([
    word(keccakHex(SETTLE_TYPE)),
    word(agreementHash),
    uintWord(code),
    uintWord(buyerAmount),
    uintWord(providerAmount),
  ].join('')));
  return typedDigest({ chainId, verifyingContract }, structHash);
}

// noble 'recovered' layout is recovery||r||s; rewrap as Ethereum r||s||v with
// v in {27,28}, exactly like src/eip712.js signDigest.
function signDigest(digest, privHex) {
  const sig = secp256k1.sign(digest, toBytes(privHex), { format: 'recovered' });
  return toHex(Uint8Array.from([...sig.slice(1), 27 + sig[0]]));
}

function recoverAddress(digest, sigHex) {
  const sig = toBytes(sigHex);
  if (sig.length !== 65) return null;
  try {
    const recovered = secp256k1.recoverPublicKey(Uint8Array.from([sig[64] - 27, ...sig.slice(0, 64)]), digest);
    const pub = secp256k1.Point.fromBytes(recovered).toBytes(false);
    const body = pub.length === 65 ? pub.slice(1) : pub;
    return `0x${Buffer.from(keccak_256(body)).toString('hex').slice(-40)}`;
  } catch {
    return null;
  }
}

const addressOf = (privHex) => {
  const pub = secp256k1.getPublicKey(toBytes(privHex), false);
  const body = pub.length === 65 ? pub.slice(1) : pub;
  return `0x${Buffer.from(keccak_256(body)).toString('hex').slice(-40)}`;
};

module.exports = {
  DOMAIN_NAME, DOMAIN_VERSION, OUTCOME,
  domainSeparator, openDigest, settlementDigest,
  signDigest, recoverAddress, addressOf,
};
