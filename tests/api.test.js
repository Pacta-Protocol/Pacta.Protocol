'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

const AGENT_ID = 1; // Realtor Assistant Agent (seeded)

async function invariantOk(t, api) {
  const inv = await api('GET', '/ledger/invariant');
  assert.equal(inv.status, 200);
  assert.equal(inv.body.ok, true, `ledger invariant broken: ${JSON.stringify(inv.body)}`);
}

test('seed data: users, SMBs, vetted badges, balances', async (t) => {
  const s = await startTestServer();
  t.after(s.close);

  const users = await s.api('GET', '/users');
  assert.equal(users.status, 200);
  assert.equal(users.body.agents.length, 1);
  assert.equal(users.body.agents[0].name, 'Realtor Assistant Agent');
  assert.equal(users.body.agents[0].balance_cents, 5_000_000); // $50,000
  assert.ok(users.body.smbs.length >= 6, 'at least 6 seeded SMBs');
  assert.ok(users.body.smbs.every((smb) => smb.vetted === true), 'every SMB is auto-vetted');
  assert.equal(users.body.arbiters.length, 1);

  const bufete = users.body.smbs.find((x) => x.name === 'Bufete Herrera & Asociados');
  assert.ok(bufete, 'Bufete Herrera seeded');
  assert.equal(bufete.category, 'legal');
  assert.equal(bufete.location, 'Costa Rica');
  assert.deepEqual(bufete.rating, { good: 3, bad: 1, score: 2 }, 'rating history present');

  await invariantOk(t, s.api);
});

test('search: keyword AND-matching, filters, ranking by rating then price', async (t) => {
  const s = await startTestServer();
  t.after(s.close);

  const r = await s.api('GET', '/offers?q=' + encodeURIComponent('lawyer Costa Rica company hotel'));
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 2, 'both Costa Rican legal offers match');
  // Tie on rating score (2 vs 2) → cheaper LexCorp first, Bufete second.
  assert.equal(r.body[0].smb.name, 'LexCorp Legal Solutions');
  assert.equal(r.body[1].smb.name, 'Bufete Herrera & Asociados');
  assert.equal(r.body[1].price_cents, 500_000);
  assert.equal(r.body[1].upfront_pct, 20);
  assert.equal(r.body[1].steps.length, 4);

  const cat = await s.api('GET', '/offers?category=tourism');
  assert.ok(cat.body.every((o) => o.smb.category === 'tourism'));

  const loc = await s.api('GET', '/offers?location=panama');
  assert.ok(loc.body.length >= 1);
  assert.ok(loc.body.every((o) => o.smb.location === 'Panama'));

  const none = await s.api('GET', '/offers?q=submarine%20repairs%20antarctica');
  assert.deepEqual(none.body, [], 'nonsense query returns empty array, not an error');
});

test('happy path: full Costa Rica scenario through the API', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const { api } = s;

  const search = await api('GET', '/offers?q=' + encodeURIComponent('lawyer Costa Rica company hotel'));
  const offer = search.body.find((o) => o.smb.name === 'Bufete Herrera & Asociados');
  assert.ok(offer);

  // Create engagement → draft with steps snapshotted
  const created = await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID });
  assert.equal(created.status, 201);
  const eid = created.body.id;
  assert.equal(created.body.state, 'draft');
  assert.equal(created.body.steps.length, 4);
  assert.equal(created.body.upfront_cents, 100_000);

  // Double-create guard: same draft comes back, no duplicate
  const dup = await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.id, eid);

  // Steps editable in draft…
  const stepId = created.body.steps[0].id;
  const patched = await api('PATCH', `/engagements/${eid}/steps/${stepId}`, { title: 'Incorporate S.R.L. company in Costa Rica' });
  assert.equal(patched.status, 200);

  // Agree → locked
  const agreed = await api('POST', `/engagements/${eid}/agree`, {});
  assert.equal(agreed.status, 200);
  assert.equal(agreed.body.state, 'agreed');
  const lockAttempt = await api('PATCH', `/engagements/${eid}/steps/${stepId}`, { title: 'sneaky edit' });
  assert.equal(lockAttempt.status, 409, 'steps immutable after agreement');

  // SMB cannot work before escrow is funded
  const early = await api('POST', `/engagements/${eid}/steps/${stepId}/complete`, { proof_text: 'nope' });
  assert.equal(early.status, 409);

  // Fund 20% escrow
  const funded = await api('POST', `/engagements/${eid}/fund`, {});
  assert.equal(funded.status, 200);
  assert.equal(funded.body.state, 'funded');
  assert.equal(funded.body.escrow_balance_cents, 100_000);
  assert.equal((await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents, 4_900_000);
  await invariantOk(t, api);

  // Double-fund guard
  const refund = await api('POST', `/engagements/${eid}/fund`, {});
  assert.equal(refund.status, 409);
  assert.equal((await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents, 4_900_000, 'no double spend');

  // Premature submit
  const earlySubmit = await api('POST', `/engagements/${eid}/submit`, {});
  assert.equal(earlySubmit.status, 409);

  // Proof text required
  const noProof = await api('POST', `/engagements/${eid}/steps/${stepId}/complete`, {});
  assert.equal(noProof.status, 400);

  // Complete all 4 steps with proofs
  const steps = (await api('GET', `/engagements/${eid}`)).body.steps;
  for (const [i, step] of steps.entries()) {
    const done = await api('POST', `/engagements/${eid}/steps/${step.id}/complete`, {
      proof_text: `Proof for step ${i + 1}: filing receipt #CR-${1000 + i}`,
      proof_url: i === 0 ? 'https://example.com/receipt.pdf' : undefined,
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.state, 'in_progress');
  }

  // Re-completing a done step is rejected
  const again = await api('POST', `/engagements/${eid}/steps/${stepId}/complete`, { proof_text: 'again' });
  assert.equal(again.status, 409);

  // Submit → submitted
  const submitted = await api('POST', `/engagements/${eid}/submit`, {});
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.state, 'submitted');
  assert.equal(submitted.body.steps_done, 4);

  // Approve → settlement: remaining $4,000 auto-drawn, SMB gets $5,000, escrow zero
  const approved = await api('POST', `/engagements/${eid}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.state, 'completed');
  assert.equal(approved.body.escrow_balance_cents, 0);
  assert.equal((await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents, 4_500_000);
  const bufeteProfile = await api('GET', `/smbs/${offer.smb.id}`);
  assert.equal(bufeteProfile.body.balance_cents, 500_000, 'SMB received the full $5,000');
  await invariantOk(t, api);

  // Double release impossible
  const doubleApprove = await api('POST', `/engagements/${eid}/approve`, {});
  assert.equal(doubleApprove.status, 409);
  assert.equal((await api('GET', `/smbs/${offer.smb.id}`)).body.balance_cents, 500_000);
  await invariantOk(t, api);

  // Rate good → aggregate updates and search reorders (Bufete 3 > LexCorp 2)
  const rated = await api('POST', `/engagements/${eid}/rate`, { value: 'good' });
  assert.equal(rated.status, 201);
  const dupRate = await api('POST', `/engagements/${eid}/rate`, { value: 'bad' });
  assert.equal(dupRate.status, 409, 'one rating per engagement');

  const after = await api('GET', '/offers?q=' + encodeURIComponent('lawyer Costa Rica company hotel'));
  assert.equal(after.body[0].smb.name, 'Bufete Herrera & Asociados', 'good rating reorders search results');
  assert.deepEqual(after.body[0].smb.rating, { good: 4, bad: 1, score: 3 });
});

test('dispute path: reject → arbiter split → resolved, balances correct', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const { api } = s;

  const search = await api('GET', '/offers?q=' + encodeURIComponent('company formation costa rica'));
  const offer = search.body.find((o) => o.smb.name === 'LexCorp Legal Solutions');
  assert.ok(offer);

  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});
  const funded = await api('POST', `/engagements/${e.id}/fund`, {});
  // 30% of $4,500 = $1,350
  assert.equal(funded.body.escrow_balance_cents, 135_000);
  assert.equal((await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents, 4_865_000);

  for (const step of funded.body.steps) {
    await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`, { proof_text: `done: ${step.title}` });
  }
  await api('POST', `/engagements/${e.id}/submit`, {});

  // Reject requires a reason
  assert.equal((await api('POST', `/engagements/${e.id}/reject`, {})).status, 400);
  const rejected = await api('POST', `/engagements/${e.id}/reject`, { reason: 'Corporate books were never delivered.' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.state, 'disputed');
  assert.equal(rejected.body.dispute_reason, 'Corporate books were never delivered.');

  // No approve after dispute; dispute shows up for the arbiter
  assert.equal((await api('POST', `/engagements/${e.id}/approve`, {})).status, 409);
  const disputes = await api('GET', '/disputes');
  assert.ok(disputes.body.some((d) => d.id === e.id));

  // Invalid ruling rejected
  assert.equal((await api('POST', `/engagements/${e.id}/resolve`, { ruling: 'coinflip' })).status, 400);

  // Split: $1,350 escrow → $675 each
  const resolved = await api('POST', `/engagements/${e.id}/resolve`, { ruling: 'split' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.state, 'resolved');
  assert.equal(resolved.body.resolution, 'split');
  assert.equal(resolved.body.escrow_balance_cents, 0);
  assert.equal((await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents, 4_932_500);
  assert.equal((await api('GET', `/smbs/${offer.smb.id}`)).body.balance_cents, 67_500);
  await invariantOk(t, api);

  // Double-resolve impossible
  assert.equal((await api('POST', `/engagements/${e.id}/resolve`, { ruling: 'split' })).status, 409);
  assert.equal((await api('GET', `/smbs/${offer.smb.id}`)).body.balance_cents, 67_500);

  // Rating allowed after resolution
  assert.equal((await api('POST', `/engagements/${e.id}/rate`, { value: 'bad' })).status, 201);
  await invariantOk(t, api);
});

test('arbiter rulings: release and refund move escrow correctly', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const { api } = s;

  const makeDispute = async (offerName) => {
    const search = await api('GET', '/offers');
    const offer = search.body.find((o) => o.smb.name === offerName);
    const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
    await api('POST', `/engagements/${e.id}/agree`, {});
    const funded = (await api('POST', `/engagements/${e.id}/fund`, {})).body;
    for (const step of funded.steps) {
      await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`, { proof_text: 'done' });
    }
    await api('POST', `/engagements/${e.id}/submit`, {});
    await api('POST', `/engagements/${e.id}/reject`, { reason: 'not satisfied' });
    return { e, offer, escrow: funded.escrow_balance_cents };
  };

  // release → SMB gets escrow
  const a = await makeDispute('Tico Adventures Tours'); // $1,200 @ 50% = $600 escrow
  assert.equal(a.escrow, 60_000);
  const released = await api('POST', `/engagements/${a.e.id}/resolve`, { ruling: 'release' });
  assert.equal(released.body.state, 'resolved');
  assert.equal((await api('GET', `/smbs/${a.offer.smb.id}`)).body.balance_cents, 60_000);

  // refund → agent gets escrow back
  const balBefore = (await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents;
  const b = await makeDispute('Pura Vida Realty'); // $2,000 @ 25% = $500 escrow
  const refunded = await api('POST', `/engagements/${b.e.id}/resolve`, { ruling: 'refund' });
  assert.equal(refunded.body.state, 'resolved');
  assert.equal((await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents, balBefore, 'refund restores agent balance');
  assert.equal((await api('GET', `/smbs/${b.offer.smb.id}`)).body.balance_cents, 0);
  await invariantOk(t, api);
});

test('insufficient funds: funding fails cleanly, state unchanged', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const { api } = s;

  const search = await api('GET', '/offers?q=' + encodeURIComponent('turnkey boutique hotel'));
  const offer = search.body[0];
  assert.equal(offer.price_cents, 30_000_000); // $300,000 — 20% upfront is $60,000 > $50,000 balance

  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});
  const fund = await api('POST', `/engagements/${e.id}/fund`, {});
  assert.equal(fund.status, 409);
  assert.match(fund.body.error, /insufficient funds/);

  const after = await api('GET', `/engagements/${e.id}`);
  assert.equal(after.body.state, 'agreed', 'state unchanged after failed funding');
  assert.equal((await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents, 5_000_000, 'balance untouched');
  await invariantOk(t, api);
});

test('approve fails cleanly when agent cannot cover the remainder', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const { api } = s;

  // Drain most of the agent's balance with a big engagement first: fund Island
  // Estates is impossible, so instead complete a $45,000 offer published fresh.
  const smb = (await api('POST', '/smbs', { name: 'Drain Co', category: 'legal', location: 'Costa Rica' })).body;
  const offer = (await api('POST', '/offers', {
    smb_id: smb.id, title: 'Big retainer', price_cents: 4_800_000, upfront_pct: 90,
    steps: [{ title: 'Do the work' }],
  })).body;
  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});
  await api('POST', `/engagements/${e.id}/fund`, {}); // 90% of $48,000 = $43,200 → agent left with $6,800

  // Second engagement whose remainder ($4,000) exceeds… no: agent has $6,800.
  // Fund Bufete's offer ($1,000 down, $4,000 remainder) → agent left with $5,800,
  // then fund another $4,500 offer at 30% ($1,350) → $4,450 < $4,000? No — keep it
  // simple: drain again with a second big engagement.
  const offer2 = (await api('POST', '/offers', {
    smb_id: smb.id, title: 'Second retainer', price_cents: 500_000, upfront_pct: 20,
    steps: [{ title: 'Do the work' }],
  })).body;
  const e2 = (await api('POST', '/engagements', { offer_id: offer2.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e2.id}/agree`, {});
  await api('POST', `/engagements/${e2.id}/fund`, {}); // $1,000 down → agent has $5,800
  const funded2 = await api('GET', `/engagements/${e2.id}`);
  for (const step of funded2.body.steps) {
    await api('POST', `/engagements/${e2.id}/steps/${step.id}/complete`, { proof_text: 'done' });
  }
  await api('POST', `/engagements/${e2.id}/submit`, {});

  // Drain the rest: fund a third offer so balance < $4,000 remainder of e2.
  const offer3 = (await api('POST', '/offers', {
    smb_id: smb.id, title: 'Third retainer', price_cents: 400_000, upfront_pct: 100,
    steps: [{ title: 'Do the work' }],
  })).body;
  const e3 = (await api('POST', '/engagements', { offer_id: offer3.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e3.id}/agree`, {});
  await api('POST', `/engagements/${e3.id}/fund`, {}); // $4,000 → agent has $1,800 left

  const approve = await api('POST', `/engagements/${e2.id}/approve`, {});
  assert.equal(approve.status, 409, 'approve rejected when remainder cannot be drawn');
  assert.match(approve.body.error, /insufficient funds/);
  const after = await api('GET', `/engagements/${e2.id}`);
  assert.equal(after.body.state, 'submitted', 'state unchanged; no partial settlement');
  assert.equal(after.body.escrow_balance_cents, 100_000, 'escrow untouched');
  await invariantOk(t, api);
});

test('SMB onboarding: register (auto-vetted) and publish a searchable offer', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const { api } = s;

  const reg = await api('POST', '/smbs', {
    name: 'Nuevo Notarios', category: 'legal', location: 'Costa Rica',
    description: 'Notary services', capabilities: 'notary, apostille, certified translations',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.vetted, true, 'Vetted badge auto-granted on registration');

  assert.equal((await api('POST', '/smbs', { name: 'Nuevo Notarios', category: 'legal', location: 'CR' })).status, 409);
  assert.equal((await api('POST', '/smbs', { name: 'No Category' })).status, 400);

  const offer = await api('POST', '/offers', {
    smb_id: reg.body.id, title: 'Apostille a document bundle', description: 'Fast apostille service',
    price_cents: 25_000, upfront_pct: 50,
    steps: [{ title: 'Receive documents' }, { title: 'Apostille at ministry' }, { title: 'Return bundle' }],
  });
  assert.equal(offer.status, 201);
  assert.equal(offer.body.steps.length, 3);

  assert.equal((await api('POST', '/offers', { smb_id: reg.body.id, title: 'No steps', price_cents: 100, upfront_pct: 10, steps: [] })).status, 400);

  const found = await api('GET', '/offers?q=apostille');
  assert.equal(found.body.length, 1);
  assert.equal(found.body[0].title, 'Apostille a document bundle');
});

test('search: accent-insensitive for Spanish/Portuguese queries', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const { api } = s;

  const reg = await api('POST', '/smbs', {
    name: 'Notaría Pública López', category: 'legal', location: 'São Paulo',
    description: 'Servicios de habilitación y certificación jurídica.',
    capabilities: 'habilitación, cédula jurídica, certificación',
  });
  assert.equal(reg.status, 201);
  await api('POST', '/offers', {
    smb_id: reg.body.id, title: 'Trámite de habilitación', description: 'Gestión completa.',
    price_cents: 30_000, upfront_pct: 50, steps: [{ title: 'Reunir documentos' }],
  });

  // Unaccented query finds accented text (how most people type on mobile).
  const noAccent = await api('GET', '/offers?q=' + encodeURIComponent('habilitacion juridica'));
  assert.ok(noAccent.body.some((o) => o.smb.name === 'Notaría Pública López'),
    'unaccented query matches accented offer text');

  // Accented query finds the same offer.
  const withAccent = await api('GET', '/offers?q=' + encodeURIComponent('habilitación'));
  assert.ok(withAccent.body.some((o) => o.smb.name === 'Notaría Pública López'),
    'accented query still matches');

  // Location filter is accent-insensitive too.
  const loc = await api('GET', '/offers?location=' + encodeURIComponent('sao paulo'));
  assert.ok(loc.body.some((o) => o.smb.name === 'Notaría Pública López'),
    'unaccented location filter matches "São Paulo"');
});

test('validation & 404s: bad routes, bad ids, bad JSON', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const { api, base } = s;

  assert.equal((await api('GET', '/engagements/9999')).status, 404);
  assert.equal((await api('GET', '/offers/9999')).status, 404);
  assert.equal((await api('GET', '/smbs/9999')).status, 404);
  assert.equal((await api('GET', '/nope')).status, 404);
  assert.equal((await api('POST', '/engagements', { offer_id: 9999, agent_id: 1 })).status, 404);
  assert.equal((await api('POST', '/engagements', {})).status, 400);

  const badJson = await fetch(`${base}/api/engagements`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.equal(badJson.status, 400);

  // Transitions from wrong states
  const search = await api('GET', '/offers');
  const e = (await api('POST', '/engagements', { offer_id: search.body[0].id, agent_id: AGENT_ID })).body;
  assert.equal((await api('POST', `/engagements/${e.id}/fund`, {})).status, 409, 'cannot fund a draft');
  assert.equal((await api('POST', `/engagements/${e.id}/submit`, {})).status, 409, 'cannot submit a draft');
  assert.equal((await api('POST', `/engagements/${e.id}/approve`, {})).status, 409, 'cannot approve a draft');
  assert.equal((await api('POST', `/engagements/${e.id}/rate`, { value: 'good' })).status, 409, 'cannot rate before settlement');
});

test('health check: GET /api/health on base and Pacta servers', async (t) => {
  const base = await startTestServer({ pacta: false });
  t.after(base.close);
  const baseHealth = await base.api('GET', '/health');
  assert.equal(baseHealth.status, 200);
  assert.equal(baseHealth.body.status, 'ok');
  assert.equal(baseHealth.body.plan, 'base');
  assert.equal(baseHealth.body.ledger_ok, true, 'freshly seeded database satisfies the ledger invariant');

  const pacta = await startTestServer({ pacta: true });
  t.after(pacta.close);
  const pactaHealth = await pacta.api('GET', '/health');
  assert.equal(pactaHealth.status, 200);
  assert.equal(pactaHealth.body.status, 'ok');
  assert.equal(pactaHealth.body.plan, 'pacta');
  assert.equal(pactaHealth.body.ledger_ok, true);
});
