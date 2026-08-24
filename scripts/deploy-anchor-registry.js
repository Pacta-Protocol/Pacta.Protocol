'use strict';
// Deploy contracts/AnchorRegistry.sol to Base (or any EVM chain) with the same
// raw EIP-155 signing path the anchoring service uses (src/anchor.js) - no
// web3, no hardhat, no foundry. Compiles with a pinned solc via the Solidity
// standard-JSON interface so the exact input can be re-submitted to Basescan
// for source verification.
//
//   Compile only (safe, no wallet, no funds needed):
//     node scripts/deploy-anchor-registry.js --compile-only
//
//   Deploy (needs a funded EOA on the target chain). Pick the network with
//   DEPLOY_NETWORK (base-sepolia | base-mainnet, default base-mainnet); the
//   public RPC and Basescan explorer are chosen for you, override the RPC with
//   DEPLOY_RPC_URL:
//     DEPLOY_NETWORK=base-sepolia \                            # or base-mainnet
//     DEPLOY_SIGNER_KEY=0x<private key of a funded EOA> \
//     ANCHORER_ADDRESS=0x<address allowed to call anchor()>    # optional; defaults to the signer
//     node scripts/deploy-anchor-registry.js
//
// It writes build/AnchorRegistry.standard-input.json (the exact Basescan input)
// and prints the deployed address, tx hash, and verification instructions.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

const SOLC_VERSION = '0.8.26'; // pinned; must match the Basescan "Compiler" field
const EVM_VERSION = 'cancun'; // Base mainnet & Sepolia support Cancun
const OPTIMIZER_RUNS = 200;

// Target networks. Pick with DEPLOY_NETWORK (or --network); default base-mainnet.
// DEPLOY_RPC_URL overrides the default RPC. The chainId comes ONLY from the
// chosen network - ANCHOR_CHAIN_ID (the runtime anchoring-service env, which may
// legitimately differ) is deliberately ignored here so the deploy target can
// never be mismatched against its network.
const NETWORKS = {
  'base-mainnet': { chainId: 8453, rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
  'base-sepolia': { chainId: 84532, rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' },
};
const DEFAULT_NETWORK = 'base-mainnet';

function resolveNetwork(env, argv) {
  const flagIdx = argv.indexOf('--network');
  const name = (flagIdx >= 0 ? argv[flagIdx + 1] : env.DEPLOY_NETWORK) || DEFAULT_NETWORK;
  const net = NETWORKS[name];
  if (!net) throw new Error(`unknown network "${name}"; use one of: ${Object.keys(NETWORKS).join(', ')}`);
  return {
    name,
    chainId: net.chainId,
    rpcUrl: env.DEPLOY_RPC_URL || net.rpc,
    explorer: net.explorer,
  };
}

const ROOT = path.join(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'contracts', 'AnchorRegistry.sol');
const BUILD_DIR = path.join(ROOT, 'build');
const CONTRACT_FILE = 'AnchorRegistry.sol';
const CONTRACT_NAME = 'AnchorRegistry';

const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const toBytes = (hex) => Uint8Array.from(Buffer.from(strip0x(hex), 'hex'));
const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

// ---- solc standard-JSON --------------------------------------------------------

function standardInput() {
  return {
    language: 'Solidity',
    sources: { [CONTRACT_FILE]: { content: fs.readFileSync(CONTRACT_PATH, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: OPTIMIZER_RUNS },
      evmVersion: EVM_VERSION,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
}

function compile() {
  const input = standardInput();
  // solcjs (from the pinned solc npm package) reads standard JSON on stdin.
  const res = spawnSync('npx', ['--yes', `solc@${SOLC_VERSION}`, '--standard-json'], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`solc invocation failed: ${res.stderr || res.error || 'unknown error'}`);
  }
  // solcjs prints an SMT-solver notice before the JSON; parse from the first '{'.
  const jsonStart = res.stdout.indexOf('{');
  if (jsonStart < 0) throw new Error(`solc produced no JSON output:\n${res.stdout}`);
  const out = JSON.parse(res.stdout.slice(jsonStart));
  const fatal = (out.errors || []).filter((e) => e.severity === 'error');
  if (fatal.length) throw new Error(`compilation errors:\n${fatal.map((e) => e.formattedMessage).join('\n')}`);
  const c = out.contracts[CONTRACT_FILE][CONTRACT_NAME];
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const inputPath = path.join(BUILD_DIR, 'AnchorRegistry.standard-input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, inputPath };
}

// ---- ABI encoding for the constructor arg -------------------------------------

const addressWord = (addr) => strip0x(addr).toLowerCase().padStart(64, '0');

// ---- raw EIP-155 signing (same construction as src/anchor.js) -----------------

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
function qty(n) {
  let hex = BigInt(n).toString(16);
  if (hex === '0') return Buffer.alloc(0);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}
const stripZeros = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return Buffer.from(b.slice(i)); };

function addressOf(privHex) {
  const pub = secp256k1.getPublicKey(toBytes(privHex), false);
  return `0x${Buffer.from(keccak_256(pub.slice(1))).toString('hex').slice(-40)}`;
}

// Contract-creation tx: `to` is empty, `data` is bytecode || constructor args.
function signCreateTx({ nonce, gasPrice, gas, data, chainId, privHex }) {
  const unsigned = [qty(nonce), qty(gasPrice), qty(gas), Buffer.alloc(0), qty(0), toBytes(data),
    qty(chainId), Buffer.alloc(0), Buffer.alloc(0)];
  const digest = keccak_256(rlpEncode(unsigned));
  const sig = secp256k1.sign(digest, toBytes(privHex), { format: 'recovered' });
  const v = BigInt(chainId) * 2n + 35n + BigInt(sig[0]);
  return toHex(rlpEncode([qty(nonce), qty(gasPrice), qty(gas), Buffer.alloc(0), qty(0), toBytes(data),
    qty(v), stripZeros(sig.slice(1, 33)), stripZeros(sig.slice(33, 65))]));
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`rpc ${method} → ${data.error.message}`);
  return data.result;
}

async function main() {
  const compileOnly = process.argv.includes('--compile-only');
  console.log(`Compiling ${CONTRACT_FILE} with solc ${SOLC_VERSION} (evmVersion ${EVM_VERSION}, optimizer ${OPTIMIZER_RUNS} runs)...`);
  const { bytecode, inputPath } = compile();
  console.log(`  bytecode: ${bytecode.length / 2 - 1} bytes`);
  console.log(`  Basescan standard-JSON input written to: ${inputPath}`);

  const env = process.env;
  const network = resolveNetwork(env, process.argv);
  const { chainId, rpcUrl, explorer } = network;
  const signerKey = env.DEPLOY_SIGNER_KEY;
  console.log(`\nTarget network: ${network.name} (chainId ${chainId}, rpc ${rpcUrl})`);

  if (compileOnly || !signerKey) {
    if (!compileOnly) console.log('\nNo DEPLOY_SIGNER_KEY set — stopping after compile.');
    const anchorer = env.ANCHORER_ADDRESS || (signerKey ? addressOf(signerKey) : '0x<anchorer>');
    console.log('\nTo deploy to Base Sepolia (testnet):');
    console.log('  DEPLOY_NETWORK=base-sepolia \\');
    console.log('  DEPLOY_SIGNER_KEY=0x<funded private key> \\');
    console.log(`  ANCHORER_ADDRESS=${anchorer} \\`);
    console.log('  node scripts/deploy-anchor-registry.js');
    console.log('\nTo deploy to Base mainnet:');
    console.log('  DEPLOY_NETWORK=base-mainnet \\');
    console.log('  DEPLOY_SIGNER_KEY=0x<funded private key> \\');
    console.log(`  ANCHORER_ADDRESS=${anchorer} \\`);
    console.log('  node scripts/deploy-anchor-registry.js');
    return;
  }

  const signer = addressOf(signerKey);
  const anchorer = env.ANCHORER_ADDRESS || signer;
  const data = bytecode + addressWord(anchorer);
  console.log(`Deploying from ${signer}; anchorer = ${anchorer}`);

  const onChainId = Number(await rpc(rpcUrl, 'eth_chainId'));
  if (onChainId !== chainId) throw new Error(`chain id mismatch: RPC says ${onChainId}, config says ${chainId}`);
  const nonce = Number(await rpc(rpcUrl, 'eth_getTransactionCount', [signer, 'pending']));
  const gasPrice = BigInt(await rpc(rpcUrl, 'eth_gasPrice'));
  const gas = BigInt(await rpc(rpcUrl, 'eth_estimateGas', [{ from: signer, data }]));
  if (env.DUMP_INITCODE) { console.log(`INITCODE=${data}`); return; }
  const raw = signCreateTx({ nonce, gasPrice, gas: (gas * 12n) / 10n, data, chainId, privHex: signerKey });
  const txHash = await rpc(rpcUrl, 'eth_sendRawTransaction', [raw]);
  console.log(`  tx: ${txHash}  (waiting for receipt...)`);

  let receipt = null;
  for (let i = 0; i < 60 && !receipt; i++) {
    receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash]);
    if (!receipt) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!receipt) throw new Error(`deploy tx ${txHash} not mined after 120s`);
  if (receipt.status !== '0x1') throw new Error(`deploy tx ${txHash} reverted`);

  console.log('\n==================== DEPLOYED ====================');
  console.log(`  network:        ${network.name} (chainId ${chainId})`);
  console.log(`  AnchorRegistry: ${receipt.contractAddress}`);
  console.log(`  anchorer:       ${anchorer}`);
  console.log(`  tx hash:        ${txHash}`);
  console.log(`  block:          ${Number(receipt.blockNumber)}`);
  console.log(`  explorer:       ${explorer}/address/${receipt.contractAddress}`);
  console.log(`\nVerify the source on ${explorer} (Contract → Verify & Publish):`);
  console.log('  - Compiler type:    Solidity (Standard-Json-Input)');
  console.log(`  - Compiler version: v${SOLC_VERSION}`);
  console.log('  - License:          MIT (3)');
  console.log(`  - Upload:           ${inputPath}`);
  console.log(`  - Constructor arg (ABI-encoded): ${addressWord(anchorer)}`);
  console.log('\nThen set ANCHOR_CONTRACT_ADDRESS to the address above and run the anchoring service.');
}

main().catch((err) => { console.error(`deploy failed: ${err.message}`); process.exit(1); });
