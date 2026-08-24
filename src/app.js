'use strict';
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { seedIfEmpty } = require('./seed');
const { createApiRouter } = require('./api');
const { createRegistryAdapter } = require('./registry');
const { createSettlementBackend } = require('./settlement');

function createApp({ dbPath, pacta, registry, settlement, hardening } = {}) {
  const isPacta = pacta ?? process.env.PACTA === '1';
  const db = openDb(dbPath);
  const seeded = seedIfEmpty(db, { pacta: isPacta });
  const registryAdapter = registry || createRegistryAdapter(db);
  // Escrow, collateral and slashing route through this backend; "ledger" (the
  // internal double-entry ledger) is the default. SETTLEMENT_BACKEND selects it.
  const settlementBackend = settlement || createSettlementBackend(db);

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApiRouter(db, {
    pacta: isPacta, registry: registryAdapter, settlement: settlementBackend, hardening,
  }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return { app, db, seeded, pacta: isPacta, registry: registryAdapter, settlement: settlementBackend };
}

module.exports = { createApp };
