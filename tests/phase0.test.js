'use strict';
// Phase 0 (ADR-001) — cryptographic agreement immutability.
// The adversarial tests are the point of the feature: every way of rewriting
// history must be detectable by replay and by receipt verification.
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic platform key for the whole suite (env wins over the dev keyfile).
const eip712 = require('../src/eip712');
process.env.PLATFORM_SIGNING_KEY = process.env.PLATFORM_SIGNING_KEY || eip712.newPrivateKey();

const { startTestServer } = require('./helpers');
const canonical = require('../src/canonical');
const merkle = require('../src/merkle');
const eventlog = require('../src/eventlog');
const keysmod = require('../src/keys');
const anchor = require('../src/anchor');
const verifier = require('../packages/verifier/lib');

const CHAIN_ID = eip712.chainId();

// ---------- canonicalizer ------------------------------------------------------

test('canonicalize: shuffled keys and varied whitespace produce byte-identical output', () => {
  const a = { z: 1, a: [{ b: 2, a: 'x' }], m: { y: null, x: true } };
  const b = JSON.parse('{ "m": {"x": true, "y": null}, "a": [ {"a": "x", "b": 2} ], "z": 1 }');
  assert.strictEqual(canonical.canonicalize(a), canonical.canonicalize(b));
  assert.strictEqual(canonical.hashOf(a), canonical.hashOf(b));
});

test('canonicalize: any field change changes the hash; non-finite numbers throw', () => {
  const base = { price_cents: 500000, steps: [{ n: 1 }] };
  assert.notStrictEqual(canonical.hashOf(base), canonical.hashOf({ ...base, price_cents: 500001 }));
  assert.notStrictEqual(canonical.hashOf(base), canonical.hashOf({ price_cents: 500000, steps: [{ n: 2 }] }));
  assert.throws(() => canonical.canonicalize({ x: Infinity }));
});

// ---------- EIP-712 ------------------------------------------------------------

test('eip712: sign, verify, recover round-trip; wrong key and tampered digest fail', () => {
  const priv = eip712.newPrivateKey();
  const pub = eip712.publicKeyOf(priv);
  const digest = eip712.agreementDigest({
    agreementHash: canonical.hashOf({ any: 'terms' }), role: 'buyer', nonce: '0xabc123', chainId: CHAIN_ID,
  });
  const sig = eip712.signDigest(digest, priv);
  assert.strictEqual(sig.length, 132); // 0x + 65 bytes
  assert.strictEqual(eip712.verifyDigest(digest, sig, pub), true);
  assert.strictEqual(eip712.recoverPubkey(digest, sig), pub);
  const otherPub = eip712.publicKeyOf(eip712.newPrivateKey());
  assert.strictEqual(eip712.verifyDigest(digest, sig, otherPub), false);
  const tampered = eip712.agreementDigest({
    agreementHash: canonical.hashOf({ any: 'altered terms' }), role: 'buyer', nonce: '0xabc123', chainId: CHAIN_ID,
  });
  assert.strictEqual(eip712.verifyDigest(tampered, sig, pub), false);
});

// ---------- Merkle -------------------------------------------------------------

test('merkle: single leaf, odd counts, proof verification, forged sibling', () => {
  const h = (s) => canonical.sha256hex(s);
  const one = [h('a')];
  assert.strictEqual(merkle.merkleRoot(one), h('a'));
  assert.deepStrictEqual(merkle.merkleProof(one, 0), []);
  for (const n of [2, 3, 5, 8]) {
    const leaves = Array.from({ length: n }, (_, i) => h(`leaf${i}`));
    const root = merkle.merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const proof = merkle.merkleProof(leaves, i);
      assert.strictEqual(merkle.verifyProof(leaves[i], proof, root), true, `n=${n} i=${i}`);
    }
    const forged = merkle.merkleProof(leaves, 0).map((s, j) => (j === 0 ? { ...s, hash: h('evil') } : s));
    if (forged.length) assert.strictEqual(merkle.verifyProof(leaves[0], forged, root), false);
  }
});

// ---------- lifecycle: every mutation emits a chained, signed, verifiable event

async function runLifecycle(t) {
  const s = await startTestServer({ pacta: true });
  t.after(() => s.close());
  // LexCorp's offer (id 2) has 3 steps with no registry requirement — the
  // shortest full path through the lifecycle.
  const draft = await s.api('POST', '/engagements', { offer_id: 2, agent_id: 1 });
  assert.strictEqual(draft.status, 201);
  const id = draft.body.id;
  const agreed = await s.api('POST', `/engagements/${id}/agree`, {});
  assert.strictEqual(agreed.status, 200);
  return { s, id, agreed };
}

test('agree locks a dually-signed agreement and returns a verifiable receipt', async (t) => {
  const { s, agreed } = await runLifecycle(t);
  const hash = agreed.body.agreement_hash;
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.ok(agreed.body.signatures.buyer && agreed.body.signatures.provider);
  const receipt = agreed.body.receipt;
  assert.strictEqual(receipt.entry.type, 'AgreementLocked');
  assert.strictEqual(receipt.entry.engagement, hash);
  const platform = (await s.api('GET', '/keys/platform')).body;
  const result = verifier.verifyReceipt(receipt, { platformPubkey: platform.pubkey, chainId: CHAIN_ID });
  assert.strictEqual(result.pass, true, JSON.stringify(result.checks));
  for (const name of ['entry_hash', 'pacta_sig', 'agreement_hash', 'buyer_sig', 'provider_sig']) {
    assert.strictEqual(result.checks.find((c) => c.name === name).status, 'PASS', name);
  }
});

test('every lifecycle mutation appends exactly one chained event; replay passes', async (t) => {
  const { s, id } = await runLifecycle(t);
  await s.api('POST', `/engagements/${id}/fund`, {});
  const e = (await s.api('GET', `/engagements/${id}`)).body;
  for (const step of e.steps) {
    await s.api('POST', `/engagements/${id}/steps/${step.id}/complete`, { proof_text: `done: ${step.title}` });
  }
  await s.api('POST', `/engagements/${id}/submit`, {});
  await s.api('POST', `/engagements/${id}/approve`, {});
  await s.api('POST', `/engagements/${id}/rate`, { value: 'good' });

  const types = s.db.prepare('SELECT type FROM event_log ORDER BY seq').all().map((r) => r.type);
  // 2 custodial keys registered lazily, then the lifecycle chain.
  assert.deepStrictEqual(types, [
    'KeyRegistered', 'KeyRegistered', 'AgreementLocked', 'EscrowFunded',
    'EvidenceSubmitted', 'EvidenceSubmitted', 'EvidenceSubmitted',
    'WorkSubmitted', 'SettlementApproved', 'RatingSubmitted',
  ]);
  assert.strictEqual(eventlog.replay(s.db).ok, true);
  const integrity = (await s.api('GET', '/integrity')).body;
  assert.strictEqual(integrity.chain.ok, true);
  assert.strictEqual((await s.api('GET', '/ledger/invariant')).body.ok, true);
});

test('disputes: ruling and slash are logged; free text enters only as a hash', async (t) => {
  const { s, id } = await runLifecycle(t);
  await s.api('POST', `/engagements/${id}/fund`, {});
  const e = (await s.api('GET', `/engagements/${id}`)).body;
  for (const step of e.steps) {
    await s.api('POST', `/engagements/${id}/steps/${step.id}/complete`, { proof_text: 'x' });
  }
  await s.api('POST', `/engagements/${id}/submit`, {});
  const reason = 'the corporate books were never delivered';
  await s.api('POST', `/engagements/${id}/reject`, { reason });
  const ruled = await s.api('POST', `/engagements/${id}/resolve`, { ruling: 'split' });
  assert.strictEqual(ruled.status, 200);
  const rows = s.db.prepare("SELECT type, payload FROM event_log WHERE type IN ('DisputeOpened','RulingIssued','StakeChanged') ORDER BY seq").all();
  assert.deepStrictEqual(rows.map((r) => r.type), ['DisputeOpened', 'RulingIssued', 'StakeChanged']);
  const dispute = JSON.parse(rows[0].payload);
  assert.strictEqual(dispute.reason_hash, canonical.hashOf(reason));
  assert.ok(!JSON.stringify(rows).includes('corporate books'), 'free text must never enter the log');
  const ruling = JSON.parse(rows[1].payload);
  assert.strictEqual(ruling.ruling, 'split');
  assert.ok(ruling.stake_slashed_cents > 0);
  assert.strictEqual((await s.api('GET', '/ledger/invariant')).body.ok, true);
});

// ---------- immutability: triggers + adversarial tamper ------------------------

test('event_log UPDATE and DELETE are blocked by triggers', async (t) => {
  const { s } = await runLifecycle(t);
  assert.throws(() => s.db.exec("UPDATE event_log SET payload = '{}' WHERE seq = 1"), /append-only/);
  assert.throws(() => s.db.exec('DELETE FROM event_log WHERE seq = 1'), /append-only/);
});

test('tampering past the triggers breaks replay and receipt verification', async (t) => {
  const { s, id } = await runLifecycle(t);
  await s.api('POST', `/engagements/${id}/fund`, {});
  const before = eventlog.replay(s.db);
  assert.strictEqual(before.ok, true);
  const platform = (await s.api('GET', '/keys/platform')).body;
  const proof = (await s.api('GET', `/engagements/${id}/proof`)).body;
  const funded = proof.receipts.find((r) => r.entry.type === 'EscrowFunded');
  assert.strictEqual(verifier.verifyReceipt(funded, { platformPubkey: platform.pubkey, chainId: CHAIN_ID }).pass, true);

  // A superuser bypasses the triggers and rewrites the amount in place.
  const seq = funded.entry.seq;
  s.db.exec('DROP TRIGGER event_log_no_update');
  const tamperedPayload = JSON.stringify({ ...funded.entry.payload, amount_cents: 1 });
  s.db.prepare('UPDATE event_log SET payload = ? WHERE seq = ?').run(tamperedPayload, seq);
  s.db.exec("CREATE TRIGGER event_log_no_update BEFORE UPDATE ON event_log BEGIN SELECT RAISE(ABORT, 'event_log is append-only: UPDATE forbidden'); END");

  const after = eventlog.replay(s.db);
  assert.strictEqual(after.ok, false);
  assert.strictEqual(after.broken_at, seq);
  const tamperedReceipt = (await s.api('GET', `/engagements/${id}/proof`)).body.receipts
    .find((r) => r.entry.seq === seq);
  const result = verifier.verifyReceipt(tamperedReceipt, { platformPubkey: platform.pubkey, chainId: CHAIN_ID });
  assert.strictEqual(result.pass, false);
  assert.strictEqual(result.checks.find((c) => c.name === 'entry_hash').status, 'FAIL');
  const viaApi = (await s.api('POST', '/verify', { receipt: tamperedReceipt })).body;
  assert.strictEqual(viaApi.pass, false);
  assert.match(viaApi.independent_verification, /re-run these checks yourself/);
});

test('altering agreement terms in a receipt invalidates hash AND both signatures', async (t) => {
  const { s, agreed } = await runLifecycle(t);
  const platform = (await s.api('GET', '/keys/platform')).body;
  const receipt = JSON.parse(JSON.stringify(agreed.body.receipt));
  receipt.entry.payload.agreement.price_cents = 1; // pay the provider one cent
  const result = verifier.verifyReceipt(receipt, { platformPubkey: platform.pubkey, chainId: CHAIN_ID });
  assert.strictEqual(result.pass, false);
  assert.strictEqual(result.checks.find((c) => c.name === 'entry_hash').status, 'FAIL');
  assert.strictEqual(result.checks.find((c) => c.name === 'agreement_hash').status, 'FAIL');
  // The old signatures cannot be replayed against the modified terms: verify
  // them against the recomputed (tampered) hash directly.
  const tamperedHash = verifier.agreementHashOf(receipt.entry.payload.agreement);
  for (const role of ['buyer', 'provider']) {
    const ok = verifier.verifySig(
      verifier.agreementDigest({ agreementHash: tamperedHash, role, nonce: receipt.entry.payload.agreement.nonce, chainId: CHAIN_ID }),
      receipt.entry.payload.signatures[role],
      receipt.entry.payload.agreement[role].pubkey,
    );
    assert.strictEqual(ok, false, `${role} signature must not validate modified terms`);
  }
});

test('swapping two agreements terms is detected', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(() => s.close());
  const e1 = (await s.api('POST', '/engagements', { offer_id: 2, agent_id: 1 })).body.id;
  const a1 = (await s.api('POST', `/engagements/${e1}/agree`, {})).body;
  const e2 = (await s.api('POST', '/engagements', { offer_id: 3, agent_id: 1 })).body.id;
  const a2 = (await s.api('POST', `/engagements/${e2}/agree`, {})).body;
  const platform = (await s.api('GET', '/keys/platform')).body;
  const swapped = JSON.parse(JSON.stringify(a1.receipt));
  swapped.entry.payload.agreement = a2.receipt.entry.payload.agreement; // claim e2's terms under e1's identity
  const result = verifier.verifyReceipt(swapped, { platformPubkey: platform.pubkey, chainId: CHAIN_ID });
  assert.strictEqual(result.pass, false);
  assert.strictEqual(result.checks.find((c) => c.name === 'agreement_hash').status, 'FAIL');
});

// ---------- self-custody -------------------------------------------------------

test('self-custody: the platform cannot sign for you; your own signature works', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(() => s.close());
  const priv = eip712.newPrivateKey();
  const reg = await s.api('POST', '/agents/1/signing-key', { pubkey: eip712.publicKeyOf(priv) });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.body.custody, 'self');
  const id = (await s.api('POST', '/engagements', { offer_id: 2, agent_id: 1 })).body.id;
  const without = await s.api('POST', `/engagements/${id}/agree`, {});
  assert.strictEqual(without.status, 400);
  assert.match(without.body.error, /custody: self/);
  // Provider still has no key: preview requires both, so ensure the custodial
  // one by previewing after the failed agree created... it did not — register
  // flow: the SMB side stays custodial and is created at agree time, so
  // preview needs it first. Simulate the provider registering too.
  const smbId = (await s.api('GET', `/engagements/${id}`)).body.smb.id;
  const smbPriv = eip712.newPrivateKey();
  await s.api('POST', `/smbs/${smbId}/signing-key`, { pubkey: eip712.publicKeyOf(smbPriv) });
  const preview = (await s.api('GET', `/engagements/${id}/agreement-preview`)).body;
  assert.match(preview.agreement_hash, /^0x[0-9a-f]{64}$/);
  const sign = (digestHex, key) => eip712.signDigest(Uint8Array.from(Buffer.from(digestHex.slice(2), 'hex')), key);
  const done = await s.api('POST', `/engagements/${id}/agree`, {
    buyer_signature: sign(preview.signing_digests.buyer, priv),
    provider_signature: sign(preview.signing_digests.provider, smbPriv),
  });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.strictEqual(done.body.agreement_hash, preview.agreement_hash);
});

// ---------- anchoring ----------------------------------------------------------

test('local anchoring: receipts gain Merkle proofs; heartbeat and reconcile work', async (t) => {
  const { s, id } = await runLifecycle(t);
  await s.api('POST', `/engagements/${id}/fund`, {});
  const adapter = new anchor.LocalAnchorAdapter(s.db);
  const anchored = await anchor.anchorPending(s.db, adapter);
  assert.ok(anchored.root.startsWith('0x'));
  assert.strictEqual(anchored.from_seq, 1);

  const platform = (await s.api('GET', '/keys/platform')).body;
  const proof = (await s.api('GET', `/engagements/${id}/proof`)).body;
  for (const receipt of proof.receipts) {
    assert.ok(receipt.merkle_proof, `seq ${receipt.entry.seq} should be anchored`);
    assert.strictEqual(receipt.anchor.root, anchored.root);
    const result = verifier.verifyReceipt(receipt, { platformPubkey: platform.pubkey, chainId: CHAIN_ID });
    assert.strictEqual(result.pass, true, JSON.stringify(result.checks));
    assert.strictEqual(result.checks.find((c) => c.name === 'merkle_proof').status, 'PASS');
  }

  // Forged sibling in an otherwise valid proof must fail the Merkle walk.
  const forged = JSON.parse(JSON.stringify(proof.receipts[0]));
  if (forged.merkle_proof.length) {
    forged.merkle_proof[0].hash = canonical.sha256hex('evil');
    const bad = verifier.verifyReceipt(forged, { platformPubkey: platform.pubkey, chainId: CHAIN_ID });
    assert.strictEqual(bad.checks.find((c) => c.name === 'merkle_proof').status, 'FAIL');
  }

  // Nothing pending → no new anchor; heartbeat re-anchors the last root.
  assert.strictEqual(await anchor.anchorPending(s.db, adapter), null);
  const hb = await anchor.anchorHeartbeat(s.db, adapter);
  assert.strictEqual(hb.root, anchored.root);
  assert.strictEqual(hb.from_seq, hb.to_seq);

  // Self-monitor: clean reconcile, then detect an anchor from our sender that
  // we never recorded (key-compromise signal).
  assert.strictEqual((await anchor.reconcile(s.db, adapter)).ok, true);
  s.db.prepare('INSERT INTO local_chain (root, from_seq, to_seq, sender, tx_hash) VALUES (?, 1, 1, ?, ?)')
    .run(canonical.sha256hex('rogue'), adapter.sender, canonical.sha256hex('rogue-tx'));
  const alerts = await anchor.reconcile(s.db, adapter);
  assert.strictEqual(alerts.ok, false);
  assert.strictEqual(alerts.alerts[0].kind, 'unknown_anchor_from_our_sender');
});

test('pre-phase0 engagements are marked, not backfilled', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(() => s.close());
  // An engagement created before Phase 0: no nonce, no hash.
  const info = s.db.prepare(
    "INSERT INTO engagements (offer_id, agent_id, smb_id, title, price_cents, upfront_pct, state) VALUES (2, 1, 2, 'legacy', 100, 0, 'completed')",
  ).run();
  const id = Number(info.lastInsertRowid);
  const proof = (await s.api('GET', `/engagements/${id}/proof`)).body;
  assert.strictEqual(proof.pre_phase0, true);
  assert.strictEqual(proof.agreement_hash, null);
  assert.deepStrictEqual(proof.receipts, []);
});
