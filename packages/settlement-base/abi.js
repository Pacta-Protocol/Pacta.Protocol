'use strict';
// Minimal ABI codec for the EscrowVault calls — dependency-light, in the same
// raw style as src/anchor.js (which hand-rolls RLP + secp256k1 rather than
// pulling in ethers/viem). anchor.js only ever encodes static words; the vault
// passes dynamic `bytes` (the signatures), so this adds the head/tail layout
// for dynamic types. Supported types: bytes32, address, uint256, uint8, bool,
// bytes. That is exactly the EscrowVault surface and no more.
const { keccak_256 } = require('@noble/hashes/sha3.js');

const strip0x = (h) => (String(h).startsWith('0x') ? String(h).slice(2) : String(h));
const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

// 4-byte selector for a Solidity function signature, e.g. "fund(bytes32,uint256)".
function selector(signature) {
  return toHex(keccak_256(Buffer.from(signature, 'utf8'))).slice(0, 10);
}

const isDynamic = (type) => type === 'bytes' || type === 'string';

// One 32-byte word, big-endian, lower-case hex without 0x.
function word(hexOrValue, type) {
  if (type === 'address') {
    return strip0x(hexOrValue).toLowerCase().padStart(64, '0');
  }
  if (type === 'bytes32') {
    return strip0x(hexOrValue).toLowerCase().padStart(64, '0');
  }
  if (type === 'bool') {
    return (hexOrValue ? 1n : 0n).toString(16).padStart(64, '0');
  }
  // uint*: accept bigint | number | 0x-hex | decimal string
  let v;
  if (typeof hexOrValue === 'bigint') v = hexOrValue;
  else if (typeof hexOrValue === 'number') v = BigInt(hexOrValue);
  else if (String(hexOrValue).startsWith('0x')) v = BigInt(hexOrValue);
  else v = BigInt(hexOrValue);
  if (v < 0n) throw new Error('uint cannot be negative');
  return v.toString(16).padStart(64, '0');
}

// Encode a dynamic `bytes` value: length word + right-padded data.
function encodeBytes(value) {
  const hex = strip0x(value);
  const byteLen = hex.length / 2;
  const lenWord = BigInt(byteLen).toString(16).padStart(64, '0');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return lenWord + (byteLen === 0 ? '' : padded);
}

// abi.encode(types, values) with the standard head/tail layout, returned as a
// 0x hex string. Static types occupy their word in the head; dynamic types put
// an offset in the head and their contents in the tail.
function encodeParameters(types, values) {
  if (types.length !== values.length) throw new Error('abi encode: types/values length mismatch');
  const heads = [];
  const tails = [];
  let tailOffset = types.length * 32;
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (isDynamic(t)) {
      heads.push(BigInt(tailOffset).toString(16).padStart(64, '0'));
      const tail = encodeBytes(values[i]);
      tails.push(tail);
      tailOffset += tail.length / 2;
    } else {
      heads.push(word(values[i], t));
    }
  }
  return `0x${heads.join('')}${tails.join('')}`;
}

// selector + encoded params → calldata hex.
function encodeCall(signature, types, values) {
  return selector(signature) + strip0x(encodeParameters(types, values));
}

// Decode a single uint256 return value (view calls: escrowBalance, collateralOf).
function decodeUint(hex) {
  const h = strip0x(hex);
  if (h.length === 0) return 0n;
  return BigInt(`0x${h.slice(0, 64)}`);
}

module.exports = { selector, encodeParameters, encodeCall, decodeUint, word, encodeBytes };
