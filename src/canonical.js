'use strict';
// Phase 0 (ADR-001): deterministic serialization of agreement terms.
//
// canonicalize() implements RFC 8785 (JCS) for the value space this protocol
// uses: null, booleans, finite numbers, strings, arrays and plain objects.
// Object keys are sorted by UTF-16 code units; strings and numbers serialize
// exactly as JSON.stringify does, which for ECMAScript engines matches the
// RFC 8785 number and string rules. Semantically identical inputs (key order
// shuffled, whitespace varied) therefore produce byte-identical output.
//
// agreement_hash = SHA-256 over the canonical bytes, hex, 0x-prefixed - the
// universal engagement identifier. The canonical object contains no unhashed
// free text: step titles/descriptions enter as desc_hash, the engagement
// title as title_hash.
const crypto = require('node:crypto');

const SCHEMA_VERSION = 'pacta/agreement@1';

// The arbitration rules the parties sign up to. Versioned text: any change is
// a new version with a new hash, so old agreements keep binding the rules
// they were signed under.
const DISPUTE_RULES_TEXT = [
  'pacta/dispute-rules@1',
  'Disputes are ruled by the marketplace arbiter with one of: release (escrow to provider),',
  'refund (escrow to buyer), split (50/50, odd cent to the provider).',
  'Rulings apply to escrowed funds only; the un-drawn remainder never left the buyer.',
  'An adverse ruling slashes the provider stake: 20% of escrow on refund, 10% on split.',
].join('\n');

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
}

const sha256hex = (input) => `0x${crypto.createHash('sha256').update(input).digest('hex')}`;

// Hash of a canonicalizable value - used for every free-text field that must
// bind the agreement without entering it.
const hashOf = (value) => sha256hex(canonicalize(value));

// Build the canonical agreement object for an engagement. Pure data in, pure
// data out: callers pass the engagement row, its steps, and both parties'
// registered public keys.
function canonicalAgreement({ engagement, steps, buyerPubkey, providerPubkey }) {
  const price = Number(engagement.price_cents);
  const downBps = Number(engagement.upfront_pct) * 100;
  return {
    schema: SCHEMA_VERSION,
    buyer: { id: `agt_${engagement.agent_id}`, pubkey: buyerPubkey },
    provider: { id: `smb_${engagement.smb_id}`, pubkey: providerPubkey },
    title_hash: hashOf(engagement.title),
    price_cents: price,
    currency: 'USD',
    escrow_split: { down_bps: downBps, final_bps: 10000 - downBps },
    steps: steps.map((s) => ({
      n: Number(s.position),
      desc_hash: hashOf({ title: s.title, description: s.description || '' }),
      proof_kind: s.verification_kind || 'none',
    })),
    dispute_rules_hash: sha256hex(DISPUTE_RULES_TEXT),
    nonce: engagement.nonce,
  };
}

const agreementHash = (agreement) => sha256hex(canonicalize(agreement));

const newNonce = () => `0x${crypto.randomBytes(16).toString('hex')}`;

module.exports = {
  SCHEMA_VERSION, DISPUTE_RULES_TEXT,
  canonicalize, sha256hex, hashOf, canonicalAgreement, agreementHash, newNonce,
};
