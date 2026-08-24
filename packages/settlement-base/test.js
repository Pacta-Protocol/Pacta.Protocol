'use strict';
// Unit tests for @pacta/settlement-base against a MOCK JSON-RPC — no network,
// no chain. They verify: call encoding (selectors + ABI params, by decoding the
// signed raw tx the adapter submits), decoding of view calls and event logs,
// uniform receipts with the onchain block, and the EIP-712 signature mapping
// (the signatures the adapter puts on-chain recover to the right parties under
// the vault domain, exactly as contracts/EscrowVault.sol would check them).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const abi = require('./abi');
const vault = require('./eip712-vault');
const {
  BaseEscrowVaultBackend, BaseVaultError, register, backendFromEnv, vaultSlashDigest, SLASHED_TOPIC,
} = require('./index');

const CHAIN_ID = 84532;
const CONTRACT = '0x00000000000000000000000000000000000000c0';

// Deterministic test keys and their addresses.
const KEY = {
  buyer: '0x1111111111111111111111111111111111111111111111111111111111111111',
  provider: '0x2222222222222222222222222222222222222222222222222222222222222222',
  arbiter: '0x3333333333333333333333333333333333333333333333333333333333333333',
  relayer: '0x4444444444444444444444444444444444444444444444444444444444444444',
};
const ADDR = Object.fromEntries(Object.entries(KEY).map(([k, v]) => [k, vault.addressOf(v)]));

const HASH = `0x${'ab'.repeat(32)}`;

// ---- minimal RLP decode (to read `to` and `data` from the signed raw tx) ------
function rlpDecode(buf) {
  let i = 0;
  function item() {
    const b = buf[i];
    if (b < 0x80) { i += 1; return buf.slice(i - 1, i); }
    if (b < 0xb8) { const n = b - 0x80; i += 1; const v = buf.slice(i, i + n); i += n; return v; }
    if (b < 0xc0) { const ln = b - 0xb7; i += 1; const n = Number(BigInt(`0x${buf.slice(i, i + ln).toString('hex') || '0'}`)); i += ln; const v = buf.slice(i, i + n); i += n; return v; }
    if (b < 0xf8) { const n = b - 0xc0; i += 1; const end = i + n; const list = []; while (i < end) list.push(item()); return list; }
    const ln = b - 0xf7; i += 1; const n = Number(BigInt(`0x${buf.slice(i, i + ln).toString('hex')}`)); i += ln; const end = i + n; const list = []; while (i < end) list.push(item()); return list;
  }
  return item();
}

function decodeTx(rawHex) {
  const fields = rlpDecode(Buffer.from(rawHex.slice(2), 'hex'));
  return {
    to: `0x${fields[3].toString('hex')}`,
    data: `0x${fields[5].toString('hex')}`,
  };
}

// A programmable mock JSON-RPC. Records sent raw txs; returns canned results.
function mockRpc({ escrowBalance = 0n, collateral = 0n, slashed = null } = {}) {
  const sent = [];
  const transport = async (method, params) => {
    switch (method) {
      case 'eth_getTransactionCount': return '0x0';
      case 'eth_gasPrice': return '0x3b9aca00';
      case 'eth_sendRawTransaction': {
        sent.push(params[0]);
        return `0x${'de'.repeat(32)}`;
      }
      case 'eth_getTransactionReceipt': {
        const logs = [];
        if (slashed != null) {
          logs.push({ topics: [SLASHED_TOPIC, HASH, ADDR.provider, ADDR.buyer], data: `0x${BigInt(slashed).toString(16).padStart(64, '0')}` });
        }
        return { status: '0x1', blockNumber: '0x10', logs };
      }
      case 'eth_call': {
        const data = params[0].data;
        const sel = data.slice(0, 10);
        if (sel === abi.selector('escrowBalance(bytes32)')) return `0x${BigInt(escrowBalance).toString(16).padStart(64, '0')}`;
        if (sel === abi.selector('collateralOf(address)')) return `0x${BigInt(collateral).toString(16).padStart(64, '0')}`;
        return '0x';
      }
      default: throw new Error(`unexpected rpc ${method}`);
    }
  };
  return { transport, sent, lastTx: () => decodeTx(sent[sent.length - 1]) };
}

function makeBackend(mock, extra = {}) {
  return new BaseEscrowVaultBackend({
    chainId: CHAIN_ID, contract: CONTRACT, signerKey: KEY.relayer, transport: mock.transport, ...extra,
  });
}

function handle(b) {
  return b.openEscrow({
    engagementId: HASH,
    buyer: { kind: 'agent', id: 1, address: ADDR.buyer },
    provider: { kind: 'smb', id: 2, address: ADDR.provider },
    arbiter: { address: ADDR.arbiter },
    amountMinor: 1_000_000n,
  });
}

const RECEIPT_FIELDS = ['backend', 'currency', 'operation', 'engagement_id', 'amount_minor', 'movements', 'onchain'].sort();
function assertUniform(r, op) {
  assert.deepEqual(Object.keys(r).sort(), RECEIPT_FIELDS, 'receipt has exactly the uniform fields');
  assert.equal(r.backend, 'base-escrow-vault');
  assert.equal(r.currency, 'USDC');
  assert.equal(r.operation, op);
  assert.equal(typeof r.amount_minor, 'bigint');
  assert.ok(Array.isArray(r.movements));
}

// ---- abi codec ---------------------------------------------------------------

test('abi: encodes a dynamic-bytes call with correct head/tail layout', () => {
  const sig = '0x' + 'aa'.repeat(65);
  const data = abi.encodeCall('fund(bytes32,uint256)', ['bytes32', 'uint256'], [HASH, 1_000_000n]);
  assert.equal(data.slice(0, 10), abi.selector('fund(bytes32,uint256)'));
  const dyn = abi.encodeParameters(['bytes32', 'bytes'], [HASH, sig]);
  // head: hash word + offset(0x40); tail: len(65) + padded data
  assert.equal(dyn.slice(2, 66), HASH.slice(2));
  assert.equal(BigInt(`0x${dyn.slice(66, 130)}`), 64n);
  assert.equal(BigInt(`0x${dyn.slice(130, 194)}`), 65n);
});

// ---- openEscrow / handle -----------------------------------------------------

test('openEscrow: keys by agreement_hash and binds addresses; rejects bad input', () => {
  const b = makeBackend(mockRpc());
  const h = handle(b);
  assert.equal(h.agreementHash, HASH);
  assert.deepEqual(h.addresses, { buyer: ADDR.buyer, provider: ADDR.provider, arbiter: ADDR.arbiter });
  assert.equal(h.amountMinor, 1_000_000n);
  assert.throws(() => b.openEscrow({ engagementId: 42, buyer: { address: ADDR.buyer }, provider: { address: ADDR.provider } }), /agreement_hash/);
  assert.throws(() => b.openEscrow({ engagementId: HASH, buyer: { kind: 'agent', id: 1 }, provider: { address: ADDR.provider } }), /on-chain address/);
});

// ---- open (dual signature) ---------------------------------------------------

test('open: encodes openEngagement with BOTH buyer and provider signatures', async () => {
  const mock = mockRpc();
  const b = makeBackend(mock);
  const r = await b.open(handle(b), {}, { buyerKey: KEY.buyer, providerKey: KEY.provider });
  assertUniform(r, 'open');
  const tx = mock.lastTx();
  assert.equal(tx.data.slice(0, 10), abi.selector('openEngagement(bytes32,address,address,address,uint256,bytes,bytes)'));
  // Both signatures must recover to the bound addresses under the vault domain.
  const digest = vault.openDigest({
    agreementHash: HASH, buyer: ADDR.buyer, provider: ADDR.provider, arbiter: ADDR.arbiter,
    token: b.usdc, amount: 1_000_000n, chainId: CHAIN_ID, verifyingContract: CONTRACT,
  });
  const d = abi_decode_open(tx.data);
  assert.equal(vault.recoverAddress(digest, d.buyerSig), ADDR.buyer);
  assert.equal(vault.recoverAddress(digest, d.providerSig), ADDR.provider);
});

test('open: fails without the provider signature', async () => {
  const b = makeBackend(mockRpc());
  await assert.rejects(() => b.open(handle(b), {}, { buyerKey: KEY.buyer }), /provider/);
});

// ---- fund --------------------------------------------------------------------

test('fund: encodes fund(bytes32,uint256) and returns a uniform onchain receipt', async () => {
  const mock = mockRpc();
  const b = makeBackend(mock);
  const r = await b.fund(handle(b), 400_000n, { funderKey: KEY.buyer });
  assertUniform(r, 'fund');
  assert.equal(r.amount_minor, 400_000n);
  assert.equal(r.onchain.chain_id, CHAIN_ID);
  assert.equal(r.onchain.block_number, 16);
  assert.match(r.onchain.tx_hash, /^0x[0-9a-f]{64}$/);
  const tx = mock.lastTx();
  assert.equal(tx.to.toLowerCase(), CONTRACT.toLowerCase());
  assert.equal(tx.data.slice(0, 10), abi.selector('fund(bytes32,uint256)'));
  assert.equal(tx.data, abi.encodeCall('fund(bytes32,uint256)', ['bytes32', 'uint256'], [HASH, 400_000n]));
});

test('fund: a zero amount is a no-op receipt with no tx', async () => {
  const mock = mockRpc();
  const b = makeBackend(mock);
  const r = await b.fund(handle(b), 0n);
  assertUniform(r, 'fund');
  assert.equal(r.amount_minor, 0n);
  assert.equal(r.onchain, null);
  assert.equal(mock.sent.length, 0);
});

// ---- release / refund / split : arbiter and mutual authorization -------------

test('release: settle(release) authorized by the arbiter; signature recovers on-chain-style', async () => {
  const mock = mockRpc({ escrowBalance: 1_000_000n });
  const b = makeBackend(mock);
  const r = await b.release(handle(b), {}, { arbiterKey: KEY.arbiter });
  assertUniform(r, 'release');
  assert.equal(r.amount_minor, 1_000_000n);
  assert.equal(r.movements.length, 1);
  const tx = mock.lastTx();
  assert.equal(tx.data.slice(0, 10), abi.selector('settle(bytes32,uint8,uint256,uint256,bytes,bytes)'));
  // Recompute the settlement digest and confirm sigA recovers to the arbiter.
  const digest = vault.settlementDigest({
    agreementHash: HASH, outcome: vault.OUTCOME.release, buyerAmount: 0n, providerAmount: 1_000_000n,
    chainId: CHAIN_ID, verifyingContract: CONTRACT,
  });
  const decoded = abi_decode_settle(tx.data);
  assert.equal(vault.recoverAddress(digest, decoded.sigA), ADDR.arbiter);
});

test('refund: settle(refund) authorized by BOTH parties; both sigs recover', async () => {
  const mock = mockRpc({ escrowBalance: 900_000n });
  const b = makeBackend(mock);
  const r = await b.refund(handle(b), {}, { buyerKey: KEY.buyer, providerKey: KEY.provider });
  assertUniform(r, 'refund');
  assert.equal(r.amount_minor, 900_000n);
  const digest = vault.settlementDigest({
    agreementHash: HASH, outcome: vault.OUTCOME.refund, buyerAmount: 900_000n, providerAmount: 0n,
    chainId: CHAIN_ID, verifyingContract: CONTRACT,
  });
  const d = abi_decode_settle(mock.lastTx().data);
  const recovered = [vault.recoverAddress(digest, d.sigA), vault.recoverAddress(digest, d.sigB)].sort();
  assert.deepEqual(recovered, [ADDR.buyer, ADDR.provider].sort());
});

test('split: passes explicit amounts and records two movements', async () => {
  const mock = mockRpc({ escrowBalance: 1_000_001n });
  const b = makeBackend(mock);
  const r = await b.split(handle(b), 500_000n, 500_001n, {}, { arbiterKey: KEY.arbiter });
  assertUniform(r, 'split');
  assert.equal(r.amount_minor, 1_000_001n);
  assert.equal(r.movements.length, 2);
  const d = abi_decode_settle(mock.lastTx().data);
  assert.equal(d.outcome, vault.OUTCOME.split);
  assert.equal(d.buyerAmount, 500_000n);
  assert.equal(d.providerAmount, 500_001n);
});

test('settle: accepts pre-made signatures via authorization.settlementSigs', async () => {
  const mock = mockRpc({ escrowBalance: 1_000_000n });
  const b = makeBackend(mock);
  const digest = vault.settlementDigest({
    agreementHash: HASH, outcome: vault.OUTCOME.release, buyerAmount: 0n, providerAmount: 1_000_000n,
    chainId: CHAIN_ID, verifyingContract: CONTRACT,
  });
  const settlementSigs = [vault.signDigest(digest, KEY.buyer), vault.signDigest(digest, KEY.provider)];
  const r = await b.release(handle(b), { settlementSigs }, {});
  assertUniform(r, 'release');
  const d = abi_decode_settle(mock.lastTx().data);
  assert.equal(d.sigA, settlementSigs[0]);
  assert.equal(d.sigB, settlementSigs[1]);
});

test('settle: with no signatures and no keys, fails loudly', async () => {
  const b = makeBackend(mockRpc({ escrowBalance: 1n }));
  await assert.rejects(() => b.release(handle(b), {}, {}), /needs authorization/);
});

// ---- slash -------------------------------------------------------------------

test('slash: encodes slashCollateral, recovers arbiter, reports the on-chain amount', async () => {
  const mock = mockRpc({ slashed: 200_000n });
  const b = makeBackend(mock);
  const r = await b.slash(
    { kind: 'smb', id: 2, address: ADDR.provider },
    999_999n, // advisory; the contract decides the real amount
    {},
    { agreementHash: HASH, outcome: 'refund', arbiterKey: KEY.arbiter, beneficiary: { kind: 'agent', id: 1, address: ADDR.buyer } },
  );
  assertUniform(r, 'slash');
  assert.equal(r.amount_minor, 200_000n, 'reports the amount actually slashed on-chain');
  assert.equal(r.movements.length, 1);
  const tx = mock.lastTx();
  assert.equal(tx.data.slice(0, 10), abi.selector('slashCollateral(bytes32,uint8,bytes,bytes)'));
  const digest = vaultSlashDigest(HASH, vault.OUTCOME.refund, { chainId: CHAIN_ID, verifyingContract: CONTRACT });
  const d = abi_decode_slash(tx.data);
  assert.equal(vault.recoverAddress(digest, d.sigA), ADDR.arbiter);
});

test('slash: requires a ruling outcome', async () => {
  const b = makeBackend(mockRpc());
  await assert.rejects(
    () => b.slash({ address: ADDR.provider }, 1n, {}, { agreementHash: HASH, arbiterKey: KEY.arbiter }),
    /ruling outcome/,
  );
});

// ---- collateral views + deposit ----------------------------------------------

test('stakeBalance / escrowBalance decode uint256 view results', async () => {
  const b = makeBackend(mockRpc({ escrowBalance: 777n, collateral: 42_000n }));
  assert.equal(await b.escrowBalance({ agreementHash: HASH }), 777n);
  assert.equal(await b.stakeBalance({ address: ADDR.provider }), 42_000n);
});

test('stake: encodes depositCollateral and returns a uniform receipt', async () => {
  const mock = mockRpc();
  const b = makeBackend(mock);
  const r = await b.stake({ address: ADDR.provider }, 30_000n, { funderKey: KEY.provider });
  assertUniform(r, 'stake');
  assert.equal(r.amount_minor, 30_000n);
  assert.equal(mock.lastTx().data.slice(0, 10), abi.selector('depositCollateral(address,uint256)'));
});

// ---- guards ------------------------------------------------------------------

test('rejects non-integer minor units (no floats)', async () => {
  const b = makeBackend(mockRpc());
  await assert.rejects(() => b.fund(handle(b), 1.5), /no floats/);
});

test('constructor: requires a contract address; USDC defaults per chain', () => {
  assert.throws(() => new BaseEscrowVaultBackend({ chainId: CHAIN_ID }), /contract address is required/);
  const b = makeBackend(mockRpc());
  assert.equal(b.usdc, '0x036CbD53842c5426634e7929541eC2318f3dCF7e'); // Base Sepolia USDC (Circle)
});

// ---- registration ------------------------------------------------------------

test('register: wires base-escrow-vault into the core registration function', () => {
  const registered = {};
  register((id, factory) => { registered[id] = factory; });
  assert.equal(typeof registered['base-escrow-vault'], 'function');
  // The factory reads env; missing config fails loudly (never silent).
  assert.throws(() => registered['base-escrow-vault'](null, {}), /contract address is required/);
  assert.throws(() => register(null), BaseVaultError);
});

test('backendFromEnv: reads VAULT_* env', () => {
  const b = backendFromEnv({ VAULT_CHAIN_ID: '84532', VAULT_CONTRACT_ADDRESS: CONTRACT, VAULT_SIGNER_KEY: KEY.relayer }, { transport: mockRpc().transport });
  assert.equal(b.id, 'base-escrow-vault');
  assert.equal(b.chainId, CHAIN_ID);
});

// ---- helpers: decode the dynamic-tail of settle/slash calldata ----------------
// settle(bytes32,uint8,uint256,uint256,bytes,bytes): 6 head words then two
// bytes tails. slashCollateral(bytes32,uint8,bytes,bytes): 4 head words then two.
function readBytesAt(hexNo0x, offsetBytes) {
  const start = offsetBytes * 2;
  const len = Number(BigInt(`0x${hexNo0x.slice(start, start + 64)}`));
  return `0x${hexNo0x.slice(start + 64, start + 64 + len * 2)}`;
}
function abi_decode_settle(data) {
  const h = data.slice(10); // strip selector
  const outcome = Number(BigInt(`0x${h.slice(64, 128)}`));
  const buyerAmount = BigInt(`0x${h.slice(128, 192)}`);
  const providerAmount = BigInt(`0x${h.slice(192, 256)}`);
  const offA = Number(BigInt(`0x${h.slice(256, 320)}`));
  const offB = Number(BigInt(`0x${h.slice(320, 384)}`));
  return { outcome, buyerAmount, providerAmount, sigA: readBytesAt(h, offA), sigB: readBytesAt(h, offB) };
}
function abi_decode_slash(data) {
  const h = data.slice(10);
  const outcome = Number(BigInt(`0x${h.slice(64, 128)}`));
  const offA = Number(BigInt(`0x${h.slice(128, 192)}`));
  const offB = Number(BigInt(`0x${h.slice(192, 256)}`));
  return { outcome, sigA: readBytesAt(h, offA), sigB: readBytesAt(h, offB) };
}
// openEngagement(bytes32,address,address,address,uint256,bytes,bytes): 7 head
// words (5 static + 2 offsets) then two bytes tails.
function abi_decode_open(data) {
  const h = data.slice(10);
  const offBuyer = Number(BigInt(`0x${h.slice(320, 384)}`));
  const offProvider = Number(BigInt(`0x${h.slice(384, 448)}`));
  return { buyerSig: readBytesAt(h, offBuyer), providerSig: readBytesAt(h, offProvider) };
}
