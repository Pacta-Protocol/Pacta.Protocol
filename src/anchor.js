'use strict';
// Phase 0 (ADR-001): public anchoring of event-log Merkle roots.
//
// Adapter contract (mirrors src/registry.js): an adapter exposes
//   name, chainId, sender
//   anchor(root, fromSeq, toSeq)  -> { tx_hash, block_number, block_time }
//   fetchAnchors()                -> [{ root, from_seq, to_seq, sender, tx_hash, block_number }]
//
// Adapters:
//   local  (default) — a simulated chain in the local_chain table. Keeps every
//            demo and CI run deterministic with no RPC, no wallet, no gas.
//   rpc    — the real thing: sends anchor(bytes32,uint64,uint64) transactions
//            to an AnchorRegistry contract (contracts/AnchorRegistry.sol) on
//            any EVM chain via raw JSON-RPC. No web3 dependency: legacy
//            EIP-155 transactions, RLP-encoded and secp256k1-signed here.
//
// Selection mirrors src/llm.js / src/registry.js: ANCHOR_RPC_URL implies rpc;
// ANCHOR_PROVIDER forces. Cadence (all from config/env, never hardcoded):
//   DEBOUNCE_SECONDS (default 300)  — batch entries, anchor once per burst
//   HEARTBEAT_HOURS  (default 24)   — re-anchor last root as liveness signal
//   ALERT_AFTER_MINUTES (default 30) — alert if anchoring keeps failing
const crypto = require('node:crypto');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { merkleRoot } = require('./merkle');
const eip712 = require('./eip712');
const keys = require('./keys');

const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const toBytes = (hex) => Uint8Array.from(Buffer.from(strip0x(hex), 'hex'));
const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

// ---------- local adapter ------------------------------------------------------

class LocalAnchorAdapter {
  constructor(db) {
    this.db = db;
    this.name = 'local';
    this.chainId = 0; // 0 marks a simulated anchor; verifiers skip the on-chain check
    this.sender = eip712.addressOf(keys.platformPubkey());
  }

  async anchor(root, fromSeq, toSeq) {
    const txHash = `0x${crypto.createHash('sha256')
      .update(`local-anchor:${root}:${fromSeq}:${toSeq}:${this.sender}`).digest('hex')}`;
    const info = this.db.prepare(
      'INSERT INTO local_chain (root, from_seq, to_seq, sender, tx_hash) VALUES (?, ?, ?, ?, ?)',
    ).run(root, fromSeq, toSeq, this.sender, txHash);
    const row = this.db.prepare('SELECT * FROM local_chain WHERE block_number = ?').get(Number(info.lastInsertRowid));
    return { tx_hash: txHash, block_number: Number(row.block_number), block_time: row.block_time };
  }

  async fetchAnchors() {
    return this.db.prepare('SELECT * FROM local_chain ORDER BY block_number').all().map((r) => ({
      root: r.root, from_seq: Number(r.from_seq), to_seq: Number(r.to_seq),
      sender: r.sender, tx_hash: r.tx_hash, block_number: Number(r.block_number),
    }));
  }
}

// ---------- rpc adapter --------------------------------------------------------

// Minimal RLP for legacy transactions: byte strings and lists only.
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

const ANCHOR_SELECTOR = toHex(keccak_256(Buffer.from('anchor(bytes32,uint64,uint64)', 'utf8'))).slice(0, 10);
const ANCHORED_TOPIC = toHex(keccak_256(Buffer.from('Anchored(bytes32,uint64,uint64,address)', 'utf8')));
const word = (hex) => strip0x(hex).padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');

class RpcAnchorAdapter {
  constructor({ rpcUrl, contractAddress, signerKey, chainId } = {}, env = process.env) {
    this.name = 'rpc';
    this.rpcUrl = rpcUrl || env.ANCHOR_RPC_URL;
    this.contract = contractAddress || env.ANCHOR_CONTRACT_ADDRESS;
    this.signerKey = signerKey || env.ANCHOR_SIGNER_KEY;
    this.chainId = Number(chainId || env.ANCHOR_CHAIN_ID || 84532);
    if (!this.rpcUrl || !this.contract || !this.signerKey) {
      throw new Error('rpc anchor adapter needs ANCHOR_RPC_URL, ANCHOR_CONTRACT_ADDRESS and ANCHOR_SIGNER_KEY');
    }
    this.sender = eip712.addressOf(eip712.publicKeyOf(this.signerKey));
  }

  async rpc(method, params = []) {
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

  // Legacy EIP-155 transaction, signed locally — no web3 library.
  signTx({ nonce, gasPrice, gas, data }) {
    const unsigned = [qty(nonce), qty(gasPrice), qty(gas), toBytes(this.contract), qty(0), toBytes(data),
      qty(this.chainId), Buffer.alloc(0), Buffer.alloc(0)];
    const digest = keccak_256(rlpEncode(unsigned));
    const sig = secp256k1.sign(digest, toBytes(this.signerKey), { format: 'recovered' });
    const v = BigInt(this.chainId) * 2n + 35n + BigInt(sig[0]);
    const r = sig.slice(1, 33); const s = sig.slice(33, 65);
    const stripZeros = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return Buffer.from(b.slice(i)); };
    return toHex(rlpEncode([qty(nonce), qty(gasPrice), qty(gas), toBytes(this.contract), qty(0), toBytes(data),
      qty(v), stripZeros(r), stripZeros(s)]));
  }

  async anchor(root, fromSeq, toSeq) {
    const onChainId = Number(await this.rpc('eth_chainId'));
    if (onChainId !== this.chainId) {
      throw new Error(`chain id mismatch: RPC says ${onChainId}, config says ${this.chainId}`);
    }
    const data = `${ANCHOR_SELECTOR}${word(root)}${uintWord(fromSeq)}${uintWord(toSeq)}`;
    const nonce = Number(await this.rpc('eth_getTransactionCount', [this.sender, 'pending']));
    const gasPrice = BigInt(await this.rpc('eth_gasPrice'));
    const raw = this.signTx({ nonce, gasPrice, gas: 100_000, data });
    const txHash = await this.rpc('eth_sendRawTransaction', [raw]);
    for (let i = 0; i < 30; i++) {
      const receipt = await this.rpc('eth_getTransactionReceipt', [txHash]);
      if (receipt) {
        if (receipt.status !== '0x1') throw new Error(`anchor tx ${txHash} reverted`);
        const block = await this.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
        return {
          tx_hash: txHash,
          block_number: Number(receipt.blockNumber),
          block_time: new Date(Number(block.timestamp) * 1000).toISOString(),
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`anchor tx ${txHash} not mined after 60s`);
  }

  // Self-monitor source. Residual trust: we take the RPC node's logs and
  // headers at their word (no receipts-trie proof yet — tracked as a follow-up
  // for the real-testnet task). Mitigation available today: configure a second
  // independent RPC and compare, or run the open verifier against any node.
  async fetchAnchors() {
    const logs = await this.rpc('eth_getLogs', [{
      address: this.contract, topics: [ANCHORED_TOPIC], fromBlock: '0x0', toBlock: 'latest',
    }]);
    return logs.map((log) => ({
      root: `0x${strip0x(log.topics[1])}`,
      from_seq: Number(BigInt(`0x${strip0x(log.data).slice(0, 64)}`)),
      to_seq: Number(BigInt(`0x${strip0x(log.data).slice(64, 128)}`)),
      sender: `0x${strip0x(log.topics[2]).slice(-40)}`,
      tx_hash: log.transactionHash,
      block_number: Number(log.blockNumber),
    }));
  }
}

function createAnchorAdapter(db, env = process.env) {
  const forced = (env.ANCHOR_PROVIDER || '').trim().toLowerCase();
  if (forced === 'local') return new LocalAnchorAdapter(db);
  if (forced === 'rpc' || (!forced && env.ANCHOR_RPC_URL)) return new RpcAnchorAdapter({}, env);
  return new LocalAnchorAdapter(db);
}

// ---------- anchoring core -----------------------------------------------------

// Anchor everything not yet covered. One Merkle root over the pending range.
async function anchorPending(db, adapter) {
  const last = db.prepare('SELECT COALESCE(MAX(to_seq), 0) AS s FROM anchors WHERE heartbeat = 0').get();
  const fromSeq = Number(last.s) + 1;
  const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM event_log').get();
  const toSeq = Number(maxRow.s);
  if (toSeq < fromSeq) return null; // nothing pending
  const leaves = db.prepare('SELECT entry_hash FROM event_log WHERE seq BETWEEN ? AND ? ORDER BY seq')
    .all(fromSeq, toSeq).map((r) => r.entry_hash);
  const root = merkleRoot(leaves);
  const receipt = await adapter.anchor(root, fromSeq, toSeq);
  db.prepare(
    'INSERT INTO anchors (root, from_seq, to_seq, chain_id, tx_hash, block_number, block_time, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
  ).run(root, fromSeq, toSeq, adapter.chainId, receipt.tx_hash, receipt.block_number ?? null, receipt.block_time ?? null);
  return { root, from_seq: fromSeq, to_seq: toSeq, ...receipt };
}

// Liveness heartbeat: re-anchor the last root (from == to == last anchored
// seq). Its absence on chain is itself an alarm signal for outside observers.
async function anchorHeartbeat(db, adapter) {
  const last = db.prepare('SELECT * FROM anchors WHERE heartbeat = 0 ORDER BY id DESC LIMIT 1').get();
  if (!last) return null;
  const seq = Number(last.to_seq);
  const receipt = await adapter.anchor(last.root, seq, seq);
  db.prepare(
    'INSERT INTO anchors (root, from_seq, to_seq, chain_id, tx_hash, block_number, block_time, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(last.root, seq, seq, adapter.chainId, receipt.tx_hash, receipt.block_number ?? null, receipt.block_time ?? null);
  return { root: last.root, from_seq: seq, to_seq: seq, ...receipt };
}

// Self-monitor: reconcile our anchors table against what the chain shows.
// Alerts on: an anchor we recorded but the chain lacks (missing), an anchor
// from our sender we never recorded (possible key compromise), root mismatch.
async function reconcile(db, adapter) {
  const chain = await adapter.fetchAnchors();
  const ours = db.prepare('SELECT * FROM anchors WHERE chain_id = ? ORDER BY id').all(adapter.chainId);
  const chainByTx = new Map(chain.map((a) => [a.tx_hash, a]));
  const oursByTx = new Map(ours.map((a) => [a.tx_hash, a]));
  const alerts = [];
  for (const a of ours) {
    const seen = chainByTx.get(a.tx_hash);
    if (!seen) alerts.push({ kind: 'missing_on_chain', tx_hash: a.tx_hash, root: a.root });
    else if (seen.root !== a.root) alerts.push({ kind: 'root_mismatch', tx_hash: a.tx_hash, ours: a.root, chain: seen.root });
  }
  for (const a of chain) {
    if (a.sender.toLowerCase() === adapter.sender.toLowerCase() && !oursByTx.has(a.tx_hash)) {
      alerts.push({ kind: 'unknown_anchor_from_our_sender', tx_hash: a.tx_hash, root: a.root });
    }
  }
  return { ok: alerts.length === 0, checked: ours.length, alerts };
}

// ---------- worker -------------------------------------------------------------

// Hybrid cadence: debounced batching after activity plus a daily heartbeat.
// Retries with exponential backoff; alerts (log + optional webhook) once
// anchoring has been failing longer than alertAfterMinutes.
function createAnchorWorker(db, { adapter, env = process.env, onAlert } = {}) {
  const a = adapter || createAnchorAdapter(db, env);
  const debounceMs = Number(env.DEBOUNCE_SECONDS ?? 300) * 1000;
  const heartbeatMs = Number(env.HEARTBEAT_HOURS ?? 24) * 3600 * 1000;
  const alertAfterMs = Number(env.ALERT_AFTER_MINUTES ?? 30) * 60 * 1000;
  const alertWebhook = env.ALERT_WEBHOOK_URL || null;

  let timer = null;
  let failingSince = null;
  let backoffMs = 5000;

  const alert = (message) => {
    console.error(`[anchor] ALERT: ${message}`);
    if (onAlert) onAlert(message);
    if (alertWebhook) {
      fetch(alertWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'pacta-anchor-worker', message, at: new Date().toISOString() }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  };

  const oldestPendingAt = () => {
    const last = db.prepare('SELECT COALESCE(MAX(to_seq), 0) AS s FROM anchors WHERE heartbeat = 0').get();
    const row = db.prepare('SELECT at FROM event_log WHERE seq > ? ORDER BY seq LIMIT 1').get(Number(last.s));
    return row ? new Date(row.at).getTime() : null;
  };
  const lastAnchorAt = () => {
    const row = db.prepare('SELECT created_at FROM anchors ORDER BY id DESC LIMIT 1').get();
    return row ? new Date(`${row.created_at}Z`).getTime() : null;
  };

  async function tick() {
    try {
      const pending = oldestPendingAt();
      if (pending !== null && Date.now() - pending >= debounceMs) {
        const done = await anchorPending(db, a);
        if (done) console.log(`[anchor] anchored seq ${done.from_seq}..${done.to_seq} root ${done.root.slice(0, 18)}… (${a.name}, tx ${done.tx_hash.slice(0, 18)}…)`);
      } else {
        const lastAt = lastAnchorAt();
        if (lastAt !== null && Date.now() - lastAt >= heartbeatMs) {
          const hb = await anchorHeartbeat(db, a);
          if (hb) console.log(`[anchor] heartbeat re-anchored seq ${hb.to_seq} (${a.name})`);
        }
      }
      failingSince = null;
      backoffMs = 5000;
    } catch (err) {
      failingSince = failingSince || Date.now();
      backoffMs = Math.min(backoffMs * 2, 10 * 60 * 1000);
      console.warn(`[anchor] attempt failed (retrying in ${Math.round(backoffMs / 1000)}s): ${err.message}`);
      if (Date.now() - failingSince >= alertAfterMs) {
        alert(`anchoring has been failing for ${Math.round((Date.now() - failingSince) / 60000)} minutes: ${err.message}`);
      }
    }
    timer = setTimeout(tick, failingSince ? backoffMs : Math.min(debounceMs, 60_000));
    if (timer.unref) timer.unref();
  }

  return {
    adapter: a,
    start: () => { if (!timer) tick(); },
    stop: () => { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

module.exports = {
  LocalAnchorAdapter, RpcAnchorAdapter, createAnchorAdapter,
  anchorPending, anchorHeartbeat, reconcile, createAnchorWorker,
  ANCHOR_SELECTOR, ANCHORED_TOPIC,
};
