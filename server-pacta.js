'use strict';
// Pacta entry point: same codebase, feature-flagged variant with staking-based
// vetting, registry-verified proofs and the agent manifest. Runs side by side with
// Plan A (port 3210) on its own port and database.
process.env.PACTA = '1';
const path = require('node:path');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 3220);
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'pacta.db');
const { app, db, seeded, registry } = createApp({ dbPath, pacta: true });

// Phase 0 (ADR-001): anchor event-log Merkle roots on a hybrid cadence.
// ANCHOR_AUTOSTART=0 disables (e.g. when running a standalone worker).
const { createAnchorWorker } = require('./src/anchor');
const anchorWorker = process.env.ANCHOR_AUTOSTART === '0' ? null : createAnchorWorker(db, {});
if (anchorWorker) anchorWorker.start();

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
