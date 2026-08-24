'use strict';
const { createApp } = require('./src/app');

// 3210 by default: the usual dev ports (3000, 5173, 8080) are frequently occupied
// by leftover dev servers, which makes "clone and run" flaky. Override with PORT.
const PORT = Number(process.env.PORT || 3210);
const { app, db, seeded } = createApp();

// Base Readiness (ADR-002): anchor event-log Merkle roots once per 12h window.
// ANCHOR_AUTOSTART=0 disables (e.g. when running a standalone worker).
const { createAnchorWorker } = require('./src/anchor');
const anchorWorker = process.env.ANCHOR_AUTOSTART === '0' ? null : createAnchorWorker(db, {});
if (anchorWorker) anchorWorker.start();

const server = app.listen(PORT, () => {
  console.log(`Pacta (Agent Services Marketplace) POC running at http://localhost:${PORT}`);
  if (seeded) console.log('Seed data loaded (fresh database).');
  if (anchorWorker) console.log(`Anchor worker on (adapter: ${anchorWorker.adapter.name}).`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start on another port with: PORT=4000 npm start`);
    process.exit(1);
  }
  throw err;
});
