'use strict';
// Pacta entry point: same codebase, feature-flagged variant with staking-based
// vetting, registry-verified proofs and the agent manifest. Runs side by side with
// Plan A (port 3210) on its own port and database.
process.env.PACTA = '1';
const path = require('node:path');
const { createApp } = require('./src/app');

// Ledger-neutral settlement (Base Readiness Spec, "P1 · Ledger-neutral
// settlement"). The core ships one backend: the internal ledger. The reference
// onchain backend (a USDC EscrowVault on Base) lives in its own package and is
// NOT imported by the core. This is the single permitted point of contact:
// only when SETTLEMENT_BACKEND=base-escrow-vault do we load the package and hand
// it the core's registration function. If the package is missing, fail loudly
// rather than silently falling back to the ledger.
if ((process.env.SETTLEMENT_BACKEND || '').trim().toLowerCase() === 'base-escrow-vault') {
  try {
    const { registerSettlementBackend } = require('./src/settlement');
    require('./packages/settlement-base').register(registerSettlementBackend);
    console.log('[PACTA] Settlement backend: base-escrow-vault (USDC EscrowVault on Base).');
  } catch (err) {
    console.error('[PACTA] SETTLEMENT_BACKEND=base-escrow-vault but @pacta/settlement-base could not be loaded:');
    console.error(`        ${err.message}`);
    console.error('        Install/build the package, or unset SETTLEMENT_BACKEND to use the ledger.');
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3220);
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'pacta.db');
const { app, db, seeded, registry, hooks } = createApp({ dbPath, pacta: true });

// Base Readiness (ADR-002): anchor event-log Merkle roots once per 12h window.
// ANCHOR_AUTOSTART=0 disables (e.g. when running a standalone worker).
const { createAnchorWorker } = require('./src/anchor');
const anchorWorker = process.env.ANCHOR_AUTOSTART === '0' ? null : createAnchorWorker(db, {});
if (anchorWorker) {
  anchorWorker.start();
  // Anchor immediately when an engagement closes (default on; ANCHOR_ON_COMPLETE=0
  // to keep only the 12h schedule). Makes the app anchor a proof right away.
  if (process.env.ANCHOR_ON_COMPLETE !== '0') hooks.afterComplete = () => anchorWorker.anchorNow();
}

const server = app.listen(PORT, () => {
  console.log(`[PACTA] Agent Services Marketplace running at http://localhost:${PORT}`);
  console.log(`[PACTA] Registry adapter: ${registry.name}`);
  if (anchorWorker) console.log(`[PACTA] Anchor worker on (adapter: ${anchorWorker.adapter.name}).`);
  if (seeded) console.log('[PACTA] Seed data loaded (stakes, public registry, unvetted SMB demo).');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start on another port with: PORT=4001 npm run start:pacta`);
    process.exit(1);
  }
  throw err;
});
