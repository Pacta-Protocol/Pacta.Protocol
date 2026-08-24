'use strict';
// Base Readiness (ADR-002): windowed anchoring of event-log Merkle roots.
//
// Every window (default 12h) the service publishes ONE Merkle root covering the
// log entries whose timestamp falls in (windowStart, windowEnd]. It ALWAYS
// emits, even for an empty window (leafCount 0, zero root): one code path, no
// skip logic, no separate heartbeat. A gap in the on-chain sequence is itself
// the alarm. Windows are contiguous - each starts where the last one ended -
// so there are no gaps and, because a window is only recorded after a
// successful anchor, no double-anchoring across retries.
//
// Adapter contract:
//   name, chainId, sender
//   anchor(root, windowStart, windowEnd, leafCount)
//     -> { tx_hash, block_number, block_time, sequence }
//   fetchAnchors()
//     -> [{ sequence, root, window_start, window_end, leaf_count, tx_hash, block_number }]
//
// Adapters:
//   local  (default) - a simulated chain in local_chain. Deterministic, no RPC,
//            no wallet, no gas. chain_id 0 marks a simulated anchor.
//   rpc    - real RootAnchored transactions to an AnchorRegistry contract
//            (contracts/AnchorRegistry.sol) on any EVM chain via raw JSON-RPC.
//            No web3 dependency: EIP-1559 (type-2) txs, RLP-encoded and
//            secp256k1-signed here. Type-2 is required for OP-stack chains such
//            as Base, whose op-geth rejects the legacy EIP-155 encoding at
//            intake ("insufficient funds ... have 0") before it ever debits the
//            account; type-2 is also the modern default on all EVM L1s/L2s.
//
// Selection mirrors src/llm.js / src/registry.js: ANCHOR_RPC_URL implies rpc;
// ANCHOR_PROVIDER forces. Cadence config (env, never hardcoded):
//   ANCHOR_WINDOW_HOURS (default 12)  - window length; also the tick interval
//   ALERT_AFTER_MINUTES (default 30)  - alert if anchoring keeps failing
const crypto = require('node:crypto');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { merkleRoot } = require('./merkle');
const eip712 = require('./eip712');
const keys = require('./keys');

const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const toBytes = (hex) => Uint8Array.from(Buffer.from(strip0x(hex), 'hex'));
const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

// ---------- window leaf selection (single source of truth) ---------------------

// Unix seconds of an event's ISO timestamp.
const unixSeconds = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// Log entries covered by (windowStart, windowEnd], in seq order. Both the
// anchoring service and the proof builder (src/receipts.js) call this so the
// leaf set that produced a root is exactly the leaf set a proof rebuilds from.
function windowEntries(db, windowStart, windowEnd) {
  return db.prepare('SELECT seq, at, entry_hash FROM event_log ORDER BY seq').all()
    .filter((r) => {
      const t = unixSeconds(r.at);
      return t > Number(windowStart) && t <= Number(windowEnd);
    });
}

// ---------- local adapter ------------------------------------------------------

class LocalAnchorAdapter {
  constructor(db) {
    this.db = db;
    this.name = 'local';
    this.chainId = 0; // 0 marks a simulated anchor; verifiers skip the on-chain check
    this.sender = eip712.addressOf(keys.platformPubkey());
  }

  async anchor(root, windowStart, windowEnd, leafCount) {
    const seqRow = this.db.prepare('SELECT COUNT(*) AS n FROM local_chain').get();
    const sequence = Number(seqRow.n);
    const txHash = `0x${crypto.createHash('sha256')
      .update(`local-anchor:${sequence}:${root}:${windowStart}:${windowEnd}:${leafCount}:${this.sender}`)
      .digest('hex')}`;
    const info = this.db.prepare(
      'INSERT INTO local_chain (sequence, root, window_start, window_end, leaf_count, sender, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(sequence, root, windowStart, windowEnd, leafCount, this.sender, txHash);
    const row = this.db.prepare('SELECT * FROM local_chain WHERE block_number = ?').get(Number(info.lastInsertRowid));
    return { tx_hash: txHash, block_number: Number(row.block_number), block_time: row.block_time, sequence };
  }

  async fetchAnchors() {
    return this.db.prepare('SELECT * FROM local_chain ORDER BY block_number').all().map((r) => ({
      sequence: Number(r.sequence), root: r.root,
      window_start: Number(r.window_start), window_end: Number(r.window_end), leaf_count: Number(r.leaf_count),
      sender: r.sender, tx_hash: r.tx_hash, block_number: Number(r.block_number),
    }));
  }
}

// ---------- rpc adapter --------------------------------------------------------

// Minimal RLP for transactions: byte strings and lists only.
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

const ANCHOR_SELECTOR = toHex(keccak_256(Buffer.from('anchor(bytes32,uint64,uint64,uint32)', 'utf8'))).slice(0, 10);
const ROOT_ANCHORED_TOPIC = toHex(keccak_256(Buffer.from('RootAnchored(uint256,bytes32,uint64,uint64,uint32)', 'utf8')));
const word = (hex) => strip0x(hex).padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');

class RpcAnchorAdapter {
  constructor({ rpcUrl, contractAddress, signerKey, chainId } = {}, env = process.env) {
    this.name = 'rpc';
    this.rpcUrl = rpcUrl || env.ANCHOR_RPC_URL;
    this.contract = contractAddress || env.ANCHOR_CONTRACT_ADDRESS;
    this.signerKey = signerKey || env.ANCHOR_SIGNER_KEY;
    // Base mainnet by default; override with ANCHOR_CHAIN_ID (e.g. 84532 for
    // Base Sepolia). This is the chain id signed into the type-2 anchor writes.
    this.chainId = Number(chainId || env.ANCHOR_CHAIN_ID || 8453);
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

  // EIP-1559 (type-2) transaction, signed locally - no web3 library. The tx
  // fields, in canonical order:
  //   [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value,
  //    data, accessList]
  // The signing digest is keccak256(0x02 || rlp(fields)); the raw tx is
  //   0x02 || rlp([...fields, yParity, r, s]).
  // Legacy EIP-155 is deliberately gone: OP-stack nodes (Base) reject it.
  signTx({ nonce, maxPriorityFeePerGas, maxFeePerGas, gas, data }) {
    const fields = [
      qty(this.chainId), qty(nonce), qty(maxPriorityFeePerGas), qty(maxFeePerGas),
      qty(gas), toBytes(this.contract), qty(0), toBytes(data), [],
    ];
    const digest = keccak_256(Buffer.concat([Buffer.from([0x02]), rlpEncode(fields)]));
    // prehash:false is REQUIRED: `digest` is already the final 32-byte tx sighash
    // (keccak256 over 0x02||rlp(fields)). @noble/curves v2 defaults to
    // prehash:true, which would sha256 the digest again before signing - a
    // silent double-hash. The resulting signature is internally consistent (it
    // would even pass @noble's own verify) but recovers to the WRONG address on
    // chain, so op-geth looks up a zero-balance account and rejects the tx with
    // "insufficient funds ... have 0". Signing the raw digest is what ecrecover
    // and every EVM node expect.
    const sig = secp256k1.sign(digest, toBytes(this.signerKey), { format: 'recovered', prehash: false });
    // r and s are RLP-encoded as minimal big-endian byte strings.
    const stripZeros = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return Buffer.from(b.slice(i)); };
    const yParity = qty(sig[0]); // 0 or 1
    const r = stripZeros(Buffer.from(sig.slice(1, 33)));
    const s = stripZeros(Buffer.from(sig.slice(33, 65)));
    const signed = rlpEncode([...fields, yParity, r, s]);
    return toHex(Buffer.concat([Buffer.from([0x02]), signed]));
  }

  async anchor(root, windowStart, windowEnd, leafCount) {
    const onChainId = Number(await this.rpc('eth_chainId'));
    if (onChainId !== this.chainId) {
      throw new Error(`chain id mismatch: RPC says ${onChainId}, config says ${this.chainId}`);
    }
    const data = `${ANCHOR_SELECTOR}${word(root)}${uintWord(windowStart)}${uintWord(windowEnd)}${uintWord(leafCount)}`;
    const nonce = Number(await this.rpc('eth_getTransactionCount', [this.sender, 'pending']));
    // EIP-1559 fees from the network: tip from eth_maxPriorityFeePerGas, cap
    // from the pending block's baseFee. maxFee = baseFee*2 + tip leaves headroom
    // for a base-fee rise across the next few blocks (the OP-stack L1 data fee
    // is charged on top by the node and needs no field here).
    const priority = BigInt(await this.rpc('eth_maxPriorityFeePerGas'));
    const pendingBlock = await this.rpc('eth_getBlockByNumber', ['pending', false]);
    const baseFee = BigInt(pendingBlock.baseFeePerGas || '0x0');
    const maxPriorityFeePerGas = priority;
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
    const raw = this.signTx({ nonce, maxPriorityFeePerGas, maxFeePerGas, gas: 100_000, data });
    const txHash = await this.rpc('eth_sendRawTransaction', [raw]);
    for (let i = 0; i < 30; i++) {
      const receipt = await this.rpc('eth_getTransactionReceipt', [txHash]);
      if (receipt) {
        if (receipt.status !== '0x1') throw new Error(`anchor tx ${txHash} reverted`);
        const log = (receipt.logs || []).find((l) => (l.topics || [])[0] === ROOT_ANCHORED_TOPIC);
        const sequence = log ? Number(BigInt(log.topics[1])) : null;
        // The block header can lag the receipt on some providers (the receipt is
        // served from the txpool/tracer before the block is fully indexed), so
        // eth_getBlockByNumber may briefly return null. Retry a few times; the
        // anchor is already mined, so never throw here - fall back to null time
        // rather than lose a recorded anchor and risk re-anchoring the window.
        let block = null;
        for (let j = 0; j < 5 && !block; j++) {
          block = await this.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
          if (!block) await new Promise((r) => setTimeout(r, 1000));
        }
        return {
          tx_hash: txHash,
          block_number: Number(receipt.blockNumber),
          block_time: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
          sequence,
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`anchor tx ${txHash} not mined after 60s`);
  }

  // Self-monitor source. Residual trust: we take the RPC node's logs and
  // headers at their word (no receipts-trie proof yet - tracked as a follow-up
  // for the real-testnet task). Mitigation available today: configure a second
  // independent RPC and compare, or run the open verifier against any node.
  async fetchAnchors() {
    const logs = await this.rpc('eth_getLogs', [{
      address: this.contract, topics: [ROOT_ANCHORED_TOPIC], fromBlock: '0x0', toBlock: 'latest',
    }]);
    return logs.map((log) => ({
      sequence: Number(BigInt(log.topics[1])),
      root: `0x${strip0x(log.topics[2])}`,
      window_start: Number(BigInt(`0x${strip0x(log.data).slice(0, 64)}`)),
      window_end: Number(BigInt(`0x${strip0x(log.data).slice(64, 128)}`)),
      leaf_count: Number(BigInt(`0x${strip0x(log.data).slice(128, 192)}`)),
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

// Anchor one window: (last anchored window_end, now]. Always emits - an empty
// window goes out with leafCount 0 and the zero root. `now` is injectable for
// tests and for deterministic scheduling. Returns null only for a degenerate
// zero-width window (two calls within the same second), never as a content skip.
function anchorPending(db, adapter, { now = Date.now() } = {}) {
  const nowSec = Math.floor(now / 1000);
  const lastEnd = db.prepare('SELECT MAX(window_end) AS e FROM anchors').get().e;
  let windowStart;
  if (lastEnd != null) {
    windowStart = Number(lastEnd);
  } else {
    // First anchor: start just before the earliest event so the opening window
    // covers the whole log; on an empty log, start at the current second so the
    // first non-empty window opens cleanly.
    const first = db.prepare('SELECT MIN(at) AS a FROM event_log').get().a;
    windowStart = first ? unixSeconds(first) - 1 : nowSec - 1;
  }
  // Close at the last FULLY-ELAPSED second (nowSec - 1), never the second in
  // progress. An event inserted "now" gets a timestamp of nowSec; if we closed
  // at nowSec, such an event landing after we read the log would fall on the
  // window boundary yet be absent from the anchored leaf set, and the next
  // window (which selects t > windowStart == this windowEnd) would exclude it
  // forever - a silent orphan. Deferring the current second to the next window
  // guarantees every entry is eventually covered.
  const windowEnd = nowSec - 1;
  if (windowEnd <= windowStart) return null; // no fully-elapsed time since last anchor
  const entries = windowEntries(db, windowStart, windowEnd);
  const root = merkleRoot(entries.map((r) => r.entry_hash));
  const leafCount = entries.length;
  return Promise.resolve(adapter.anchor(root, windowStart, windowEnd, leafCount)).then((receipt) => {
    db.prepare(
      'INSERT INTO anchors (sequence, root, window_start, window_end, leaf_count, chain_id, tx_hash, block_number, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(receipt.sequence, root, windowStart, windowEnd, leafCount, adapter.chainId,
      receipt.tx_hash, receipt.block_number ?? null, receipt.block_time ?? null);
    return {
      sequence: receipt.sequence, root, window_start: windowStart, window_end: windowEnd,
      leaf_count: leafCount, ...receipt,
    };
  });
}

// Self-monitor: reconcile our anchors table against what the chain shows.
// Alerts on: an anchor we recorded but the chain lacks (missing), an anchor on
// chain we never recorded (the contract only lets the anchorer write, so an
// unrecorded one signals key compromise or an out-of-band call), root mismatch.
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
    if (!oursByTx.has(a.tx_hash)) {
      alerts.push({ kind: 'unknown_anchor_on_chain', tx_hash: a.tx_hash, root: a.root, sequence: a.sequence });
    }
  }
  return { ok: alerts.length === 0, checked: ours.length, alerts };
}

// ---------- worker -------------------------------------------------------------

// Windowed cadence: one anchor per ANCHOR_WINDOW_HOURS, always. On failure it
// retries the SAME window (nothing is recorded until the anchor succeeds, so
// window_start does not advance) with exponential backoff, and alerts (log +
// optional webhook) once anchoring has been failing longer than alertAfterMinutes.
function createAnchorWorker(db, { adapter, env = process.env, onAlert } = {}) {
  const a = adapter || createAnchorAdapter(db, env);
  const windowMs = Number(env.ANCHOR_WINDOW_HOURS ?? 12) * 3600 * 1000;
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

  let firstTick = true;
  async function tick() {
    try {
      // On boot/restart, don't emit a zero-leaf anchor for a partial window:
      // anchor now only if there is pending content, or a full window has elapsed
      // since the last anchor. The 12h empty-window heartbeat still fires on the
      // periodic tick; this only stops every restart from minting an empty anchor.
      if (firstTick) {
        firstTick = false;
        const nowSec = Math.floor(Date.now() / 1000);
        const lastEnd = db.prepare('SELECT MAX(window_end) AS e FROM anchors').get().e;
        const since = lastEnd != null ? Number(lastEnd) : -1;
        const pending = db.prepare('SELECT at FROM event_log').all()
          .filter((r) => unixSeconds(r.at) > since).length;
        const windowElapsed = lastEnd != null && (nowSec - Number(lastEnd)) >= windowMs / 1000;
        if (pending === 0 && !windowElapsed) {
          timer = setTimeout(tick, windowMs);
          if (timer.unref) timer.unref();
          return;
        }
      }
      const done = await anchorPending(db, a);
      if (done) {
        console.log(`[anchor] window ${done.window_start}..${done.window_end} → seq ${done.sequence}, ${done.leaf_count} leaves, root ${done.root.slice(0, 18)}… (${a.name}, tx ${done.tx_hash.slice(0, 18)}…)`);
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
    timer = setTimeout(tick, failingSince ? backoffMs : windowMs);
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
  anchorPending, reconcile, createAnchorWorker, windowEntries, unixSeconds,
  ANCHOR_SELECTOR, ROOT_ANCHORED_TOPIC,
};
