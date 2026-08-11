'use strict';
// Standalone tests for the independent verifier. These import ONLY the
// verifier's own lib and @noble (the same rule the verifier itself follows:
// zero backend imports), building a receipt from scratch and signing it here,
// so the verifier is exercised against data it did not produce.
const { test } = require('node:test');
const assert = require('node:assert');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const lib = require('./lib');

const CHAIN_ID = 84532;
const GENESIS = `0x${'0'.repeat(64)}`;
const toBytes = (hex) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
const toHex = (b) => `0x${Buffer.from(b).toString('hex')}`;
const newKey = () => toHex(secp256k1.utils.randomSecretKey());
const pubOf = (priv) => toHex(secp256k1.getPublicKey(toBytes(priv), false));
// r||s||v, matching src/eip712.js.
const sign = (digest, priv) => {
  const s = secp256k1.sign(digest, toBytes(priv), { format: 'recovered' });
  return toHex(Uint8Array.from([...s.slice(1), 27 + s[0]]));
};

function mintReceipt() {
  const buyer = newKey();
  const provider = newKey();
  const platform = newKey();
  const agreement = {
    schema: 'pacta/agreement@1',
    buyer: { id: 'agt_1', pubkey: pubOf(buyer) },
    provider: { id: 'smb_1', pubkey: pubOf(provider) },
    title_hash: lib.sha256hex('t'),
    price_cents: 500000,
    currency: 'USD',
    escrow_split: { down_bps: 2000, final_bps: 8000 },
    steps: [{ n: 1, desc_hash: lib.sha256hex('s'), proof_kind: 'none' }],
    dispute_rules_hash: lib.sha256hex('rules'),
    nonce: '0xdeadbeef',
  };
  const agreementHash = lib.agreementHashOf(agreement);
  const signatures = {
    buyer: sign(lib.agreementDigest({ agreementHash, role: 'buyer', nonce: agreement.nonce, chainId: CHAIN_ID }), buyer),
    provider: sign(lib.agreementDigest({ agreementHash, role: 'provider', nonce: agreement.nonce, chainId: CHAIN_ID }), provider),
  };
  const entry = {
    seq: 1,
    engagement: agreementHash,
    type: 'AgreementLocked',
    payload: { engagement_id: 1, agreement, agreement_hash: agreementHash, signatures },
    at: '2026-08-10T00:00:00.000Z',
    prev_hash: GENESIS,
  };
  entry.entry_hash = lib.entryHashOf(GENESIS, entry);
  const pacta_sig = sign(lib.logEntryDigest({ entryHash: entry.entry_hash, chainId: CHAIN_ID }), platform);
  return { receipt: { entry, merkle_proof: null, anchor: null, pacta_sig }, platformPubkey: pubOf(platform) };
}

test('verifier accepts a genuine receipt (all offline checks pass)', () => {
  const { receipt, platformPubkey } = mintReceipt();
  const r = lib.verifyReceipt(receipt, { platformPubkey, chainId: CHAIN_ID });
  assert.strictEqual(r.pass, true, JSON.stringify(r.checks));
  for (const name of ['entry_hash', 'pacta_sig', 'agreement_hash', 'buyer_sig', 'provider_sig']) {
    assert.strictEqual(r.checks.find((c) => c.name === name).status, 'PASS', name);
  }
});

test('tampering with agreement terms fails hash and both signatures', () => {
  const { receipt, platformPubkey } = mintReceipt();
  receipt.entry.payload.agreement.price_cents = 1;
  const r = lib.verifyReceipt(receipt, { platformPubkey, chainId: CHAIN_ID });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.checks.find((c) => c.name === 'entry_hash').status, 'FAIL');
  assert.strictEqual(r.checks.find((c) => c.name === 'agreement_hash').status, 'FAIL');
});

test('a receipt signed by the wrong platform key fails pacta_sig', () => {
  const { receipt } = mintReceipt();
  const r = lib.verifyReceipt(receipt, { platformPubkey: pubOf(newKey()), chainId: CHAIN_ID });
  assert.strictEqual(r.checks.find((c) => c.name === 'pacta_sig').status, 'FAIL');
});

test('canonicalize is order-independent (RFC 8785)', () => {
  assert.strictEqual(lib.canonicalize({ b: 1, a: 2 }), lib.canonicalize({ a: 2, b: 1 }));
  assert.notStrictEqual(lib.canonicalize({ a: 1 }), lib.canonicalize({ a: 2 }));
});
