'use strict';
// Provider-side bot for the agent demo: plays the SMBs. Watches the marketplace
// for funded engagements, "does the work" (marks steps complete with proofs —
// including the correct public-registry references for registry-anchored steps),
// and submits for verification. In production this is the SMB's own back office.
const BASE = (process.env.MARKETPLACE_URL || 'http://localhost:3230').replace(/\/$/, '');
const STEP_DELAY_MS = Number(process.env.SMB_BOT_STEP_DELAY_MS || 400);

// The demo SMB's "filing receipts" — references produced by actually doing the
// work at each authority. Seeded in the mock public registry.
const RECEIPTS = {
  incorporation: 'CR-RN-2026-104512',
  land_eligibility: 'CR-RN-2026-104513',
  permit: 'CR-MUNI-SJ-88231',
  tax_filing: 'CR-HAC-2026-55710',
};

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `${method} ${path} → ${res.status}`);
  return data;
}

const log = (msg) => console.log(`[smb-bot] ${msg}`);

async function workOn(e) {
  log(`engagement #${e.id} is funded — ${e.smb.name} starts work on "${e.title}"`);
  for (const step of e.steps) {
    if (step.status === 'done') continue;
    await new Promise((r) => setTimeout(r, STEP_DELAY_MS)); // simulated real-world work
    const body = {
      proof_text: `Completed: ${step.title}.` + (step.verification_kind
        ? ` Official filing reference: ${RECEIPTS[step.verification_kind]}.`
        : ' Deliverable sent to client.'),
    };
    if (step.verification_kind) body.registry_ref = RECEIPTS[step.verification_kind];
    await api('POST', `/engagements/${e.id}/steps/${step.id}/complete`, body);
    log(`  step ${step.position}/${e.steps.length} done: ${step.title}${body.registry_ref ? ` (registry ${body.registry_ref})` : ''}`);
  }
  await api('POST', `/engagements/${e.id}/submit`, {});
  log(`engagement #${e.id} submitted for the agent's verification`);
}

(async () => {
  log(`watching ${BASE} for funded engagements...`);
  const busy = new Set();
  for (;;) {
    try {
      const funded = await api('GET', '/engagements?state=funded');
      const inProgress = await api('GET', '/engagements?state=in_progress');
      for (const e of [...funded, ...inProgress]) {
        if (busy.has(e.id)) continue;
        busy.add(e.id);
        workOn(e).catch((err) => { log(`error on #${e.id}: ${err.message}`); busy.delete(e.id); });
      }
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
})();
