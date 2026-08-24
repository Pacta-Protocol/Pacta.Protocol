#!/usr/bin/env node
'use strict';
// Chain-neutrality guard (Base Readiness Spec, "P1 · Ledger-neutral settlement":
// "No file under the core protocol package imports viem, ethers, or any wallet or
// RPC library").
//
// The core protocol must run with the ledger backend and zero chain dependencies:
// no wallet, no RPC, no network to any chain. This script fails if any core file
// imports a blockchain client, wallet, or RPC library. It is deliberately blunt —
// a match is a build break, not a warning — because the whole neutrality claim
// rests on it staying true.
//
// Scope: the core runtime only (src/, mcp/, server*.js). Onchain adapters live in
// their own packages (e.g. Pacta.Settlement.Base) and are expected to import chain
// libraries; they are not core and are not scanned here.
//
// Note: @noble/curves and @noble/hashes are NOT chain dependencies. Pacta uses
// them for its own EIP-712 signatures and Merkle/hash-chaining (Phase 0) with no
// wallet or RPC involved, so they are allowed.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Files that make up the core protocol runtime.
const CORE_DIRS = ['src', 'mcp'];
const CORE_FILES = ['server.js', 'server-pacta.js'];

// Bare module specifiers that mean "this file talks to a chain, a wallet, or an
// RPC node". Matched against the package portion of a require()/import specifier.
const FORBIDDEN = [
  /^viem(\/|$)/,
  /^ethers(\/|$)/,
  /^@ethersproject\//,
  /^web3(\/|$|-|\.js)/,
  /^@web3-react\//,
  /^wagmi(\/|$)/, /^@wagmi\//,
  /^@walletconnect\//,
  /^@coinbase\/wallet/,
  /^@metamask\//,
  /^@rainbow-me\//,
  /^@safe-global\//,
  /^alchemy-sdk(\/|$)/, /^@alch(\/|emy\/)/,
  /^@ethereumjs\//, /^ethereumjs-/,
  /^@nomicfoundation\//, /^hardhat(\/|$)/, /^ganache(\/|$)/, /^truffle(\/|$)/,
  /^@openzeppelin\//,
  /^ox(\/|$)/,
  /^@base-org\//,
];

// Explicitly-allowed packages that could otherwise look crypto-ish.
const ALLOWED = [/^@noble\/curves/, /^@noble\/hashes/];

function specifiersIn(source) {
  const specs = [];
  const re = /(?:require\(\s*|import\s+[^'"]*from\s*|import\s*\(\s*|export\s+[^'"]*from\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function listFiles() {
  const files = [];
  for (const dir of CORE_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of walk(abs)) files.push(entry);
  }
  for (const f of CORE_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) files.push(abs);
  }
  return files;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) { yield* walk(abs); continue; }
    if (/\.(js|mjs|cjs)$/.test(entry.name)) yield abs;
  }
}

// Returns [{ file, line, specifier }] for every forbidden import in the core.
function scan() {
  const violations = [];
  for (const file of listFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const re = /(?:require\(\s*|import\s+[^'"]*from\s*|import\s*\(\s*|export\s+[^'"]*from\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (ALLOWED.some((a) => a.test(spec))) continue;
      if (FORBIDDEN.some((f) => f.test(spec))) {
        violations.push({ file: path.relative(ROOT, file), line: lineOf(source, m.index), specifier: spec });
      }
    }
  }
  return violations;
}

function main() {
  const violations = scan();
  if (violations.length === 0) {
    console.log('neutrality: OK — no core file imports a chain, wallet, or RPC library.');
    process.exit(0);
  }
  console.error('neutrality: FAIL — core files import chain/wallet/RPC libraries:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  imports '${v.specifier}'`);
  }
  console.error('\nThe core protocol must run on the ledger backend with zero chain dependencies.');
  console.error('Move chain-specific code into a settlement adapter package (e.g. Pacta.Settlement.Base).');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { scan, specifiersIn, FORBIDDEN, ALLOWED, listFiles };
