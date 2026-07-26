'use strict';
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { seedIfEmpty } = require('./seed');
const { createApiRouter } = require('./api');
const { createRegistryAdapter } = require('./registry');

function createApp({ dbPath, pacta, registry, hardening } = {}) {
  const isPacta = pacta ?? process.env.PACTA === '1';
  const db = openDb(dbPath);
  const seeded = seedIfEmpty(db, { pacta: isPacta });
  const registryAdapter = registry || createRegistryAdapter(db);

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApiRouter(db, { pacta: isPacta, registry: registryAdapter, hardening }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return { app, db, seeded, pacta: isPacta, registry: registryAdapter };
}

module.exports = { createApp };
