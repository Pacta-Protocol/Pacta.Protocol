#!/usr/bin/env node
'use strict';
// Compile contracts/EscrowVault.sol with a pinned solc and emit the ABI +
// bytecode + the exact Standard JSON input used (which is also what Basescan
// wants for source verification). Pinned to 0.8.24 to match the pragma and to
// keep the bytecode reproducible.
//
//   npm --prefix packages/settlement-base install   # once, to get solc 0.8.24
//   node packages/settlement-base/scripts/compile.js
//
// Writes packages/settlement-base/build/{EscrowVault.abi.json,
// EscrowVault.bytecode.txt, EscrowVault.standard-input.json,
// EscrowVault.solc-output.json}. If solc is not installed it prints the exact
// install command and exits non-zero (tracked in .primos/blockers-wp3.md).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'contracts', 'EscrowVault.sol');
const OUT = path.join(__dirname, '..', 'build');
const PINNED = '0.8.24';

function loadSolc() {
  try {
    return require('solc');
  } catch {
    console.error('solc is not installed. Install the pinned compiler with:');
    console.error('  npm --prefix packages/settlement-base install');
    console.error('(package.json pins solc 0.8.24 as a devDependency.)');
    process.exit(1);
  }
}

function main() {
  const solc = loadSolc();
  const version = solc.version();
  if (!version.startsWith(`${PINNED}+`)) {
    console.error(`solc version mismatch: expected ${PINNED}, got ${version}. Fix the devDependency pin.`);
    process.exit(1);
  }
  const source = fs.readFileSync(SRC, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'EscrowVault.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    console.error('compilation FAILED:');
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }
  const warnings = (output.errors || []).filter((e) => e.severity === 'warning');
  for (const w of warnings) console.warn(w.formattedMessage);

  const contract = output.contracts['EscrowVault.sol'].EscrowVault;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'EscrowVault.abi.json'), `${JSON.stringify(contract.abi, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'EscrowVault.bytecode.txt'), `0x${contract.evm.bytecode.object}\n`);
  fs.writeFileSync(path.join(OUT, 'EscrowVault.standard-input.json'), `${JSON.stringify(input, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'EscrowVault.solc-output.json'), `${JSON.stringify(output, null, 2)}\n`);

  const size = contract.evm.deployedBytecode.object.length / 2;
  console.log(`compiled EscrowVault with solc ${version}`);
  console.log(`  ABI entries:        ${contract.abi.length}`);
  console.log(`  deployed size:      ${size} bytes (EIP-170 limit 24576)`);
  console.log(`  build written to:   ${path.relative(ROOT, OUT)}/`);
  if (size > 24576) {
    console.error('  deployed bytecode exceeds the 24576-byte limit');
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { main };
