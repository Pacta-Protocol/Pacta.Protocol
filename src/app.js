'use strict';
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { seedIfEmpty } = require('./seed');
const { createApiRouter } = require('./api');

function createApp({ dbPath, pacta } = {}) {
  const isPacta = pacta ?? process.env.PACTA === '1';
  const db = openDb(dbPath);
  const seeded = seedIfEmpty(db, { pacta: isPacta });

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApiRouter(db, { pacta: isPacta }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return { app, db, seeded, pacta: isPacta };
}

module.exports = { createApp };
