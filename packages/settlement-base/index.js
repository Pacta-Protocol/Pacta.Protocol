'use strict';
// @pacta/settlement-base — the reference on-chain SettlementBackend for Pacta:
// a USDC EscrowVault on Base (contracts/EscrowVault.sol). It satisfies the exact
// interface the core defines in src/settlement.js (id, currency, openEscrow,
// fund, release, refund, split, escrowBalance, stakeBalance, stake, slash) and
// returns the same uniform receipt, with the optional `onchain` block populated
// (tx hash, chain id, block number).
//
// The core NEVER imports this package. It registers itself through the core's
// registerSettlementBackend() extension point, wired from server-pacta.js only
// when SETTLEMENT_BACKEND=base-escrow-vault (see README, "How it registers").
//
// This adapter is inherently async (JSON-RPC over fetch). The ledger backend is
// synchronous because SQLite is; wiring THIS backend into the core's
// synchronous withTx() settlement flow is the documented integration step (see
// README, "Live integration" and .primos/blockers-wp3.md). Everything here is
// unit-tested against a mock JSON-RPC with no network.
const { keccak_256 } = require('@noble/hashes/sha3.js');
const abi = require('./abi');
const vault = require('./eip712-vault');
const { JsonRpc, signLegacyTx, toHex, strip0x } = require('./rpc');

// Circle's official USDC. Base Sepolia is the demo default; Base mainnet is the
// documented production value. Overridable via VAULT_USDC_ADDRESS.
const USDC = {
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia (Circle)
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet (Circle)
};

const eventTopic = (sig) => toHex(keccak_256(Buffer.from(sig, 'utf8')));
const SETTLED_TOPIC = eventTopic('Settled(bytes32,uint8,uint256,uint256)');
const SLASHED_TOPIC = eventTopic('Slashed(bytes32,address,address,uint256)');
const FUNDED_TOPIC = eventTopic('Funded(bytes32,address,uint256,uint256)');

class BaseVaultError extends Error {}

// Amounts cross the interface as bigint base units (USDC has 6 decimals). No
// floats, ever — same rule as the ledger.
function toBase(amount, label = 'amount') {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount === 'number') {
    if (!Number.isInteger(amount)) throw new BaseVaultError(`${label} must be an integer number of base units (no floats)`);
    return BigInt(amount);
  }
  throw new BaseVaultError(`${label} must be a bigint or integer`);
}

// The EVM address for a party. For the vault, a PartyRef carries its on-chain
// address (bound in the agreement's settlement block). Resolving PartyRef→address
// from the key registry is part of the live integration; here it must be present.
function addressOfParty(ref, label) {
  if (ref && typeof ref.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(ref.address)) return ref.address;
  throw new BaseVaultError(`${label} needs an on-chain address (PartyRef.address); the vault is keyed by addresses bound in the agreement`);
}

function requireHash(h) {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(h)) {
    throw new BaseVaultError(`the vault is keyed by agreement_hash (bytes32); got ${JSON.stringify(h)}`);
  }
  return h.toLowerCase();
}

class BaseEscrowVaultBackend {
  constructor(opts = {}) {
    this.id = 'base-escrow-vault';
    this.currency = 'USDC';
    this.chainId = Number(opts.chainId || 84532);
    this.contract = opts.contract;
    this.usdc = opts.usdc || USDC[this.chainId];
    this.signerKey = opts.signerKey || null; // relayer EOA that sends txs and pays gas
    this.gas = Number(opts.gas || 250_000);
    this.confirmations = Number(opts.confirmations ?? 1);
    this.pollMs = Number(opts.pollMs || 2000);
    this.pollTries = Number(opts.pollTries || 30);
    if (!this.contract || !/^0x[0-9a-fA-F]{40}$/.test(this.contract)) {
      throw new BaseVaultError('vault contract address is required (VAULT_CONTRACT_ADDRESS)');
    }
    if (!this.usdc) throw new BaseVaultError(`no USDC address for chain ${this.chainId} (set VAULT_USDC_ADDRESS)`);
    this.rpc = new JsonRpc({ rpcUrl: opts.rpcUrl, transport: opts.transport });
    this._domain = { chainId: this.chainId, verifyingContract: this.contract };
  }

  // ---- interface: open ------------------------------------------------------
  // The handle carries the agreement_hash (the vault key) and the bound EVM
  // addresses. amountMinor is the engagement price, stored on-chain at open as
  // the slashing base.
  openEscrow({ engagementId, buyer, provider, amountMinor, arbiter } = {}) {
    const agreementHash = requireHash(engagementId);
    return {
      agreementHash,
      buyer,
      provider,
      addresses: {
        buyer: addressOfParty(buyer, 'buyer'),
        provider: addressOfParty(provider, 'provider'),
        arbiter: arbiter && arbiter.address ? arbiter.address : (buyer.arbiter || '0x0000000000000000000000000000000000000000'),
      },
      amountMinor: amountMinor == null ? null : toBase(amountMinor, 'amountMinor'),
    };
  }

  // Bind the address set on-chain. `authorization.openSig` is the buyer's EIP-712
  // OpenEngagement signature; a custodial buyer's is produced platform-side, a
  // self-custody buyer supplies it (same rule as /agree).
  async open(handle, authorization = {}, ctx = {}) {
    const { agreementHash, addresses, amountMinor } = handle;
    const digest = vault.openDigest({
      agreementHash, buyer: addresses.buyer, provider: addresses.provider, arbiter: addresses.arbiter,
      token: this.usdc, amount: amountMinor, ...this._domain,
    });
    // BOTH parties sign the OpenEngagement address set (the contract verifies
    // both). Custodial parties are signed for platform-side (ctx.buyerKey /
    // ctx.providerKey); self-custody parties supply authorization.openSigs.
    const openSigs = Array.isArray(authorization.openSigs) ? authorization.openSigs : null;
    const buyerSig = (openSigs && openSigs[0]) || (ctx.buyerKey ? vault.signDigest(digest, ctx.buyerKey) : null);
    const providerSig = (openSigs && openSigs[1]) || (ctx.providerKey ? vault.signDigest(digest, ctx.providerKey) : null);
    if (!buyerSig || !providerSig) {
      throw new BaseVaultError('open needs the buyer AND provider OpenEngagement signatures (authorization.openSigs or ctx.buyerKey+providerKey)');
    }
    const data = abi.encodeCall(
      'openEngagement(bytes32,address,address,address,uint256,bytes,bytes)',
      ['bytes32', 'address', 'address', 'address', 'uint256', 'bytes', 'bytes'],
      [agreementHash, addresses.buyer, addresses.provider, addresses.arbiter, amountMinor, buyerSig, providerSig],
    );
    const onchain = await this.#send(data, ctx);
    return this.#receipt('open', { engagementId: agreementHash, amountMinor, onchain });
  }

  // ---- interface: fund ------------------------------------------------------
  async fund(handle, amountMinor, ctx = {}) {
    const amount = toBase(amountMinor, 'fund amount');
    const agreementHash = requireHash(handle.agreementHash);
    if (amount === 0n) return this.#receipt('fund', { engagementId: agreementHash, amountMinor: 0n, onchain: null });
    const data = abi.encodeCall('fund(bytes32,uint256)', ['bytes32', 'uint256'], [agreementHash, amount]);
    // The funder (buyer) must have approved the vault for USDC beforehand; the
    // tx is sent from ctx.funderKey (the buyer's key) or the relayer.
    const onchain = await this.#send(data, { ...ctx, signerKey: ctx.funderKey || ctx.signerKey });
    return this.#receipt('fund', {
      engagementId: agreementHash, amountMinor: amount,
      movements: [{ from: handle.buyer, to: { kind: 'escrow', id: agreementHash }, amount_minor: amount }],
      onchain,
    });
  }

  // ---- interface: release / refund / split ----------------------------------
  async release(handle, authorization = {}, ctx = {}) {
    const funded = await this.escrowBalance(handle);
    return this.#settle(handle, vault.OUTCOME.release, 0n, funded, authorization, ctx, 'release');
  }

  async refund(handle, authorization = {}, ctx = {}) {
    const funded = await this.escrowBalance(handle);
    return this.#settle(handle, vault.OUTCOME.refund, funded, 0n, authorization, ctx, 'refund');
  }

  async split(handle, buyerMinor, providerMinor, authorization = {}, ctx = {}) {
    const b = toBase(buyerMinor, 'buyer split');
    const p = toBase(providerMinor, 'provider split');
    return this.#settle(handle, vault.OUTCOME.split, b, p, authorization, ctx, 'split');
  }

  // ---- interface: collateral ------------------------------------------------
  async stakeBalance(provider) {
    const addr = addressOfParty(provider, 'provider');
    const data = abi.encodeCall('collateralOf(address)', ['address'], [addr]);
    const out = await this.rpc.call('eth_call', [{ to: this.contract, data }, 'latest']);
    return abi.decodeUint(out);
  }

  async stake(provider, amountMinor, ctx = {}) {
    const amount = toBase(amountMinor, 'stake amount');
    if (amount <= 0n) throw new BaseVaultError('stake amount must be a positive integer');
    const addr = addressOfParty(provider, 'provider');
    const data = abi.encodeCall('depositCollateral(address,uint256)', ['address', 'uint256'], [addr, amount]);
    const onchain = await this.#send(data, { ...ctx, signerKey: ctx.funderKey || ctx.signerKey });
    return this.#receipt('stake', {
      amountMinor: amount,
      movements: [{ from: null, to: { kind: 'stake', id: addr }, amount_minor: amount }],
      onchain,
    });
  }

  // Slash provider collateral to the buyer. The contract decides the amount from
  // the engagement price and the ruling (SLASH_REFUND_PCT / SLASH_SPLIT_PCT),
  // capped at the free balance; `amountMinor` from the caller is advisory. The
  // receipt reports the amount actually taken, read from the Slashed event.
  async slash(provider, amountMinor, authorization = {}, ctx = {}) {
    const agreementHash = requireHash(ctx.agreementHash || (authorization && authorization.agreementHash));
    const outcome = typeof ctx.outcome === 'number' ? ctx.outcome : vault.OUTCOME[ctx.outcome];
    if (!outcome) throw new BaseVaultError("slash needs the ruling outcome (ctx.outcome: 'refund'|'split')");
    const digest = vaultSlashDigest(agreementHash, outcome, this._domain);
    const [sigA, sigB] = this.#slashSignatures(authorization, ctx, digest);
    const data = abi.encodeCall(
      'slashCollateral(bytes32,uint8,bytes,bytes)',
      ['bytes32', 'uint8', 'bytes', 'bytes'],
      [agreementHash, outcome, sigA, sigB],
    );
    const onchain = await this.#send(data, ctx);
    const taken = this.#eventUint(onchain, SLASHED_TOPIC, 0) ?? 0n;
    const beneficiary = (ctx.beneficiary && ctx.beneficiary.address) ? ctx.beneficiary : null;
    return this.#receipt('slash', {
      engagementId: agreementHash,
      amountMinor: taken,
      movements: taken > 0n
        ? [{ from: { kind: 'stake', id: addressOfParty(provider, 'provider') }, to: beneficiary, amount_minor: taken }]
        : [],
      onchain,
    });
  }

  // ---- interface extension: escrowBalance (bigint) --------------------------
  // Added to the interface so the core reads the held escrow through the backend
  // instead of the ledger's SQL. On the vault it is an eth_call to the contract.
  async escrowBalance(handle) {
    const agreementHash = requireHash(handle.agreementHash);
    const data = abi.encodeCall('escrowBalance(bytes32)', ['bytes32'], [agreementHash]);
    const out = await this.rpc.call('eth_call', [{ to: this.contract, data }, 'latest']);
    return abi.decodeUint(out);
  }

  // ---- internals ------------------------------------------------------------
  async #settle(handle, outcome, buyerAmount, providerAmount, authorization, ctx, operation) {
    const agreementHash = requireHash(handle.agreementHash);
    const digest = vault.settlementDigest({
      agreementHash, outcome, buyerAmount, providerAmount, ...this._domain,
    });
    const [sigA, sigB] = this.#settleSignatures(authorization, ctx, digest);
    const data = abi.encodeCall(
      'settle(bytes32,uint8,uint256,uint256,bytes,bytes)',
      ['bytes32', 'uint8', 'uint256', 'uint256', 'bytes', 'bytes'],
      [agreementHash, outcome, buyerAmount, providerAmount, sigA, sigB],
    );
    const onchain = await this.#send(data, ctx);
    const movements = [];
    if (buyerAmount > 0n) movements.push({ from: { kind: 'escrow', id: agreementHash }, to: handle.buyer, amount_minor: buyerAmount });
    if (providerAmount > 0n) movements.push({ from: { kind: 'escrow', id: agreementHash }, to: handle.provider, amount_minor: providerAmount });
    return this.#receipt(operation, {
      engagementId: agreementHash, amountMinor: buyerAmount + providerAmount, movements, onchain,
    });
  }

  // Resolve the two settlement signatures: prefer explicit ones from the
  // authorization; otherwise sign with custodial keys provided in ctx (mutual =
  // buyer+provider; dispute = arbiter alone as sigA).
  #settleSignatures(authorization, ctx, digest) {
    if (authorization && Array.isArray(authorization.settlementSigs)) {
      return [authorization.settlementSigs[0] || '0x', authorization.settlementSigs[1] || '0x'];
    }
    if (ctx.arbiterKey) return [vault.signDigest(digest, ctx.arbiterKey), '0x'];
    if (ctx.buyerKey && ctx.providerKey) {
      return [vault.signDigest(digest, ctx.buyerKey), vault.signDigest(digest, ctx.providerKey)];
    }
    throw new BaseVaultError('settle needs authorization.settlementSigs (both parties or arbiter) or custodial keys in ctx');
  }

  #slashSignatures(authorization, ctx, digest) {
    if (authorization && Array.isArray(authorization.slashSigs)) {
      return [authorization.slashSigs[0] || '0x', authorization.slashSigs[1] || '0x'];
    }
    if (ctx.arbiterKey) return [vault.signDigest(digest, ctx.arbiterKey), '0x'];
    if (ctx.buyerKey && ctx.providerKey) {
      return [vault.signDigest(digest, ctx.buyerKey), vault.signDigest(digest, ctx.providerKey)];
    }
    throw new BaseVaultError('slash needs authorization.slashSigs (both parties or arbiter) or custodial keys in ctx');
  }

  async #send(data, ctx = {}) {
    const signerKey = ctx.signerKey || this.signerKey;
    if (!signerKey) throw new BaseVaultError('no signer key to send the transaction (VAULT_SIGNER_KEY)');
    const from = vault.addressOf(signerKey);
    const nonce = Number(await this.rpc.call('eth_getTransactionCount', [from, 'pending']));
    const gasPrice = BigInt(await this.rpc.call('eth_gasPrice', []));
    const raw = signLegacyTx({
      nonce, gasPrice, gas: this.gas, to: this.contract, value: 0, data, chainId: this.chainId, signerKey,
    });
    const txHash = await this.rpc.call('eth_sendRawTransaction', [raw]);
    for (let i = 0; i < this.pollTries; i++) {
      const receipt = await this.rpc.call('eth_getTransactionReceipt', [txHash]);
      if (receipt) {
        if (receipt.status !== '0x1') throw new BaseVaultError(`tx ${txHash} reverted`);
        return {
          tx_hash: txHash,
          chain_id: this.chainId,
          block_number: receipt.blockNumber != null ? Number(receipt.blockNumber) : null,
          logs: receipt.logs || [],
        };
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    throw new BaseVaultError(`tx ${txHash} not mined after ${(this.pollMs * this.pollTries) / 1000}s`);
  }

  // Read the Nth non-indexed uint256 from a log matching `topic0` in the receipt.
  #eventUint(onchain, topic0, wordIndex) {
    const log = (onchain.logs || []).find((l) => (l.topics || [])[0] === topic0);
    if (!log) return null;
    const dataHex = strip0x(log.data);
    return BigInt(`0x${dataHex.slice(wordIndex * 64, wordIndex * 64 + 64) || '0'}`);
  }

  #receipt(operation, { engagementId = null, amountMinor = 0n, movements = [], onchain = null } = {}) {
    // Strip the transient `logs` from the receipt's onchain block; callers see
    // only the uniform { tx_hash, chain_id, block_number }.
    const onchainOut = onchain
      ? { tx_hash: onchain.tx_hash, chain_id: onchain.chain_id, block_number: onchain.block_number }
      : null;
    return {
      backend: this.id,
      currency: this.currency,
      operation,
      engagement_id: engagementId,
      amount_minor: BigInt(amountMinor),
      movements,
      onchain: onchainOut,
    };
  }
}

// Slash digest helper (kept outside the class so tests can reuse it): EIP-712
// Slash(bytes32 agreementHash,uint8 outcome) under the vault domain.
function vaultSlashDigest(agreementHash, outcome, domain) {
  const { keccak_256: k } = require('@noble/hashes/sha3.js');
  const strip = (h) => (String(h).startsWith('0x') ? String(h).slice(2) : String(h));
  const hex = (b) => `0x${Buffer.from(b).toString('hex')}`;
  const bytes = (h) => Uint8Array.from(Buffer.from(strip(h), 'hex'));
  const kHex = (i) => hex(k(typeof i === 'string' ? Buffer.from(i, 'utf8') : i));
  const word = (h) => strip(h).padStart(64, '0');
  const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
  const SLASH_TYPE = 'Slash(bytes32 agreementHash,uint8 outcome)';
  const structHash = kHex(bytes([word(kHex(SLASH_TYPE)), word(agreementHash), uintWord(outcome)].join('')));
  const ds = vault.domainSeparator(domain);
  return k(bytes(`1901${strip(ds)}${strip(structHash)}`));
}

// ---- registration -----------------------------------------------------------

function backendFromEnv(env = process.env, opts = {}) {
  const chainId = Number(env.VAULT_CHAIN_ID || opts.chainId || 84532);
  return new BaseEscrowVaultBackend({
    chainId,
    rpcUrl: env.VAULT_RPC_URL || opts.rpcUrl,
    contract: env.VAULT_CONTRACT_ADDRESS || opts.contract,
    usdc: env.VAULT_USDC_ADDRESS || opts.usdc,
    signerKey: env.VAULT_SIGNER_KEY || opts.signerKey,
    transport: opts.transport,
  });
}

// Called from server-pacta.js (the only permitted point of contact) when
// SETTLEMENT_BACKEND=base-escrow-vault. The core hands us its
// registerSettlementBackend so this package never has to know the core's path.
function register(registerSettlementBackend) {
  if (typeof registerSettlementBackend !== 'function') {
    throw new BaseVaultError('register(registerSettlementBackend) requires the core registration function');
  }
  registerSettlementBackend('base-escrow-vault', (db, env) => backendFromEnv(env));
  return true;
}

module.exports = {
  BaseEscrowVaultBackend, BaseVaultError, register, backendFromEnv,
  vaultSlashDigest, USDC,
  SETTLED_TOPIC, SLASHED_TOPIC, FUNDED_TOPIC,
};
