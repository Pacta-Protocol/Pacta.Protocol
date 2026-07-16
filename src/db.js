'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS smbs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '',
  vetted INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS arbiters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('agent','smb','escrow','stake')),
  ref_id INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  UNIQUE (kind, ref_id)
);

-- Pacta: mock of the public-records APIs (company registry, municipal permits,
-- tax authority) that registry-anchored proofs are verified against.
CREATE TABLE IF NOT EXISTS registry_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  issued_to TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER,
  from_account_id INTEGER,
  to_account_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  type TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  smb_id INTEGER NOT NULL REFERENCES smbs(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  upfront_pct INTEGER NOT NULL CHECK (upfront_pct BETWEEN 0 AND 100),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offer_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  verification_kind TEXT
);

CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  smb_id INTEGER NOT NULL REFERENCES smbs(id),
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  upfront_pct INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN
    ('draft','agreed','funded','in_progress','submitted','completed','disputed','resolved')),
  dispute_reason TEXT,
  resolution TEXT CHECK (resolution IN ('release','refund','split')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engagement_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER NOT NULL REFERENCES engagements(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  proof_text TEXT,
  proof_url TEXT,
  completed_at TEXT,
  verification_kind TEXT,
  proof_registry_ref TEXT,
  proof_verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER UNIQUE REFERENCES engagements(id),
  smb_id INTEGER NOT NULL REFERENCES smbs(id),
  agent_id INTEGER REFERENCES agents(id),
  value TEXT NOT NULL CHECK (value IN ('good','bad')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(dbPath) {
  const p = dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'marketplace.db');
  if (p !== ':memory:') fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive column migrations for databases created before Pacta existed.
// SQLite has no ADD COLUMN IF NOT EXISTS; a failed ALTER just means it's there.
function migrate(db) {
  const alters = [
    "ALTER TABLE offer_steps ADD COLUMN verification_kind TEXT",
    "ALTER TABLE engagement_steps ADD COLUMN verification_kind TEXT",
    "ALTER TABLE engagement_steps ADD COLUMN proof_registry_ref TEXT",
    "ALTER TABLE engagement_steps ADD COLUMN proof_verified INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of alters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

// Run fn inside a SQLite transaction; rolls back on any throw.
function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, withTx };
