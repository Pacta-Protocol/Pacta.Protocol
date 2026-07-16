'use strict';
// Pacta: staking-based vetting, graduated exposure caps, slashing, and
// registry-anchored proof verification. Servers run with { pacta: true }.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

const AGENT_ID = 1;

async function invariantOk(api) {
  const inv = await api('GET', '/ledger/invariant');
  assert.equal(inv.body.ok, true, `ledger invariant broken: ${JSON.stringify(inv.body)}`);
}

// Drives an engagement to `submitted`. Steps get valid registry refs when required.
async function driveToSubmitted(api, offerId, registryRefsByPosition = {}) {
  const e = (await api('POST', '/engagements', { offer_id: offerId, agent_id: AGENT_ID })).body;
  assert.equal((await api('POST', `/engagements/${e.id}/agree`, {})).status, 200);
  assert.equal((await api('POST', `/engagements/${e.id}/fund`, {})).status, 200);
  const steps = (await api('GET', `/engagements/${e.id}`)).body.steps;
  for (const step of steps) {
    const body = { proof_text: `done: ${step.title}` };
    if (registryRefsByPosition[step.position]) body.registry_ref = registryRefsByPosition[step.position];
    const r = await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`, body);
    assert.equal(r.status, 200, `step ${step.position} failed: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await api('POST', `/engagements/${e.id}/submit`, {})).status, 200);
  return e;
}

const BUFETE_REFS = {
  1: 'CR-RN-2026-104512', 2: 'CR-RN-2026-104513', 3: 'CR-MUNI-SJ-88231', 4: 'CR-HAC-2026-55710',
};

test('config + agent manifest expose the Pacta surface', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);

  const config = await s.api('GET', '/config');
  assert.equal(config.body.plan, 'pacta');
  assert.equal(config.body.features.staking, true);
  assert.equal(config.body.features.registry_verification, true);

  const manifest = await s.api('GET', '/agent/manifest');
  assert.equal(manifest.status, 200);
  const names = manifest.body.tools.map((x) => x.name);
  for (const expected of ['search_offers', 'create_engagement', 'fund_escrow', 'approve', 'registry_lookup']) {
    assert.ok(names.includes(expected), `manifest missing tool ${expected}`);
  }

  // The base build still reports plan "base" and hides staking
  const a = await startTestServer({ pacta: false });
  t.after(a.close);
  assert.equal((await a.api('GET', '/config')).body.plan, 'base');
  assert.equal((await a.api('POST', '/smbs/1/stake', { amount_cents: 100 })).status, 404);
});

test('vetting is collateral: stakes seeded, unvetted SMB cannot be contracted', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  const smbs = (await api('GET', '/smbs')).body;
  const bufete = smbs.find((x) => x.name === 'Bufete Herrera & Asociados');
  assert.equal(bufete.vetted, true);
  assert.equal(bufete.stake_cents, 150_000);
  assert.equal(bufete.exposure_cap_cents, 750_000, 'cap = 5 × $1,500 stake');

  const unvetted = smbs.find((x) => x.name === 'Despacho Sin Garantía');
  assert.ok(unvetted, 'unvetted demo SMB seeded');
  assert.equal(unvetted.vetted, false);
  assert.equal(unvetted.stake_cents, 0);

  const offers = (await api('GET', '/offers?q=budget+company+formation')).body;
  const cheapOffer = offers.find((o) => o.smb.id === unvetted.id);
  assert.ok(cheapOffer, 'unvetted SMB offer still searchable (visibly marked in UI)');
  const attempt = await api('POST', '/engagements', { offer_id: cheapOffer.id, agent_id: AGENT_ID });
  assert.equal(attempt.status, 409);
  assert.match(attempt.body.error, /not vetted/);

  // Posting a stake grants the badge and unlocks contracting
  const staked = await api('POST', `/smbs/${unvetted.id}/stake`, { amount_cents: 20_000 });
  assert.equal(staked.status, 201);
  assert.equal(staked.body.vetted, true);
  assert.equal(staked.body.exposure_cap_cents, 100_000);
  assert.equal((await api('POST', '/engagements', { offer_id: cheapOffer.id, agent_id: AGENT_ID })).status, 201);
  await invariantOk(api);
});

test('graduated exposure cap: big contracts must be earned', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  // Island Estates: $5,000 stake → $25,000 cap; its $300,000 offer cannot be agreed.
  const offers = (await api('GET', '/offers?q=turnkey+boutique+hotel')).body;
  const island = offers[0];
  const e = (await api('POST', '/engagements', { offer_id: island.id, agent_id: AGENT_ID })).body;
  const agree = await api('POST', `/engagements/${e.id}/agree`, {});
  assert.equal(agree.status, 409);
  assert.match(agree.body.error, /exposure cap exceeded/);
  assert.equal((await api('GET', `/engagements/${e.id}`)).body.state, 'draft', 'state unchanged');

  // Bufete ($7,500 cap): first $5,000 engagement fits, a second one does not.
  const legal = (await api('GET', '/offers?q=lawyer+costa+rica+company+hotel')).body;
  const bufeteOffer = legal.find((o) => o.smb.name === 'Bufete Herrera & Asociados');
  const e1 = (await api('POST', '/engagements', { offer_id: bufeteOffer.id, agent_id: AGENT_ID })).body;
  assert.equal((await api('POST', `/engagements/${e1.id}/agree`, {})).status, 200);
  const e2 = (await api('POST', '/engagements', { offer_id: bufeteOffer.id, agent_id: AGENT_ID })).body;
  assert.notEqual(e2.id, e1.id, 'second draft created (first is no longer draft)');
  const overCap = await api('POST', `/engagements/${e2.id}/agree`, {});
  assert.equal(overCap.status, 409, '$10,000 active would exceed the $7,500 cap');
  assert.match(overCap.body.error, /exposure cap/);

  // Completing work grows the cap: settle e1, then e2 fits (cap = 7,500 + 2,500).
  await api('POST', `/engagements/${e1.id}/fund`, {});
  const steps = (await api('GET', `/engagements/${e1.id}`)).body.steps;
  for (const step of steps) {
    await api('POST', `/engagements/${e1.id}/steps/${step.id}/complete`, {
      proof_text: `done: ${step.title}`, registry_ref: BUFETE_REFS[step.position],
    });
  }
  await api('POST', `/engagements/${e1.id}/submit`, {});
  assert.equal((await api('POST', `/engagements/${e1.id}/approve`, {})).status, 200);
  const bufete = (await api('GET', `/smbs/${bufeteOffer.smb.id}`)).body;
  assert.equal(bufete.exposure_cap_cents, 750_000 + 250_000, 'completed GMV grew the cap');
  assert.equal((await api('POST', `/engagements/${e2.id}/agree`, {})).status, 200, 'earned headroom');
  await invariantOk(api);
});

test('registry-anchored proofs: evidence must verify against the public registry', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  const legal = (await api('GET', '/offers?q=lawyer+costa+rica+company+hotel')).body;
  const offer = legal.find((o) => o.smb.name === 'Bufete Herrera & Asociados');
  assert.equal(offer.steps[0].verification_kind, 'incorporation');

  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});
  await api('POST', `/engagements/${e.id}/fund`, {});
  const step1 = (await api('GET', `/engagements/${e.id}`)).body.steps[0];

  // Missing ref → 400 with the required kind in the message
  const missing = await api('POST', `/engagements/${e.id}/steps/${step1.id}/complete`, { proof_text: 'done' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /registry reference.*incorporation/);

  // Unknown ref → 409
  const unknown = await api('POST', `/engagements/${e.id}/steps/${step1.id}/complete`, {
    proof_text: 'done', registry_ref: 'CR-FAKE-000',
  });
  assert.equal(unknown.status, 409);
  assert.match(unknown.body.error, /not found in the public registry/);

  // Wrong kind (valid record, different type) → 409
  const wrongKind = await api('POST', `/engagements/${e.id}/steps/${step1.id}/complete`, {
    proof_text: 'done', registry_ref: 'CR-MUNI-SJ-88231',
  });
  assert.equal(wrongKind.status, 409);
  assert.match(wrongKind.body.error, /requires 'incorporation'/);

  // Valid ref → verified proof
  const ok = await api('POST', `/engagements/${e.id}/steps/${step1.id}/complete`, {
    proof_text: 'S.R.L. incorporated', registry_ref: 'CR-RN-2026-104512',
  });
  assert.equal(ok.status, 200);
  const done = ok.body.steps.find((x) => x.id === step1.id);
  assert.equal(done.proof_verified, true);
  assert.equal(done.proof_registry_ref, 'CR-RN-2026-104512');

  // Public registry lookup endpoint
  const rec = await api('GET', '/registry/CR-RN-2026-104512');
  assert.equal(rec.status, 200);
  assert.equal(rec.body.kind, 'incorporation');
  assert.equal((await api('GET', '/registry/NOPE-1')).status, 404);
});

test('slashing: losing a dispute costs stake; zero stake un-vets the SMB', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  // LexCorp: $1,000 stake. Dispute a $4,500 engagement, arbiter refunds the agent →
  // slash = min(stake, 20% × $4,500 = $900) = $900.
  const offers = (await api('GET', '/offers?q=company+formation+costa+rica')).body;
  const offer = offers.find((o) => o.smb.name === 'LexCorp Legal Solutions');
  const e = await driveToSubmitted(api, offer.id);
  await api('POST', `/engagements/${e.id}/reject`, { reason: 'Deliverables do not match the proofs.' });

  const agentBefore = (await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents;
  const resolved = await api('POST', `/engagements/${e.id}/resolve`, { ruling: 'refund' });
  assert.equal(resolved.status, 200);

  const lex = (await api('GET', `/smbs/${offer.smb.id}`)).body;
  assert.equal(lex.stake_cents, 100_000 - 90_000, 'stake slashed by $900');
  assert.equal(lex.vetted, true, 'still vetted: $100 stake remains');
  // Agent got escrow refund ($1,350) + slash compensation ($900)
  assert.equal(
    (await api('GET', `/agents/${AGENT_ID}`)).body.balance_cents,
    agentBefore + 135_000 + 90_000,
  );
  await invariantOk(api);

  // With only $100 stake left, the cap ($500) correctly blocks a new $4,500
  // engagement — the mechanism working as designed:
  const capBlocked = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  const blockedAgree = await api('POST', `/engagements/${capBlocked.id}/agree`, {});
  assert.equal(blockedAgree.status, 409);
  assert.match(blockedAgree.body.error, /exposure cap/);

  // LexCorp tops up to exactly $900 (cap $4,500) — a second lost dispute
  // (slash = min(stake, 20% × $4,500) = $900) zeroes the stake and un-vets it.
  await api('POST', `/smbs/${offer.smb.id}/stake`, { amount_cents: 80_000 });
  const e2 = await driveToSubmitted(api, offer.id);
  await api('POST', `/engagements/${e2.id}/reject`, { reason: 'Again.' });
  await api('POST', `/engagements/${e2.id}/resolve`, { ruling: 'refund' });
  const lexAfter = (await api('GET', `/smbs/${offer.smb.id}`)).body;
  assert.equal(lexAfter.stake_cents, 0);
  assert.equal(lexAfter.vetted, false, 'zero stake → vetted badge revoked');
  const blocked = await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID });
  assert.equal(blocked.status, 409, 'no new engagements without stake');
  await invariantOk(api);
});

test('split ruling slashes 10%; release ruling slashes nothing', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  // Tico Adventures: $500 stake, $1,200 offer → split slash = 10% × $1,200 = $120.
  const tico = (await api('GET', '/offers?q=eco-tour+itinerary')).body[0];
  const e = await driveToSubmitted(api, tico.id);
  await api('POST', `/engagements/${e.id}/reject`, { reason: 'Half the bookings missing.' });
  await api('POST', `/engagements/${e.id}/resolve`, { ruling: 'split' });
  assert.equal((await api('GET', `/smbs/${tico.smb.id}`)).body.stake_cents, 50_000 - 12_000);

  // Pura Vida: release ruling → stake intact.
  const pv = (await api('GET', '/offers?q=beachfront+land+scouting')).body[0];
  const e2 = await driveToSubmitted(api, pv.id);
  await api('POST', `/engagements/${e2.id}/reject`, { reason: 'Not convinced.' });
  await api('POST', `/engagements/${e2.id}/resolve`, { ruling: 'release' });
  assert.equal((await api('GET', `/smbs/${pv.smb.id}`)).body.stake_cents, 50_000, 'release: SMB won, no slash');
  await invariantOk(api);
});

test('Pacta registration: stake optional at signup, vetted only when posted', async (t) => {
  const s = await startTestServer({ pacta: true });
  t.after(s.close);
  const { api } = s;

  const noStake = await api('POST', '/smbs', { name: 'Zero Collateral Co', category: 'legal', location: 'Costa Rica' });
  assert.equal(noStake.status, 201);
  assert.equal(noStake.body.vetted, false, 'no free badge in Pacta');

  const withStake = await api('POST', '/smbs', {
    name: 'Bonded Legal SA', category: 'legal', location: 'Costa Rica', stake_cents: 50_000,
  });
  assert.equal(withStake.body.vetted, true);
  assert.equal(withStake.body.stake_cents, 50_000);
  assert.equal(withStake.body.exposure_cap_cents, 250_000);
  await invariantOk(api);
});

test('Plan A regression: no staking fields, free vetted badge, no registry gating', async (t) => {
  const s = await startTestServer({ pacta: false });
  t.after(s.close);
  const { api } = s;

  const smbs = (await api('GET', '/smbs')).body;
  assert.ok(smbs.every((x) => x.vetted === true), 'Plan A: everyone vetted');
  assert.ok(smbs.every((x) => x.stake_cents === undefined), 'Plan A: no stake fields');
  assert.ok(!smbs.some((x) => x.name === 'Despacho Sin Garantía'), 'unvetted demo SMB is Pacta-only');

  // Bufete's steps carry no verification requirement in Plan A
  const legal = (await api('GET', '/offers?q=lawyer+costa+rica+company+hotel')).body;
  const offer = legal.find((o) => o.smb.name === 'Bufete Herrera & Asociados');
  assert.ok(offer.steps.every((x) => x.verification_kind === null));

  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});
  await api('POST', `/engagements/${e.id}/fund`, {});
  const step1 = (await api('GET', `/engagements/${e.id}`)).body.steps[0];
  const done = await api('POST', `/engagements/${e.id}/steps/${step1.id}/complete`, { proof_text: 'plain proof' });
  assert.equal(done.status, 200, 'Plan A: text proof suffices');
});
