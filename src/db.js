'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  api_key_hash TEXT,
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
  api_key_hash TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
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

-- Idempotency: the stored 2xx response for a money-moving POST, replayed
-- verbatim when a client retries with the same Idempotency-Key header.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER UNIQUE REFERENCES engagements(id),
  smb_id INTEGER NOT NULL REFERENCES smbs(id),
  agent_id INTEGER REFERENCES agents(id),
  value TEXT NOT NULL CHECK (value IN ('good','bad')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 0 (ADR-001): signing keys for agreement signatures. Custody 'custodial'
-- means the platform holds the private key on the owner's behalf (disclosed;
-- launch default for SMBs); 'self' keys never store a private key here. The
-- platform's own signing key lives in PLATFORM_SIGNING_KEY, not in this table.
CREATE TABLE IF NOT EXISTS signing_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('agent','smb')),
  owner_id INTEGER NOT NULL,
  pubkey TEXT NOT NULL,
  custody TEXT NOT NULL CHECK (custody IN ('self','custodial')),
  privkey TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_kind, owner_id)
);

-- Phase 0 (ADR-001): hash-chained append-only event log. Every lifecycle
-- mutation appends exactly one entry in the same transaction as the state
-- change. payload holds hashes and metadata only — evidence bytes and free
-- text never enter the log. UPDATE and DELETE are forbidden by triggers.
CREATE TABLE IF NOT EXISTS event_log (
  seq INTEGER PRIMARY KEY,
  engagement TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS event_log_no_update
BEFORE UPDATE ON event_log
BEGIN SELECT RAISE(ABORT, 'event_log is append-only: UPDATE forbidden'); END;
CREATE TRIGGER IF NOT EXISTS event_log_no_delete
BEFORE DELETE ON event_log
BEGIN SELECT RAISE(ABORT, 'event_log is append-only: DELETE forbidden'); END;

-- Phase 0: Pacta's EIP-712 signature over each entry_hash, the core of the
-- receipt handed to both parties. Kept out of event_log so the chained bytes
-- stay exactly what the verifier recomputes.
CREATE TABLE IF NOT EXISTS receipt_sigs (
  seq INTEGER PRIMARY KEY REFERENCES event_log(seq),
  pacta_sig TEXT NOT NULL
);

-- Base Readiness (ADR-002): Merkle roots of the event log anchored to Base.
-- One row per anchored 12h window; always written, even for empty windows
-- (leaf_count == 0, root == zero root). sequence is the on-chain anchor index
-- (the contract count). window_start/window_end are unix seconds.
CREATE TABLE IF NOT EXISTS anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence INTEGER NOT NULL,
  root TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  leaf_count INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number INTEGER,
  block_time TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Base Readiness: the simulated chain behind the 'local' anchor adapter — keeps
-- the demo and CI deterministic with no RPC. The 'rpc' adapter replaces this
-- with the real AnchorRegistry on Base (see contracts/AnchorRegistry.sol).
CREATE TABLE IF NOT EXISTS local_chain (
  block_number INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence INTEGER NOT NULL,
  root TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  leaf_count INTEGER NOT NULL,
  sender TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_time TEXT NOT NULL DEFAULT (datetime('now'))
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
    "ALTER TABLE agents ADD COLUMN api_key_hash TEXT",
    "ALTER TABLE smbs ADD COLUMN api_key_hash TEXT",
    "ALTER TABLE smbs ADD COLUMN webhook_url TEXT",
    "ALTER TABLE smbs ADD COLUMN webhook_secret TEXT",
    // Phase 0: agreement identity + dual signatures. Engagements that settled
    // before Phase 0 keep these NULL and are treated as pre-phase0 (no
    // backfilled signatures, by decision — see ADR-001).
    "ALTER TABLE engagements ADD COLUMN nonce TEXT",
    "ALTER TABLE engagements ADD COLUMN agreement_hash TEXT",
    "ALTER TABLE engagements ADD COLUMN buyer_sig TEXT",
    "ALTER TABLE engagements ADD COLUMN provider_sig TEXT",
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
