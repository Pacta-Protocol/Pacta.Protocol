'use strict';
// Raw JSON-RPC transport + legacy EIP-155 transaction signing, in the same
// dependency-light style as src/anchor.js (RpcAnchorAdapter): no web3, no
// ethers, no viem — RLP + secp256k1 from @noble, transport over fetch. The
// transport is injectable so unit tests drive the adapter against a mock
// JSON-RPC with no network.
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

const strip0x = (h) => (String(h).startsWith('0x') ? String(h).slice(2) : String(h));
const toBytes = (hex) => Uint8Array.from(Buffer.from(strip0x(hex), 'hex'));
const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

// ---- minimal RLP for legacy txs (byte strings and lists only) -----------------
function rlpEncode(item) {
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlpEncode));
    return Buffer.concat([rlpLength(body.length, 0xc0), body]);
  }
  const buf = Buffer.from(item);
  if (buf.length === 1 && buf[0] < 0x80) return buf;
  return Buffer.concat([rlpLength(buf.length, 0x80), buf]);
}
function rlpLength(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  let hex = len.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const lenBytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}
// Quantities are minimal big-endian bytes; zero is the empty string.
function qty(n) {
  let hex = BigInt(n).toString(16);
  if (hex === '0') return Buffer.alloc(0);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}
const stripZeros = (b) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return Buffer.from(b.slice(i));
};

// Sign a legacy EIP-155 transaction locally, returning the raw 0x hex to submit
// via eth_sendRawTransaction. Identical construction to src/anchor.js signTx.
function signLegacyTx({ nonce, gasPrice, gas, to, value = 0, data, chainId, signerKey }) {
  const unsigned = [
    qty(nonce), qty(gasPrice), qty(gas), toBytes(to), qty(value), toBytes(data),
    qty(chainId), Buffer.alloc(0), Buffer.alloc(0),
  ];
  const digest = keccak_256(rlpEncode(unsigned));
  const sig = secp256k1.sign(digest, toBytes(signerKey), { format: 'recovered' });
  const v = BigInt(chainId) * 2n + 35n + BigInt(sig[0]);
  const r = sig.slice(1, 33);
  const s = sig.slice(33, 65);
  return toHex(rlpEncode([
    qty(nonce), qty(gasPrice), qty(gas), toBytes(to), qty(value), toBytes(data),
    qty(v), stripZeros(r), stripZeros(s),
  ]));
}

// A thin JSON-RPC client. `transport` (async (method, params) => result) is
// injectable; the default posts to `rpcUrl` with fetch.
class JsonRpc {
  constructor({ rpcUrl, transport } = {}) {
    this.rpcUrl = rpcUrl;
    this._transport = transport;
  }

  async call(method, params = []) {
    if (this._transport) return this._transport(method, params);
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`rpc ${method} → HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`rpc ${method} → ${data.error.message}`);
    return data.result;
  }
}

module.exports = { JsonRpc, signLegacyTx, rlpEncode, qty, toBytes, toHex, strip0x };
