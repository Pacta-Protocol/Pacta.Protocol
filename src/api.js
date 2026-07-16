'use strict';
const express = require('express');
const { withTx } = require('./db');
const {
  LedgerError, getOrCreateAccount, getAccount, transfer, checkInvariant,
} = require('./ledger');
const staking = require('./staking');

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Engagement lifecycle. Every transition is validated here, server-side —
// the UI is never trusted.
//   draft → agreed → funded → in_progress → submitted → completed
//                                                     ↘ disputed → resolved
const TRANSITIONS = {
  agree: { from: ['draft'], to: 'agreed' },
  fund: { from: ['agreed'], to: 'funded' },
  submit: { from: ['in_progress'], to: 'submitted' },
  approve: { from: ['submitted'], to: 'completed' },
  reject: { from: ['submitted'], to: 'disputed' },
  resolve: { from: ['disputed'], to: 'resolved' },
};

function createApiRouter(db, { pacta = false } = {}) {
  const router = express.Router();
  router.use(express.json());

  // ---------- helpers --------------------------------------------------------

  const ratingsBySmb = () => {
    const rows = db.prepare(
      `SELECT smb_id,
              SUM(CASE WHEN value = 'good' THEN 1 ELSE 0 END) AS good,
              SUM(CASE WHEN value = 'bad' THEN 1 ELSE 0 END) AS bad
       FROM ratings GROUP BY smb_id`,
    ).all();
    const map = new Map();
    for (const r of rows) {
      const good = Number(r.good); const bad = Number(r.bad);
      map.set(Number(r.smb_id), { good, bad, score: good - bad });
    }
    return map;
  };

  const smbPublic = (smb, ratings) => {
    const r = (ratings || ratingsBySmb()).get(Number(smb.id)) || { good: 0, bad: 0, score: 0 };
    const base = {
      id: Number(smb.id),
      name: smb.name,
      category: smb.category,
      location: smb.location,
      description: smb.description,
      capabilities: smb.capabilities,
      vetted: Boolean(smb.vetted),
      rating: r,
    };
    if (pacta) {
      base.stake_cents = staking.stakeBalanceCents(db, smb.id);
      base.exposure_cap_cents = staking.exposureCapCents(db, smb.id);
      base.active_exposure_cents = staking.activeExposureCents(db, smb.id);
    }
    return base;
  };

  const offerSteps = (offerId) => db.prepare(
    'SELECT id, position, title, description, verification_kind FROM offer_steps WHERE offer_id = ? ORDER BY position',
  ).all(offerId).map((s) => ({ ...s, id: Number(s.id), position: Number(s.position) }));

  const offerPublic = (offer, ratings) => {
    const smb = db.prepare('SELECT * FROM smbs WHERE id = ?').get(offer.smb_id);
    return {
      id: Number(offer.id),
      title: offer.title,
      description: offer.description,
      price_cents: Number(offer.price_cents),
      upfront_pct: Number(offer.upfront_pct),
      active: Boolean(offer.active),
      steps: offerSteps(offer.id),
      smb: smbPublic(smb, ratings),
    };
  };

  const getEngagementOr404 = (id) => {
    const e = db.prepare('SELECT * FROM engagements WHERE id = ?').get(id);
    if (!e) throw new ApiError(404, `engagement ${id} not found`);
    return e;
  };

  const engagementSteps = (engagementId) => db.prepare(
    'SELECT * FROM engagement_steps WHERE engagement_id = ? ORDER BY position',
  ).all(engagementId).map((s) => ({
    id: Number(s.id),
    position: Number(s.position),
    title: s.title,
    description: s.description,
    status: s.status,
    proof_text: s.proof_text,
    proof_url: s.proof_url,
    completed_at: s.completed_at,
    verification_kind: s.verification_kind,
    proof_registry_ref: s.proof_registry_ref,
    proof_verified: Boolean(s.proof_verified),
  }));

  const engagementPublic = (e) => {
    const steps = engagementSteps(e.id);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(e.agent_id);
    const smb = db.prepare('SELECT * FROM smbs WHERE id = ?').get(e.smb_id);
    const escrow = getAccount(db, 'escrow', e.id);
    const rating = db.prepare('SELECT value FROM ratings WHERE engagement_id = ?').get(e.id);
    const priceCents = Number(e.price_cents);
    const upfrontCents = Math.round((priceCents * Number(e.upfront_pct)) / 100);
    return {
      id: Number(e.id),
      offer_id: Number(e.offer_id),
      title: e.title,
      state: e.state,
      price_cents: priceCents,
      upfront_pct: Number(e.upfront_pct),
      upfront_cents: upfrontCents,
      remaining_cents: priceCents - upfrontCents,
      dispute_reason: e.dispute_reason,
      resolution: e.resolution,
      rating: rating ? rating.value : null,
      agent: { id: Number(agent.id), name: agent.name },
      smb: { id: Number(smb.id), name: smb.name },
      escrow_balance_cents: escrow ? Number(escrow.balance_cents) : 0,
      steps,
      steps_done: steps.filter((s) => s.status === 'done').length,
      steps_total: steps.length,
      created_at: e.created_at,
      updated_at: e.updated_at,
    };
  };

  const assertTransition = (engagement, action) => {
    const t = TRANSITIONS[action];
    if (!t.from.includes(engagement.state)) {
      throw new ApiError(
        409,
        `cannot ${action} an engagement in state '${engagement.state}' (allowed from: ${t.from.join(', ')})`,
      );
    }
    return t.to;
  };

  const setState = (id, state, extra = {}) => {
    const sets = ["state = ?", "updated_at = datetime('now')"];
    const params = [state];
    for (const [col, val] of Object.entries(extra)) {
      sets.push(`${col} = ?`);
      params.push(val);
    }
    params.push(id);
    db.prepare(`UPDATE engagements SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  };

  const requireBody = (req, fields) => {
    const body = req.body || {};
    for (const f of fields) {
      if (body[f] === undefined || body[f] === null || body[f] === '') {
        throw new ApiError(400, `missing required field: ${f}`);
      }
    }
    return body;
  };

  // ---------- config / plan flags ----------------------------------------------

  router.get('/config', (req, res) => {
    res.json({
      plan: pacta ? 'pacta' : 'base',
      features: {
        staking: pacta,
        registry_verification: pacta,
        agent_manifest: true,
      },
    });
  });

  // ---------- users / roles ---------------------------------------------------

  router.get('/users', (req, res) => {
    const ratings = ratingsBySmb();
    res.json({
      agents: db.prepare('SELECT * FROM agents ORDER BY id').all().map((a) => ({
        id: Number(a.id), name: a.name,
        balance_cents: Number((getAccount(db, 'agent', a.id) || { balance_cents: 0 }).balance_cents),
      })),
      smbs: db.prepare('SELECT * FROM smbs ORDER BY id').all().map((s) => smbPublic(s, ratings)),
      arbiters: db.prepare('SELECT * FROM arbiters ORDER BY id').all().map((a) => ({ id: Number(a.id), name: a.name })),
    });
  });

  router.get('/agents/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!a) throw new ApiError(404, 'agent not found');
    const acct = getAccount(db, 'agent', a.id);
    res.json({ id: Number(a.id), name: a.name, balance_cents: acct ? Number(acct.balance_cents) : 0 });
  });

  // ---------- SMB onboarding --------------------------------------------------

  router.post('/smbs', (req, res) => {
    const body = requireBody(req, ['name', 'category', 'location']);
    const existing = db.prepare('SELECT id FROM smbs WHERE name = ?').get(body.name);
    if (existing) throw new ApiError(409, `an SMB named '${body.name}' already exists`);
    // Plan A: vetting is dummied — the badge is auto-granted at registration.
    // Pacta: vetted only by posting a stake (capital at risk), here or later.
    const stakeCents = pacta ? Number(body.stake_cents || 0) : 0;
    if (pacta && (!Number.isInteger(stakeCents) || stakeCents < 0)) {
      throw new ApiError(400, 'stake_cents must be a non-negative integer');
    }
    const id = withTx(db, () => {
      const info = db.prepare(
        'INSERT INTO smbs (name, category, location, description, capabilities, vetted) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(body.name, body.category, body.location, body.description || '', body.capabilities || '',
        pacta ? (stakeCents > 0 ? 1 : 0) : 1);
      const smbId = Number(info.lastInsertRowid);
      getOrCreateAccount(db, 'smb', smbId);
      if (pacta && stakeCents > 0) {
        staking.depositStake(db, smbId, stakeCents, `initial stake for '${body.name}'`);
      }
      return smbId;
    });
    res.status(201).json(smbPublic(db.prepare('SELECT * FROM smbs WHERE id = ?').get(id)));
  });

  // Pacta: post (more) stake — a simulated external deposit into the SMB's
  // collateral account. Restores/grants the vetted badge.
  router.post('/smbs/:id/stake', (req, res) => {
    if (!pacta) throw new ApiError(404, 'staking is a Pacta feature');
    const smb = db.prepare('SELECT * FROM smbs WHERE id = ?').get(req.params.id);
    if (!smb) throw new ApiError(404, 'SMB not found');
    const body = requireBody(req, ['amount_cents']);
    const amount = Number(body.amount_cents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ApiError(400, 'amount_cents must be a positive integer');
    }
    withTx(db, () => staking.depositStake(db, smb.id, amount, `stake top-up for '${smb.name}'`));
    res.status(201).json(smbPublic(db.prepare('SELECT * FROM smbs WHERE id = ?').get(smb.id)));
  });

  router.get('/smbs', (req, res) => {
    const ratings = ratingsBySmb();
    res.json(db.prepare('SELECT * FROM smbs ORDER BY id').all().map((s) => smbPublic(s, ratings)));
  });

  router.get('/smbs/:id', (req, res) => {
    const smb = db.prepare('SELECT * FROM smbs WHERE id = ?').get(req.params.id);
    if (!smb) throw new ApiError(404, 'SMB not found');
    const acct = getAccount(db, 'smb', smb.id);
    const offers = db.prepare('SELECT * FROM offers WHERE smb_id = ? ORDER BY id').all(smb.id);
    res.json({
      ...smbPublic(smb),
      balance_cents: acct ? Number(acct.balance_cents) : 0,
      offers: offers.map((o) => offerPublic(o)),
    });
  });

  // ---------- offers: publish + search ---------------------------------------

  router.post('/offers', (req, res) => {
    const body = requireBody(req, ['smb_id', 'title', 'price_cents', 'upfront_pct']);
    const smb = db.prepare('SELECT * FROM smbs WHERE id = ?').get(body.smb_id);
    if (!smb) throw new ApiError(404, 'SMB not found');
    const price = Number(body.price_cents);
    const upfront = Number(body.upfront_pct);
    if (!Number.isInteger(price) || price <= 0) throw new ApiError(400, 'price_cents must be a positive integer');
    if (!Number.isInteger(upfront) || upfront < 0 || upfront > 100) throw new ApiError(400, 'upfront_pct must be 0-100');
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (steps.length === 0) throw new ApiError(400, 'an offer needs at least one step');
    for (const s of steps) {
      if (!s || typeof s.title !== 'string' || !s.title.trim()) throw new ApiError(400, 'every step needs a title');
    }
    const id = withTx(db, () => {
      const info = db.prepare(
        'INSERT INTO offers (smb_id, title, description, price_cents, upfront_pct) VALUES (?, ?, ?, ?, ?)',
      ).run(smb.id, body.title, body.description || '', price, upfront);
      const offerId = Number(info.lastInsertRowid);
      steps.forEach((s, i) => {
        db.prepare('INSERT INTO offer_steps (offer_id, position, title, description) VALUES (?, ?, ?, ?)')
          .run(offerId, i + 1, s.title.trim(), (s.description || '').trim());
      });
      return offerId;
    });
    res.status(201).json(offerPublic(db.prepare('SELECT * FROM offers WHERE id = ?').get(id)));
  });

  // Search: q keywords are ANDed, case-insensitive, matched across the offer text,
  // its steps, and the SMB profile. Ranked by SMB rating score desc, then price asc.
  router.get('/offers', (req, res) => {
    const ratings = ratingsBySmb();
    const q = String(req.query.q || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim().toLowerCase();
    const location = String(req.query.location || '').trim().toLowerCase();
    const vettedOnly = ['1', 'true', 'yes', 'on'].includes(String(req.query.vetted || '').trim().toLowerCase());
    const tokens = q ? q.split(/\s+/) : [];

    let results = db.prepare('SELECT * FROM offers WHERE active = 1 ORDER BY id').all()
      .map((o) => offerPublic(o, ratings));

    if (category) results = results.filter((o) => o.smb.category.toLowerCase() === category);
    if (location) results = results.filter((o) => o.smb.location.toLowerCase().includes(location));
    if (vettedOnly) results = results.filter((o) => o.smb.vetted);
    if (tokens.length) {
      results = results.filter((o) => {
        const haystack = [
          o.title, o.description,
          ...o.steps.map((s) => `${s.title} ${s.description}`),
          o.smb.name, o.smb.category, o.smb.location, o.smb.capabilities,
        ].join(' ').toLowerCase();
        return tokens.every((t) => haystack.includes(t));
      });
    }

    results.sort((a, b) => (b.smb.rating.score - a.smb.rating.score) || (a.price_cents - b.price_cents) || (a.id - b.id));
    res.json(results);
  });

  router.get('/offers/:id', (req, res) => {
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
    if (!offer) throw new ApiError(404, 'offer not found');
    res.json(offerPublic(offer));
  });

  // ---------- engagements: handshake ------------------------------------------

  // Agent selects an offer → draft engagement with the offer's steps snapshotted.
  router.post('/engagements', (req, res) => {
    const body = requireBody(req, ['offer_id', 'agent_id']);
    const offer = db.prepare('SELECT * FROM offers WHERE id = ? AND active = 1').get(body.offer_id);
    if (!offer) throw new ApiError(404, 'offer not found');
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(body.agent_id);
    if (!agent) throw new ApiError(404, 'agent not found');
    if (pacta) {
      const smb = db.prepare('SELECT * FROM smbs WHERE id = ?').get(offer.smb_id);
      if (!smb.vetted) {
        throw new ApiError(409,
          `'${smb.name}' is not vetted: it has no stake posted. Engagements require collateralized SMBs.`);
      }
    }

    // Guard against double-click duplicates: reuse an existing open draft for the
    // same agent + offer instead of creating a second one.
    const existingDraft = db.prepare(
      "SELECT * FROM engagements WHERE offer_id = ? AND agent_id = ? AND state = 'draft'",
    ).get(offer.id, agent.id);
    if (existingDraft) return res.status(200).json(engagementPublic(existingDraft));

    const id = withTx(db, () => {
      const info = db.prepare(
        `INSERT INTO engagements (offer_id, agent_id, smb_id, title, price_cents, upfront_pct, state)
         VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
      ).run(offer.id, agent.id, offer.smb_id, offer.title, offer.price_cents, offer.upfront_pct);
      const engagementId = Number(info.lastInsertRowid);
      for (const s of offerSteps(offer.id)) {
        db.prepare(
          'INSERT INTO engagement_steps (engagement_id, position, title, description, verification_kind) VALUES (?, ?, ?, ?, ?)',
        ).run(engagementId, s.position, s.title, s.description, s.verification_kind ?? null);
      }
      return engagementId;
    });
    res.status(201).json(engagementPublic(getEngagementOr404(id)));
  });

  router.get('/engagements', (req, res) => {
    const clauses = [];
    const params = [];
    for (const [col, key] of [['agent_id', 'agent_id'], ['smb_id', 'smb_id'], ['state', 'state']]) {
      if (req.query[key]) { clauses.push(`${col} = ?`); params.push(req.query[key]); }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM engagements ${where} ORDER BY id DESC`).all(...params);
    res.json(rows.map(engagementPublic));
  });

  router.get('/engagements/:id', (req, res) => {
    res.json(engagementPublic(getEngagementOr404(req.params.id)));
  });

  // Steps are editable ONLY while the engagement is a draft. After agreement the
  // contract is immutable — this returns 409, which the verification checklist probes.
  router.patch('/engagements/:id/steps/:stepId', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    if (e.state !== 'draft') {
      throw new ApiError(409, `steps are locked: engagement is '${e.state}', not 'draft'`);
    }
    const step = db.prepare('SELECT * FROM engagement_steps WHERE id = ? AND engagement_id = ?')
      .get(req.params.stepId, e.id);
    if (!step) throw new ApiError(404, 'step not found');
    const body = req.body || {};
    db.prepare('UPDATE engagement_steps SET title = ?, description = ? WHERE id = ?').run(
      typeof body.title === 'string' && body.title.trim() ? body.title.trim() : step.title,
      typeof body.description === 'string' ? body.description : step.description,
      step.id,
    );
    res.json(engagementPublic(e));
  });

  // Both parties agree → terms lock, contract becomes immutable.
  // Pacta: agreement is where the SMB's graduated exposure cap is enforced —
  // total active contract value may not exceed 5×stake + 50% of completed GMV.
  router.post('/engagements/:id/agree', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    const to = assertTransition(e, 'agree');
    if (pacta) {
      const cap = staking.exposureCapCents(db, e.smb_id);
      const active = staking.activeExposureCents(db, e.smb_id);
      if (active + Number(e.price_cents) > cap) {
        const fmt = (c) => '$' + (c / 100).toLocaleString('en-US');
        throw new ApiError(409,
          `exposure cap exceeded: this SMB may hold ${fmt(cap)} in active engagements ` +
          `(currently ${fmt(active)}); adding ${fmt(Number(e.price_cents))} requires more stake or more completed work`);
      }
    }
    setState(e.id, to);
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Agent funds the escrow with the upfront percentage.
  router.post('/engagements/:id/fund', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    const to = assertTransition(e, 'fund');
    const upfrontCents = Math.round((Number(e.price_cents) * Number(e.upfront_pct)) / 100);
    withTx(db, () => {
      const agentAcct = getOrCreateAccount(db, 'agent', e.agent_id);
      const escrowAcct = getOrCreateAccount(db, 'escrow', e.id);
      if (upfrontCents > 0) {
        transfer(db, {
          fromAccountId: agentAcct.id,
          toAccountId: escrowAcct.id,
          amountCents: upfrontCents,
          type: 'escrow_fund',
          memo: `escrow downpayment (${e.upfront_pct}%) for engagement #${e.id}`,
          engagementId: e.id,
        });
      }
      setState(e.id, to);
    });
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // SMB marks a step complete with proof. Only after escrow is funded.
  router.post('/engagements/:id/steps/:stepId/complete', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    if (!['funded', 'in_progress'].includes(e.state)) {
      throw new ApiError(409,
        e.state === 'agreed'
          ? 'escrow must be funded before work can start'
          : `cannot complete steps in state '${e.state}'`);
    }
    const body = requireBody(req, ['proof_text']);
    const step = db.prepare('SELECT * FROM engagement_steps WHERE id = ? AND engagement_id = ?')
      .get(req.params.stepId, e.id);
    if (!step) throw new ApiError(404, 'step not found');
    if (step.status === 'done') throw new ApiError(409, 'step is already complete');

    // Pacta: registry-anchored steps require evidence that verifies itself —
    // a reference that exists in the public registry and matches the step's kind.
    let registryRef = null;
    let verified = 0;
    if (pacta && step.verification_kind) {
      if (!body.registry_ref) {
        throw new ApiError(400,
          `this step requires a public registry reference (kind: ${step.verification_kind})`);
      }
      const record = db.prepare('SELECT * FROM registry_records WHERE ref = ?').get(String(body.registry_ref));
      if (!record) {
        throw new ApiError(409, `registry reference '${body.registry_ref}' not found in the public registry`);
      }
      if (record.kind !== step.verification_kind) {
        throw new ApiError(409,
          `registry record '${body.registry_ref}' is a '${record.kind}' record; this step requires '${step.verification_kind}'`);
      }
      registryRef = String(body.registry_ref);
      verified = 1;
    }
    withTx(db, () => {
      db.prepare(
        "UPDATE engagement_steps SET status = 'done', proof_text = ?, proof_url = ?, proof_registry_ref = ?, proof_verified = ?, completed_at = datetime('now') WHERE id = ?",
      ).run(String(body.proof_text), body.proof_url ? String(body.proof_url) : null, registryRef, verified, step.id);
      if (e.state === 'funded') setState(e.id, 'in_progress');
    });
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // SMB submits for verification — only when every step is done with proof.
  router.post('/engagements/:id/submit', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    if (!['funded', 'in_progress'].includes(e.state)) {
      throw new ApiError(409, `cannot submit an engagement in state '${e.state}'`);
    }
    const steps = engagementSteps(e.id);
    const incomplete = steps.filter((s) => s.status !== 'done' || !s.proof_text);
    if (incomplete.length > 0) {
      throw new ApiError(409,
        `cannot submit: ${incomplete.length} of ${steps.length} steps missing completion or proof`);
    }
    setState(e.id, 'submitted');
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Agent approves the proofs → settlement. One SQLite transaction draws the
  // remaining balance from the agent, releases the full escrow to the SMB, and
  // flips the state — so double release is structurally impossible.
  router.post('/engagements/:id/approve', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    const to = assertTransition(e, 'approve');
    withTx(db, () => {
      const agentAcct = getOrCreateAccount(db, 'agent', e.agent_id);
      const smbAcct = getOrCreateAccount(db, 'smb', e.smb_id);
      const escrowAcct = getOrCreateAccount(db, 'escrow', e.id);
      const remaining = Number(e.price_cents) - Math.round((Number(e.price_cents) * Number(e.upfront_pct)) / 100);
      if (remaining > 0) {
        transfer(db, {
          fromAccountId: agentAcct.id, toAccountId: escrowAcct.id, amountCents: remaining,
          type: 'escrow_fund', memo: `remaining ${100 - Number(e.upfront_pct)}% drawn on approval`, engagementId: e.id,
        });
      }
      const escrowBalance = Number(db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(escrowAcct.id).balance_cents);
      if (escrowBalance > 0) {
        transfer(db, {
          fromAccountId: escrowAcct.id, toAccountId: smbAcct.id, amountCents: escrowBalance,
          type: 'escrow_release', memo: `full payment released to SMB for engagement #${e.id}`, engagementId: e.id,
        });
      }
      setState(e.id, to);
    });
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Agent rejects the proofs → dispute, held for the arbiter.
  router.post('/engagements/:id/reject', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    const to = assertTransition(e, 'reject');
    const body = requireBody(req, ['reason']);
    setState(e.id, to, { dispute_reason: String(body.reason) });
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Arbiter rules on a dispute. Applies to the escrowed funds only.
  router.post('/engagements/:id/resolve', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    const to = assertTransition(e, 'resolve');
    const body = requireBody(req, ['ruling']);
    const ruling = String(body.ruling);
    if (!['release', 'refund', 'split'].includes(ruling)) {
      throw new ApiError(400, "ruling must be one of: release, refund, split");
    }
    withTx(db, () => {
      const agentAcct = getOrCreateAccount(db, 'agent', e.agent_id);
      const smbAcct = getOrCreateAccount(db, 'smb', e.smb_id);
      const escrowAcct = getOrCreateAccount(db, 'escrow', e.id);
      const held = Number(db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(escrowAcct.id).balance_cents);
      const payout = (toAcct, amount, type, memo) => {
        if (amount > 0) {
          transfer(db, { fromAccountId: escrowAcct.id, toAccountId: toAcct.id, amountCents: amount, type, memo, engagementId: e.id });
        }
      };
      if (ruling === 'release') {
        payout(smbAcct, held, 'escrow_release', `arbiter ruling: release escrow to SMB (engagement #${e.id})`);
      } else if (ruling === 'refund') {
        payout(agentAcct, held, 'refund', `arbiter ruling: refund escrow to agent (engagement #${e.id})`);
      } else {
        const agentShare = Math.floor(held / 2); // odd cent goes to the SMB
        payout(smbAcct, held - agentShare, 'split_release', `arbiter ruling: split — SMB share (engagement #${e.id})`);
        payout(agentAcct, agentShare, 'split_refund', `arbiter ruling: split — agent refund (engagement #${e.id})`);
      }
      // Pacta: an adverse ruling costs the SMB part of its stake (skin in the game).
      if (pacta) staking.slashForRuling(db, e, ruling);
      setState(e.id, to, { resolution: ruling });
    });
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Agent rates the SMB good/bad after settlement. One rating per engagement.
  router.post('/engagements/:id/rate', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    if (!['completed', 'resolved'].includes(e.state)) {
      throw new ApiError(409, `can only rate after settlement (state is '${e.state}')`);
    }
    const body = requireBody(req, ['value']);
    const value = String(body.value);
    if (!['good', 'bad'].includes(value)) throw new ApiError(400, "value must be 'good' or 'bad'");
    const existing = db.prepare('SELECT id FROM ratings WHERE engagement_id = ?').get(e.id);
    if (existing) throw new ApiError(409, 'this engagement has already been rated');
    db.prepare('INSERT INTO ratings (engagement_id, smb_id, agent_id, value) VALUES (?, ?, ?, ?)')
      .run(e.id, e.smb_id, e.agent_id, value);
    res.status(201).json(engagementPublic(getEngagementOr404(e.id)));
  });

  // ---------- public registry (Pacta) + agent surface ---------------------------

  router.get('/registry/:ref', (req, res) => {
    const record = db.prepare('SELECT * FROM registry_records WHERE ref = ?').get(req.params.ref);
    if (!record) throw new ApiError(404, `no public record with reference '${req.params.ref}'`);
    res.json({
      ref: record.ref, kind: record.kind, title: record.title,
      issued_to: record.issued_to, details: record.details, created_at: record.created_at,
    });
  });

  // Machine-readable description of the full agent-side lifecycle — designed to be
  // wrapped 1:1 by an MCP server so any AI agent can consume this marketplace.
  router.get('/agent/manifest', (req, res) => {
    res.json({
      name: 'agent-services-marketplace',
      plan: pacta ? 'pacta' : 'base',
      description: 'Discover, contract, escrow, verify and pay for real-world SMB services.',
      tools: [
        { name: 'search_offers', method: 'GET', path: '/api/offers', params: { q: 'keywords', category: 'optional', location: 'optional' }, description: 'Search service offers ranked by SMB rating then price.' },
        { name: 'get_offer', method: 'GET', path: '/api/offers/{id}', description: 'One offer with its step list, escrow terms and SMB profile.' },
        { name: 'create_engagement', method: 'POST', path: '/api/engagements', params: { offer_id: 'int', agent_id: 'int' }, description: 'Create a draft contract snapshotting the offer steps.' },
        { name: 'agree', method: 'POST', path: '/api/engagements/{id}/agree', description: 'Lock steps and terms into an immutable contract.' },
        { name: 'fund_escrow', method: 'POST', path: '/api/engagements/{id}/fund', description: 'Move the downpayment into escrow so work can start.' },
        { name: 'get_engagement', method: 'GET', path: '/api/engagements/{id}', description: 'Current state, steps, proofs and escrow balance.' },
        { name: 'approve', method: 'POST', path: '/api/engagements/{id}/approve', description: 'Accept the proofs: draws the remainder and releases full payment.' },
        { name: 'reject', method: 'POST', path: '/api/engagements/{id}/reject', params: { reason: 'string' }, description: 'Open a dispute for the arbiter.' },
        { name: 'rate', method: 'POST', path: '/api/engagements/{id}/rate', params: { value: 'good|bad' }, description: 'Rate the SMB after settlement; feeds search ranking.' },
        { name: 'registry_lookup', method: 'GET', path: '/api/registry/{ref}', description: 'Verify a proof reference against the public registry (Pacta).' },
      ],
    });
  });

  // ---------- disputes / ledger ------------------------------------------------

  router.get('/disputes', (req, res) => {
    const rows = db.prepare("SELECT * FROM engagements WHERE state IN ('disputed', 'resolved') ORDER BY id DESC").all();
    res.json(rows.map(engagementPublic));
  });

  router.get('/ledger', (req, res) => {
    const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all().map((a) => {
      let owner = null;
      if (a.kind === 'agent') owner = db.prepare('SELECT name FROM agents WHERE id = ?').get(a.ref_id)?.name;
      if (a.kind === 'smb') owner = db.prepare('SELECT name FROM smbs WHERE id = ?').get(a.ref_id)?.name;
      if (a.kind === 'escrow') owner = `Escrow — engagement #${a.ref_id}`;
      return { id: Number(a.id), kind: a.kind, ref_id: Number(a.ref_id), owner, balance_cents: Number(a.balance_cents) };
    });
    const transactions = db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 200').all().map((t) => ({
      id: Number(t.id),
      engagement_id: t.engagement_id === null ? null : Number(t.engagement_id),
      from_account_id: t.from_account_id === null ? null : Number(t.from_account_id),
      to_account_id: Number(t.to_account_id),
      amount_cents: Number(t.amount_cents),
      type: t.type,
      memo: t.memo,
      created_at: t.created_at,
    }));
    res.json({ accounts, transactions, invariant: checkInvariant(db) });
  });

  router.get('/ledger/invariant', (req, res) => {
    res.json(checkInvariant(db));
  });

  // ---------- error handling ---------------------------------------------------

  router.use((req, res) => {
    res.status(404).json({ error: `no such API route: ${req.method} ${req.originalUrl}` });
  });

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof ApiError || err instanceof LedgerError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    console.error('[api] unexpected error:', err);
    res.status(500).json({ error: 'internal server error' });
  });

  return router;
}

module.exports = { createApiRouter, ApiError };
