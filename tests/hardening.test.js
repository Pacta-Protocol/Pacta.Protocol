'use strict';
// Production hardening: API keys and enforcement, rate limiting, idempotency
// keys on money-moving operations, and provider webhooks.
const http = require('node:http');
const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

const AGENT_ID = 1;
const auth = (key) => ({ authorization: `Bearer ${key}` });

async function findBufeteOffer(api) {
  const legal = (await api('GET', '/offers?q=lawyer+costa+rica+company+hotel')).body;
  return legal.find((o) => o.smb.name === 'Bufete Herrera & Asociados');
}

test('API keys: issued at registration, first claim open, rotation needs the key', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  // Registration returns the key once; it is never readable afterwards.
  const reg = await api('POST', '/smbs', {
    name: 'Keyed SMB', category: 'legal', location: 'San Jose', stake_cents: 100_00,
  });
  assert.equal(reg.status, 201);
  assert.match(reg.body.api_key, /^pk_smb_/);
  const listed = (await api('GET', `/smbs/${reg.body.id}`)).body;
  assert.equal(listed.api_key, undefined, 'key is not exposed on reads');
  assert.equal(listed.api_key_hash, undefined, 'hash is not exposed on reads');

  // Seeded identities have no key: the first claim is open (bootstrap).
  const claim = await api('POST', `/agents/${AGENT_ID}/api-key`, {});
  assert.equal(claim.status, 201);
  assert.match(claim.body.api_key, /^pk_agent_/);

  // A second claim without presenting the current key is refused.
  assert.equal((await api('POST', `/agents/${AGENT_ID}/api-key`, {})).status, 403);
  // Presenting the current key rotates it.
  const rotated = await api('POST', `/agents/${AGENT_ID}/api-key`, {}, auth(claim.body.api_key));
  assert.equal(rotated.status, 201);
  assert.notEqual(rotated.body.api_key, claim.body.api_key);
});

test('enforcement: mutations need the right key, reads stay open', async (t) => {
  const s = await startTestServer({
    pacta: true,
    hardening: { requireKeys: true, arbiterKey: 'test-arbiter-key' },
  });
  t.after(s.close);
  const { api } = s;

  // Reads are open without any key: the explorer keeps working.
  assert.equal((await api('GET', '/offers')).status, 200);
  assert.equal((await api('GET', '/config')).body.hardening.api_keys_enforced, true);

  const agentKey = (await api('POST', `/agents/${AGENT_ID}/api-key`, {})).body.api_key;
  const offer = await findBufeteOffer(api);
  const smbKey = (await api('POST', `/smbs/${offer.smb.id}/api-key`, {})).body.api_key;

  // No key: 401. Wrong actor's key: 403.
  assert.equal((await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).status, 401);
  assert.equal(
    (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID }, auth(smbKey))).status, 403);

  // Full lifecycle with the right keys on each side.
  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID }, auth(agentKey))).body;
  assert.equal((await api('POST', `/engagements/${e.id}/agree`, {}, auth(agentKey))).status, 200);
  assert.equal((await api('POST', `/engagements/${e.id}/fund`, {}, auth(agentKey))).status, 200);
  const steps = (await api('GET', `/engagements/${e.id}`)).body.steps;
  const refs = { 1: 'CR-RN-2026-104512', 2: 'CR-RN-2026-104513', 3: 'CR-MUNI-SJ-88231', 4: 'CR-HAC-2026-55710' };
  for (const step of steps) {
    // The agent cannot complete the SMB's steps.
    const wrong = await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`,
      { proof_text: 'x', registry_ref: refs[step.position] }, auth(agentKey));
    assert.equal(wrong.status, 403);
    const r = await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`,
      { proof_text: `done: ${step.title}`, registry_ref: refs[step.position] }, auth(smbKey));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await api('POST', `/engagements/${e.id}/submit`, {}, auth(smbKey))).status, 200);

  // Dispute it so the arbiter path is exercised too.
  assert.equal((await api('POST', `/engagements/${e.id}/reject`, { reason: 'testing' }, auth(agentKey))).status, 200);
  assert.equal((await api('POST', `/engagements/${e.id}/resolve`, { ruling: 'release' }, auth(agentKey))).status, 403);
  assert.equal(
    (await api('POST', `/engagements/${e.id}/resolve`, { ruling: 'release' }, auth('test-arbiter-key'))).status, 200);
  assert.equal((await api('POST', `/engagements/${e.id}/rate`, { value: 'good' }, auth(agentKey))).status, 201);

  const inv = await api('GET', '/ledger/invariant');
  assert.equal(inv.body.ok, true);
});

test('rate limiting: the window closes at the configured ceiling', async (t) => {
  const s = await startTestServer({ pacta: true, hardening: { rateLimitPerMin: 5 } });
  t.after(s.close);
  const { api } = s;
  let last;
  for (let i = 0; i < 5; i += 1) last = await api('GET', '/health');
  assert.equal(last.status, 200);
  const blocked = await api('GET', '/health');
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /rate limit/);
  assert.equal(blocked.headers.get('retry-after'), '60');
});

test('idempotency: a retried fund can never move money twice', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  const offer = await findBufeteOffer(api);
  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});

  const key = { 'idempotency-key': 'fund-attempt-1' };
  const first = await api('POST', `/engagements/${e.id}/fund`, {}, key);
  assert.equal(first.status, 200);
  const escrowAfterFirst = first.body.escrow_balance_cents;
  assert.ok(escrowAfterFirst > 0);

  // The retry replays the stored response instead of re-executing.
  const retry = await api('POST', `/engagements/${e.id}/fund`, {}, key);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(retry.body, first.body);
  const now = (await api('GET', `/engagements/${e.id}`)).body;
  assert.equal(now.escrow_balance_cents, escrowAfterFirst, 'escrow was funded exactly once');

  // Without the header, the state machine still answers 409 as before.
  assert.equal((await api('POST', `/engagements/${e.id}/fund`, {})).status, 409);
  // Reusing the key on a different operation is an error.
  const misuse = await api('POST', `/engagements/${e.id}/approve`, {}, key);
  assert.equal(misuse.status, 422);
  const inv = await api('GET', '/ledger/invariant');
  assert.equal(inv.body.ok, true);
});

test('provider webhooks: signed events are pushed on state changes', async (t) => {
  const received = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const receiver = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      received.push({ signature: req.headers['x-pacta-signature'], body: data });
      res.writeHead(204).end();
      if (received.length === 3) resolveDone();
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => receiver.close(r)));

  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  const offer = await findBufeteOffer(api);
  const hook = await api('POST', `/smbs/${offer.smb.id}/webhook`, {
    url: `http://127.0.0.1:${receiver.address().port}/hook`,
  });
  assert.equal(hook.status, 201);
  assert.match(hook.body.webhook_secret, /^whsec_/);

  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});
  await api('POST', `/engagements/${e.id}/fund`, {});
  const steps = (await api('GET', `/engagements/${e.id}`)).body.steps;
  const refs = { 1: 'CR-RN-2026-104512', 2: 'CR-RN-2026-104513', 3: 'CR-MUNI-SJ-88231', 4: 'CR-HAC-2026-55710' };
  for (const step of steps) {
    await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`,
      { proof_text: `done: ${step.title}`, registry_ref: refs[step.position] });
  }
  await api('POST', `/engagements/${e.id}/submit`, {});
  await api('POST', `/engagements/${e.id}/approve`, {});
  await done;

  const events = received.map((r) => JSON.parse(r.body).event);
  assert.deepEqual(events, ['engagement.agreed', 'engagement.funded', 'engagement.completed']);
  for (const r of received) {
    const expected = `sha256=${crypto.createHmac('sha256', hook.body.webhook_secret).update(r.body).digest('hex')}`;
    assert.equal(r.signature, expected, 'HMAC signature verifies with the registered secret');
    assert.equal(JSON.parse(r.body).engagement_id, e.id);
  }

  // An unreachable webhook must never break the API itself.
  const dead = await api('POST', `/smbs/${offer.smb.id}/webhook`, { url: 'http://127.0.0.1:1/nope' });
  assert.equal(dead.status, 201);
  const e2 = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  assert.equal((await api('POST', `/engagements/${e2.id}/agree`, {})).status, 200);
});
