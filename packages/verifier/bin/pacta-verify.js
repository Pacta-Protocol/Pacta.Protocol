#!/usr/bin/env node
'use strict';
// pacta-verify - verify a Pacta receipt without trusting Pacta.
//
//   pacta-verify receipt.json [--pubkey 0x04…] [--rpc https://…] [--sender 0x…]
//                             [--chain-id 84532] [--json]
//
// receipt.json is either a single receipt { entry, merkle_proof, anchor,
// pacta_sig } or a full proof bundle from GET /api/engagements/:id/proof
// (which carries platform_pubkey and the receipts array).
//
// Exit code 0 = every run check passed; 1 = at least one FAIL.
const fs = require('node:fs');
const { verifyReceipt, checkAnchorOnChain } = require('../lib');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a.startsWith('--')) args[a.slice(2).replace(/-/g, '_')] = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    console.error('usage: pacta-verify <receipt.json> [--pubkey 0x04…] [--rpc url] [--sender 0x…] [--chain-id n] [--json]');
    process.exit(2);
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const receipts = Array.isArray(doc.receipts) ? doc.receipts : [doc];
  const platformPubkey = args.pubkey || doc.platform_pubkey || null;
  const chainId = Number(args.chain_id || (doc.eip712_domain && doc.eip712_domain.chain_id) || 84532);

  let allPass = true;
  const results = [];
  for (const receipt of receipts) {
    const result = verifyReceipt(receipt, { platformPubkey, chainId });
    result.checks.push(await checkAnchorOnChain(receipt.anchor, {
      rpcUrl: args.rpc, senderAddress: args.sender,
    }));
    result.pass = result.checks.every((c) => c.status !== 'FAIL');
    allPass = allPass && result.pass;
    results.push({ seq: receipt.entry && receipt.entry.seq, type: receipt.entry && receipt.entry.type, ...result });
  }

  if (args.json) {
    console.log(JSON.stringify({ pass: allPass, receipts: results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`\nreceipt seq=${r.seq} (${r.type})`);
      for (const c of r.checks) {
        const mark = c.status === 'PASS' ? '✔' : c.status === 'FAIL' ? '✘' : '−';
        console.log(`  ${mark} ${c.status.padEnd(4)} ${c.name.padEnd(16)} ${c.detail}`);
      }
    }
    console.log(`\n${allPass ? 'PASS' : 'FAIL'}: ${results.length} receipt(s) checked`);
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(`pacta-verify: ${err.message}`);
  process.exit(2);
});
