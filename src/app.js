'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
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

  // Serve index.html with content-hashed asset URLs (app.js?v=…, styles.css?v=…)
  // so a deploy busts any CDN/browser cache while an unchanged build stays
  // cacheable. Without this, Cloudflare kept serving a stale app.js for hours.
  const publicDir = path.join(__dirname, '..', 'public');
  app.get(['/', '/index.html'], (req, res, next) => {
    try {
      const hash = crypto.createHash('sha256');
      for (const f of ['app.js', 'styles.css']) hash.update(fs.readFileSync(path.join(publicDir, f)));
      const v = hash.digest('hex').slice(0, 10);
      const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
        .replace('/styles.css', `/styles.css?v=${v}`)
        .replace('/app.js', `/app.js?v=${v}`);
      res.type('html').set('cache-control', 'no-cache').send(html);
    } catch { next(); }
  });
  app.use(express.static(publicDir));

  return { app, db, seeded, pacta: isPacta, registry: registryAdapter, settlement: settlementBackend };
}

module.exports = { createApp };
