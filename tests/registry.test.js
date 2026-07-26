'use strict';
// Registry adapters: the local reference adapter, the generic http adapter
// against a scripted endpoint, the Hacienda CR mapping, env selection, and the
// end-to-end proof flow with an external registry plugged in.
const http = require('node:http');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { openDb } = require('../src/db');
const { seedIfEmpty } = require('../src/seed');
const {
  createRegistryAdapter, LocalRegistryAdapter, HttpRegistryAdapter,
  HaciendaCrAdapter, RegistryUnavailableError,
} = require('../src/registry');

const AGENT_ID = 1;

// Scripted external registry: answers from a plain object keyed by ref.
// `behavior` lets a test force error modes (500, non-JSON, hang).
function startMockRegistry(records, { behavior = 'normal' } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (behavior === 'hang') return; // never answer, let the client time out
      if (behavior === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'upstream exploded' }));
      }
      if (behavior === 'garbage') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>not json</html>');
      }
      const ref = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
      const record = records[ref];
      if (!record) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ref, ...record }));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('local adapter reads the seeded registry_records table', async () => {
  const db = openDb(':memory:');
  seedIfEmpty(db, { pacta: true });
  const adapter = new LocalRegistryAdapter(db);
  const record = await adapter.lookup('CR-RN-2026-104512');
  assert.equal(record.kind, 'incorporation');
  assert.equal(record.source, 'local');
  assert.equal(await adapter.lookup('NOPE-1'), null);
});

test('adapter selection: default local, REGISTRY_URL implies http, REGISTRY_ADAPTER forces', async () => {
  const db = openDb(':memory:');
  assert.equal(createRegistryAdapter(db, {}).name, 'local');
  assert.equal(createRegistryAdapter(db, { REGISTRY_URL: 'http://x' }).name, 'http');
  assert.equal(createRegistryAdapter(db, { REGISTRY_ADAPTER: 'hacienda-cr' }).name, 'hacienda-cr');
  assert.equal(createRegistryAdapter(db, { REGISTRY_ADAPTER: 'local', REGISTRY_URL: 'http://x' }).name, 'local');
  assert.throws(() => createRegistryAdapter(db, { REGISTRY_ADAPTER: 'blockchain' }), /unknown REGISTRY_ADAPTER/);
  assert.throws(() => createRegistryAdapter(db, { REGISTRY_ADAPTER: 'http' }), /requires REGISTRY_URL/);
});

test('http adapter: found, missing, and the three ways a registry can fail', async (t) => {
  const mock = await startMockRegistry({
    'EXT-2026-1': { kind: 'incorporation', title: 'External incorporation record' },
    'EXT-BAD': { kind: 42, title: 'kind is not a string' },
  });
  t.after(mock.close);
  const adapter = new HttpRegistryAdapter({ baseUrl: mock.url });

  const record = await adapter.lookup('EXT-2026-1');
  assert.equal(record.kind, 'incorporation');
  assert.equal(record.source, 'http');
  assert.equal(await adapter.lookup('EXT-MISSING'), null);
  await assert.rejects(() => adapter.lookup('EXT-BAD'), RegistryUnavailableError);

  const err500 = await startMockRegistry({}, { behavior: 'error' });
  t.after(err500.close);
  await assert.rejects(
    () => new HttpRegistryAdapter({ baseUrl: err500.url }).lookup('X'),
    /answered 500/,
  );

  const garbage = await startMockRegistry({}, { behavior: 'garbage' });
  t.after(garbage.close);
  await assert.rejects(
    () => new HttpRegistryAdapter({ baseUrl: garbage.url }).lookup('X'),
    /non-JSON/,
  );

  const hang = await startMockRegistry({}, { behavior: 'hang' });
  t.after(hang.close);
  await assert.rejects(
    () => new HttpRegistryAdapter({ baseUrl: hang.url, timeoutMs: 200 }).lookup('X'),
    RegistryUnavailableError,
  );
});

test('hacienda-cr adapter maps the tax authority response to a registry record', async (t) => {
  // Scripted stand-in for api.hacienda.go.cr/fe/ae so the test stays offline.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('identificacion') === '3101123456') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        nombre: 'MEDVOYAGE ANDINA SOCIEDAD ANONIMA',
        tipoIdentificacion: '02',
        situacion: { moroso: 'NO', omiso: 'NO', estado: 'Inscrito' },
        actividades: [
          { estado: 'A', codigo: '862092', descripcion: 'ACTIVIDADES DE TURISMO DE SALUD' },
          { estado: 'I', codigo: '999999', descripcion: 'INACTIVE ONE' },
        ],
      }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const adapter = new HaciendaCrAdapter({ baseUrl: `http://127.0.0.1:${server.address().port}` });

  // Dashes in the cedula are accepted and normalized for the query.
  const record = await adapter.lookup('3-101-123456');
  assert.equal(record.kind, 'tax_registration');
  assert.equal(record.ref, '3-101-123456');
  assert.match(record.title, /MEDVOYAGE/);
  assert.match(record.details, /estado: Inscrito/);
  assert.match(record.details, /TURISMO DE SALUD/);
  assert.ok(!record.details.includes('INACTIVE ONE'), 'inactive activities are dropped');

  assert.equal(await adapter.lookup('3-101-999999'), null, 'unknown cedula');
  // A non-cedula reference is answered locally, without touching the network.
  const offline = new HaciendaCrAdapter({ baseUrl: 'http://127.0.0.1:1' });
  assert.equal(await offline.lookup('CR-RN-2026-104512'), null);
});

test('end to end: proofs verify against an external registry adapter', async (t) => {
  const mock = await startMockRegistry({
    'EXT-INC-1': { kind: 'incorporation', title: 'External incorporation' },
    'EXT-LAND-1': { kind: 'land_eligibility', title: 'External land eligibility' },
    'EXT-PERMIT-1': { kind: 'permit', title: 'External permit' },
    'EXT-TAX-1': { kind: 'tax_filing', title: 'External tax filing' },
  });
  t.after(mock.close);
  const s = await startTestServer({
    pacta: true,
    registry: new HttpRegistryAdapter({ baseUrl: mock.url }),
  });
  t.after(s.close);
  const { api } = s;

  assert.equal((await api('GET', '/config')).body.registry_adapter, 'http');

  const legal = (await api('GET', '/offers?q=lawyer+costa+rica+company+hotel')).body;
  const offer = legal.find((o) => o.smb.name === 'Bufete Herrera & Asociados');
  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});
  await api('POST', `/engagements/${e.id}/fund`, {});

  // The seeded local refs no longer exist: the external registry is the truth now.
  const steps = (await api('GET', `/engagements/${e.id}`)).body.steps;
  const seededRef = await api('POST', `/engagements/${e.id}/steps/${steps[0].id}/complete`, {
    proof_text: 'done', registry_ref: 'CR-RN-2026-104512',
  });
  assert.equal(seededRef.status, 409, 'local seed refs are not in the external registry');

  const extRefs = { 1: 'EXT-INC-1', 2: 'EXT-LAND-1', 3: 'EXT-PERMIT-1', 4: 'EXT-TAX-1' };
  for (const step of steps) {
    const r = await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`, {
      proof_text: `done: ${step.title}`, registry_ref: extRefs[step.position],
    });
    assert.equal(r.status, 200, `step ${step.position}: ${JSON.stringify(r.body)}`);
    const done = r.body.steps.find((x) => x.id === step.id);
    assert.equal(done.proof_verified, true);
  }

  // Registry lookup route serves the external record and reports its source.
  const rec = await api('GET', '/registry/EXT-INC-1');
  assert.equal(rec.status, 200);
  assert.equal(rec.body.source, 'http');
});

test('an unreachable registry surfaces as 502, never as a verified or rejected proof', async (t) => {
  const down = await startMockRegistry({}, { behavior: 'error' });
  t.after(down.close);
  const s = await startTestServer({
    pacta: true,
    registry: new HttpRegistryAdapter({ baseUrl: down.url }),
  });
  t.after(s.close);
  const { api } = s;

  const legal = (await api('GET', '/offers?q=lawyer+costa+rica+company+hotel')).body;
  const offer = legal.find((o) => o.smb.name === 'Bufete Herrera & Asociados');
  const e = (await api('POST', '/engagements', { offer_id: offer.id, agent_id: AGENT_ID })).body;
  await api('POST', `/engagements/${e.id}/agree`, {});
  await api('POST', `/engagements/${e.id}/fund`, {});
  const steps = (await api('GET', `/engagements/${e.id}`)).body.steps;

  const r = await api('POST', `/engagements/${e.id}/steps/${steps[0].id}/complete`, {
    proof_text: 'done', registry_ref: 'ANY-REF',
  });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /registry endpoint answered 500/);
  const after = (await api('GET', `/engagements/${e.id}`)).body.steps[0];
  assert.equal(after.status, 'pending', 'step untouched when the registry is down');

  assert.equal((await api('GET', '/registry/ANY-REF')).status, 502);
});
