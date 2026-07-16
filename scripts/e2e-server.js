'use strict';
// Starts the app on a dedicated port with a throwaway database so every
// Playwright run begins from a pristine, freshly-seeded state.
const fs = require('node:fs');
const path = require('node:path');

const dbPath = path.join(__dirname, '..', 'data', 'e2e.db');
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });

process.env.DB_PATH = dbPath;
process.env.PORT = process.env.PORT || '3100';
require('../server.js');
