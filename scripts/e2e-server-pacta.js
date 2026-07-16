'use strict';
// Pacta counterpart of e2e-server.js: fresh throwaway DB on port 3101.
const fs = require('node:fs');
const path = require('node:path');

const dbPath = path.join(__dirname, '..', 'data', 'e2e-pacta.db');
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });

process.env.PACTA = '1';
process.env.DB_PATH = dbPath;
process.env.PORT = process.env.PORT || '3101';
require('../server-pacta.js');
