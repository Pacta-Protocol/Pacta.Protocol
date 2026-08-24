#!/usr/bin/env node
'use strict';
// Prepare (and optionally broadcast) the EscrowVault deployment, in the same
// raw-RPC style as scripts/deploy-anchor-registry.js — RLP + secp256k1, no
// ethers/viem. DRY-RUN BY DEFAULT: it prints the constructor args, the creation
// calldata size, and the CREATE address it will take, but sends nothing unless
// you pass --broadcast. There is intentionally no funded wallet in this repo
// (see .primos/blockers-wp3.md); a human runs this once a Base Sepolia EOA is
// funded.
//
// Config (env):
//   VAULT_CHAIN_ID        84532 (Base Sepolia, default) | 8453 (Base mainnet)
//   VAULT_RPC_URL         e.g. https://sepolia.base.org
//   VAULT_SIGNER_KEY      0x… deployer EOA private key (also becomes guardian
//                         unless VAULT_GUARDIAN is set)
//   VAULT_USDC_ADDRESS    defaults to Circle USDC for the chain
//   VAULT_GUARDIAN        guardian address (default: deployer)
//   VAULT_TVL_CAP         TVL cap in USDC base units (default 10_000_000000 = 10k USDC)
//
//   node packages/settlement-base/scripts/deploy.js            # dry run
//   node packages/settlement-base/scripts/deploy.js --broadcast
const fs = require('node:fs');
const path = require('node:path');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const abi = require('../abi');
const { JsonRpc, signLegacyTx, rlpEncode, qty, toBytes, toHex } = require('../rpc');
const vault = require('../eip712-vault');

const ROOT = path.join(__dirname, '..', '..', '..');
const BUILD = path.join(__dirname, '..', 'build');
const USDC = require('../index').USDC;

function computeCreateAddress(sender, nonce) {
  const encoded = rlpEncode([toBytes(sender), qty(nonce)]);
  return `0x${Buffer.from(keccak_256(encoded)).toString('hex').slice(-40)}`;
}

async function main() {
  const broadcast = process.argv.includes('--broadcast');
  const env = process.env;
  const chainId = Number(env.VAULT_CHAIN_ID || 84532);
  const rpcUrl = env.VAULT_RPC_URL || (chainId === 84532 ? 'https://sepolia.base.org' : null);
  const usdc = env.VAULT_USDC_ADDRESS || USDC[chainId];
  const tvlCap = BigInt(env.VAULT_TVL_CAP || 10_000_000000n); // 10k USDC
  const signerKey = env.VAULT_SIGNER_KEY || null;
  const deployer = signerKey ? vault.addressOf(signerKey) : null;
  const guardian = env.VAULT_GUARDIAN || deployer;

  const bytecodePath = path.join(BUILD, 'EscrowVault.bytecode.txt');
  if (!fs.existsSync(bytecodePath)) {
    console.error('No compiled bytecode. Run: node packages/settlement-base/scripts/compile.js');
    process.exit(1);
  }
  const bytecode = fs.readFileSync(bytecodePath, 'utf8').trim();
  if (!usdc) { console.error(`No USDC address for chain ${chainId}; set VAULT_USDC_ADDRESS.`); process.exit(1); }
  if (broadcast && !guardian) { console.error('Broadcast needs a guardian; set VAULT_GUARDIAN or VAULT_SIGNER_KEY.'); process.exit(1); }

  // For a dry run without a signer, show the plan with a placeholder guardian.
  const guardianForArgs = guardian || '0x0000000000000000000000000000000000000000';
  // creation data = bytecode || abi.encode(constructor args)
  const args = abi.encodeParameters(['address', 'address', 'uint256'], [usdc, guardianForArgs, tvlCap]);
  const data = bytecode + args.slice(2);

  console.log('EscrowVault deployment');
  console.log(`  chainId:        ${chainId} ${chainId === 84532 ? '(Base Sepolia)' : chainId === 8453 ? '(Base mainnet)' : ''}`);
  console.log(`  rpcUrl:         ${rpcUrl || '(unset)'}`);
  console.log(`  USDC:           ${usdc}`);
  console.log(`  guardian:       ${guardian || '(unset)'}`);
  console.log(`  tvlCap:         ${tvlCap} base units (${Number(tvlCap) / 1e6} USDC)`);
  console.log(`  deployer:       ${deployer || '(no VAULT_SIGNER_KEY)'}`);
  console.log(`  creation bytes: ${data.length / 2 - 1}`);

  if (!broadcast) {
    console.log('\nDRY RUN — nothing sent. Re-run with --broadcast (needs VAULT_SIGNER_KEY + a funded EOA).');
    console.log('After deploy, verify on Basescan with the Standard JSON input:');
    console.log(`  ${path.relative(ROOT, path.join(BUILD, 'EscrowVault.standard-input.json'))}`);
    console.log('  compiler: v0.8.24+commit.e11b9ed9, optimizer on (200 runs), evmVersion cancun');
    console.log('  constructor args (ABI-encoded, no 0x):');
    console.log(`  ${args.slice(2)}`);
    return;
  }

  if (!signerKey || !rpcUrl) { console.error('Broadcast needs VAULT_SIGNER_KEY and VAULT_RPC_URL.'); process.exit(1); }
  const rpc = new JsonRpc({ rpcUrl });
  const onChainId = Number(await rpc.call('eth_chainId', []));
  if (onChainId !== chainId) { console.error(`RPC chainId ${onChainId} ≠ configured ${chainId}`); process.exit(1); }
  const nonce = Number(await rpc.call('eth_getTransactionCount', [deployer, 'pending']));
  const gasPrice = BigInt(await rpc.call('eth_gasPrice', []));
  const predicted = computeCreateAddress(deployer, nonce);
  const raw = signLegacyTx({ nonce, gasPrice, gas: 1_500_000, to: '0x', value: 0, data, chainId, signerKey });
  const txHash = await rpc.call('eth_sendRawTransaction', [raw]);
  console.log(`\nsent creation tx ${txHash} (predicted address ${predicted}); waiting…`);
  for (let i = 0; i < 60; i++) {
    const receipt = await rpc.call('eth_getTransactionReceipt', [txHash]);
    if (receipt) {
      if (receipt.status !== '0x1') { console.error('deployment reverted'); process.exit(1); }
      console.log(`DEPLOYED at ${receipt.contractAddress} (block ${Number(receipt.blockNumber)})`);
      console.log(`Set VAULT_CONTRACT_ADDRESS=${receipt.contractAddress}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error('not mined after 120s');
  process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { computeCreateAddress };
