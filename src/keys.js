'use strict';
// Phase 0 (ADR-001): signing-key registry.
//
// Two custody modes, recorded per key:
//   self       - the owner holds the private key; only the pubkey is registered.
//   custodial  - the platform generates and holds the key on the owner's
//                behalf (launch default for SMBs, disclosed in the UI and in
//                this registry). The signature format is identical, so a later
//                migration to self-custody requires no re-signing.
//
// Custodial private keys are stored in the database for this simulated build;
// a production deployment moves them (and the platform key) to a KMS - this is
// listed in the production gaps doc. The platform's own key comes from the
// PLATFORM_SIGNING_KEY env var, or a generated dev key persisted next to the
// database (never in the repo).
const fs = require('node:fs');
const path = require('node:path');
const eip712 = require('./eip712');

class KeyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const VALID_PUBKEY = /^0x04[0-9a-fA-F]{128}$/;

function getKey(db, kind, id) {
  return db.prepare('SELECT * FROM signing_keys WHERE owner_kind = ? AND owner_id = ?').get(kind, id) || null;
}

// Register a self-custody pubkey, or rotate an existing key. Must run inside
// the caller's transaction when combined with other writes.
function registerKey(db, kind, id, { pubkey, custody = 'self', privkey = null }) {
  if (!VALID_PUBKEY.test(String(pubkey))) {
    throw new KeyError(400, 'pubkey must be an uncompressed secp256k1 key: 0x04 + 128 hex chars');
  }
  db.prepare(`
    INSERT INTO signing_keys (owner_kind, owner_id, pubkey, custody, privkey)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (owner_kind, owner_id) DO UPDATE SET pubkey = excluded.pubkey,
      custody = excluded.custody, privkey = excluded.privkey
  `).run(kind, id, pubkey, custody, privkey);
  return getKey(db, kind, id);
}

// Launch default: parties without a registered key get a custodial one the
// first time a signature is needed. Returns the key row either way.
function ensureCustodialKey(db, kind, id) {
  const existing = getKey(db, kind, id);
  if (existing) return existing;
  const privkey = eip712.newPrivateKey();
  return registerKey(db, kind, id, {
    pubkey: eip712.publicKeyOf(privkey), custody: 'custodial', privkey,
  });
}

// Sign an agreement digest on behalf of a party. Custodial keys sign with the
// platform-held private key; self-custody parties must send their signature -
// the platform cannot produce one for them.
function signAsParty(db, keyRow, digest) {
  if (keyRow.custody !== 'custodial' || !keyRow.privkey) {
    throw new KeyError(400,
      `${keyRow.owner_kind} ${keyRow.owner_id} holds its own key (custody: self); it must send its signature`);
  }
  return eip712.signDigest(digest, keyRow.privkey);
}

// ---------- platform key -------------------------------------------------------

let cachedPlatformKey = null;

function platformPrivkey() {
  if (process.env.PLATFORM_SIGNING_KEY) return process.env.PLATFORM_SIGNING_KEY;
  if (cachedPlatformKey) return cachedPlatformKey;
  const file = process.env.PLATFORM_KEY_FILE
    || path.join(__dirname, '..', 'data', 'platform-key');
  try {
    cachedPlatformKey = fs.readFileSync(file, 'utf8').trim();
  } catch {
    const key = eip712.newPrivateKey();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, `${key}\n`, { flag: 'wx', mode: 0o600 });
      cachedPlatformKey = key;
    } catch {
      cachedPlatformKey = fs.readFileSync(file, 'utf8').trim(); // lost the race: another process wrote it
    }
  }
  return cachedPlatformKey;
}

const platformPubkey = () => eip712.publicKeyOf(platformPrivkey());

module.exports = {
  KeyError, getKey, registerKey, ensureCustodialKey, signAsParty,
  platformPrivkey, platformPubkey,
};
