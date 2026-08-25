'use strict';
const express = require('express');
const { withTx } = require('./db');
const {
  LedgerError, getOrCreateAccount, getAccount, checkInvariant,
} = require('./ledger');
const staking = require('./staking');
const { LocalRegistryAdapter, RegistryUnavailableError } = require('./registry');
const { createSettlementBackend, SettlementError } = require('./settlement');
const { createHardening, HardeningError } = require('./hardening');
// Phase 0 (ADR-001): cryptographic agreement immutability.
const canonical = require('./canonical');
const eip712 = require('./eip712');
const keysmod = require('./keys');
const eventlog = require('./eventlog');
const receiptsmod = require('./receipts');

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

function createApiRouter(db, { pacta = false, registry = null, settlement = null, hardening = {}, anchorHook = null } = {}) {
  // Fire-and-forget anchor trigger: when an engagement closes we kick off an
  // on-chain anchor without blocking the HTTP response (the tx takes seconds).
  const triggerAnchor = () => { if (anchorHook) Promise.resolve().then(anchorHook).catch(() => {}); };
  const router = express.Router();
  router.use(express.json());
  // Where proof references get verified. Defaults to the seeded local registry;
  // see src/registry.js for the adapter contract and the external adapters.
  const registryAdapter = registry || new LocalRegistryAdapter(db);
  // How escrow, collateral and slashing settle. Defaults to the internal ledger;
  // see src/settlement.js for the interface and SETTLEMENT_BACKEND selection.
  const settlementBackend = settlement || createSettlementBackend(db);
  // API keys, rate limiting, idempotency, provider webhooks (src/hardening.js).
  const hard = createHardening(db, hardening);
  router.use(hard.rateLimiter);

  // ---------- helpers --------------------------------------------------------

  // Fold to a diacritic-insensitive, lowercase form so search works the way
  // Spanish and Portuguese speakers actually type: `habilitacion` finds
  // `habilitación`, `sao paulo` finds `São Paulo`. Both the query and the text
  // being searched are folded, so a match happens regardless of which side
  // carries the accent.
  const fold = (s) => String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

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
      base.stake_cents = stakeBalanceCents(smb.id);
      base.exposure_cap_cents = exposureCapCents(smb.id);
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
      agreement_hash: e.agreement_hash || null,
      signatures: e.agreement_hash ? { buyer: e.buyer_sig, provider: e.provider_sig } : null,
      steps,
      steps_done: steps.filter((s) => s.status === 'done').length,
      steps_total: steps.length,
      created_at: e.created_at,
      updated_at: e.updated_at,
    };
  };

  // Phase 0: the event-log key for an engagement is its agreement_hash;
  // engagements that predate Phase 0 (or are still drafts) use a marker key.
  const engagementKey = (e) => e.agreement_hash || `pre-phase0:${e.id}`;

  // Append a lifecycle event (must run inside the mutation's transaction).
  const logEvent = (e, type, payload) => eventlog.append(db, {
    engagement: engagementKey(e), type, payload: { engagement_id: Number(e.id), ...payload },
  });

  // Launch default is custodial keys, created on first need and disclosed.
  // A newly created key is itself a logged event.
  const ensureKeyLogged = (kind, id) => {
    const existing = keysmod.getKey(db, kind, id);
    if (existing) return existing;
    const key = keysmod.ensureCustodialKey(db, kind, id);
    eventlog.append(db, {
      engagement: 'platform',
      type: 'KeyRegistered',
      payload: { owner: `${kind === 'agent' ? 'agt' : 'smb'}_${id}`, pubkey: key.pubkey, custody: key.custody },
    });
    return key;
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

  // ---------- settlement helpers ---------------------------------------------
  // Everything that moves money — escrow, collateral, slashing — goes through the
  // settlement backend. The core never touches ledger transfers directly, so the
  // same code path settles onchain (a Base USDC vault) or offchain (this ledger).

  const buyerRef = (agentId) => ({ kind: 'agent', id: Number(agentId) });
  const providerRef = (smbId) => ({ kind: 'smb', id: Number(smbId) });

  // Collateral is read through the backend so the exposure cap is correct wherever
  // the stake is held; the GMV share stays a read of local engagement history.
  const stakeBalanceCents = (smbId) => Number(settlementBackend.stakeBalance(providerRef(smbId)));
  const exposureCapCents = (smbId) => staking.exposureCapCents(
    stakeBalanceCents(smbId), staking.completedGmvCents(db, smbId),
  );

  // The escrow handle the backend understands for this engagement.
  const escrowHandle = (e) => settlementBackend.openEscrow({
    engagementId: Number(e.id),
    buyer: buyerRef(e.agent_id),
    provider: providerRef(e.smb_id),
    amountMinor: BigInt(Number(e.price_cents)),
  });

  // Authorization is data: the signatures bound to the agreement hash that /agree
  // already produced and verified. The ledger backend records them; an onchain
  // backend has its contract verify them. No new signature scheme is introduced.
  const authFor = (e) => ({
    agreementHash: e.agreement_hash || null,
    signatures: e.agreement_hash ? { buyer: e.buyer_sig, provider: e.provider_sig } : null,
  });

  // ---------- config / plan flags ----------------------------------------------

  router.get('/config', (req, res) => {
    res.json({
      plan: pacta ? 'pacta' : 'base',
      registry_adapter: registryAdapter.name,
      features: {
        staking: pacta,
        registry_verification: pacta,
        agent_manifest: true,
      },
      hardening: {
        api_keys_enforced: hard.enabled.requireKeys,
        rate_limit_per_min: hard.enabled.rateLimitPerMin,
        idempotency_keys: true,
        provider_webhooks: true,
      },
    });
  });

  // ---------- health -----------------------------------------------------------

  // Cheap, unauthenticated liveness check for deployment/monitoring (systemd,
  // Caddy, uptime checks). Never mutates anything.
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      plan: pacta ? 'pacta' : 'base',
      ledger_ok: checkInvariant(db).ok,
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
        settlementBackend.stake(providerRef(smbId), BigInt(stakeCents), { memo: `initial stake for '${body.name}'` });
        eventlog.append(db, {
          engagement: 'platform', type: 'StakeChanged',
          payload: { owner: `smb_${smbId}`, delta_cents: stakeCents, cause: 'deposit' },
        });
      }
      return smbId;
    });
    // The key is shown once, here; only its hash is stored.
    const apiKey = hard.issueKey('smb', id);
    res.status(201).json({ ...smbPublic(db.prepare('SELECT * FROM smbs WHERE id = ?').get(id)), api_key: apiKey });
  });

  // First claim on a keyless (seeded) identity is open; rotation afterwards
  // requires presenting the current key in the Authorization header.
  for (const kind of ['agent', 'smb']) {
    router.post(`/${kind}s/:id/api-key`, (req, res) => {
      const auth = req.get('authorization') || '';
      const presented = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() || null;
      const key = hard.claimKey(kind, req.params.id, presented);
      res.status(201).json({ [`${kind}_id`]: Number(req.params.id), api_key: key });
    });
  }

  // Provider webhook: the SMB registers a URL and gets a signing secret back
  // (shown once). Engagement state changes are POSTed there, HMAC-signed.
  router.post('/smbs/:id/webhook', (req, res) => {
    const smb = db.prepare('SELECT * FROM smbs WHERE id = ?').get(req.params.id);
    if (!smb) throw new ApiError(404, 'SMB not found');
    hard.requireActor(req, 'smb', smb.id);
    const body = req.body || {};
    if (body.url === undefined) throw new ApiError(400, 'missing required field: url');
    const secret = hard.setWebhook(smb.id, body.url || null);
    res.status(201).json({
      smb_id: Number(smb.id),
      webhook_url: body.url || null,
      ...(secret ? { webhook_secret: secret } : {}),
    });
  });

  // Pacta: post (more) stake — a simulated external deposit into the SMB's
  // collateral account. Restores/grants the vetted badge.
  router.post('/smbs/:id/stake', hard.idempotent, (req, res) => {
    if (!pacta) throw new ApiError(404, 'staking is a Pacta feature');
    const smb = db.prepare('SELECT * FROM smbs WHERE id = ?').get(req.params.id);
    if (!smb) throw new ApiError(404, 'SMB not found');
    hard.requireActor(req, 'smb', smb.id);
    const body = requireBody(req, ['amount_cents']);
    const amount = Number(body.amount_cents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ApiError(400, 'amount_cents must be a positive integer');
    }
    withTx(db, () => {
      settlementBackend.stake(providerRef(smb.id), BigInt(amount), { memo: `stake top-up for '${smb.name}'` });
      eventlog.append(db, {
        engagement: 'platform', type: 'StakeChanged',
        payload: { owner: `smb_${smb.id}`, delta_cents: amount, cause: 'deposit' },
      });
    });
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
    hard.requireActor(req, 'smb', smb.id);
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

  // Search: q keywords are ANDed, case- and accent-insensitive, matched across
  // the offer text, its steps, and the SMB profile. Ranked by SMB rating score
  // desc, then price asc.
  router.get('/offers', (req, res) => {
    const ratings = ratingsBySmb();
    const q = fold(String(req.query.q || '').trim());
    const category = fold(String(req.query.category || '').trim());
    const location = fold(String(req.query.location || '').trim());
    const vettedOnly = ['1', 'true', 'yes', 'on'].includes(String(req.query.vetted || '').trim().toLowerCase());
    const tokens = q ? q.split(/\s+/) : [];

    let results = db.prepare('SELECT * FROM offers WHERE active = 1 ORDER BY id').all()
      .map((o) => offerPublic(o, ratings));

    if (category) results = results.filter((o) => fold(o.smb.category) === category);
    if (location) results = results.filter((o) => fold(o.smb.location).includes(location));
    if (vettedOnly) results = results.filter((o) => o.smb.vetted);
    if (tokens.length) {
      results = results.filter((o) => {
        const haystack = fold([
          o.title, o.description,
          ...o.steps.map((s) => `${s.title} ${s.description}`),
          o.smb.name, o.smb.category, o.smb.location, o.smb.capabilities,
        ].join(' '));
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
    hard.requireActor(req, 'agent', agent.id);
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
        `INSERT INTO engagements (offer_id, agent_id, smb_id, title, price_cents, upfront_pct, state, nonce)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`,
      ).run(offer.id, agent.id, offer.smb_id, offer.title, offer.price_cents, offer.upfront_pct, canonical.newNonce());
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
    hard.requireParty(req, e);
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
  // Phase 0 (ADR-001): locking now means signing. The terms are canonicalized
  // (RFC 8785) and hashed; agreement_hash becomes the engagement's universal
  // identity. Both parties sign the hash via EIP-712 — custodial keys sign
  // server-side (disclosed launch default), self-custody parties send
  // buyer_signature / provider_signature in the body. Both signatures are
  // verified here, persisted, and recorded in the append-only event log.
  // Pacta: agreement is where the SMB's graduated exposure cap is enforced —
  // total active contract value may not exceed 5×stake + 50% of completed GMV.
  router.post('/engagements/:id/agree', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    hard.requireParty(req, e);
    const to = assertTransition(e, 'agree');
    if (pacta) {
      const cap = exposureCapCents(e.smb_id);
      const active = staking.activeExposureCents(db, e.smb_id);
      if (active + Number(e.price_cents) > cap) {
        const fmt = (c) => '$' + (c / 100).toLocaleString('en-US');
        throw new ApiError(409,
          `exposure cap exceeded: this SMB may hold ${fmt(cap)} in active engagements ` +
          `(currently ${fmt(active)}); adding ${fmt(Number(e.price_cents))} requires more stake or more completed work`);
      }
    }
    const body = req.body || {};
    const receipt = withTx(db, () => {
      const buyerKey = ensureKeyLogged('agent', e.agent_id);
      const providerKey = ensureKeyLogged('smb', e.smb_id);
      if (!e.nonce) {
        e.nonce = canonical.newNonce();
        db.prepare('UPDATE engagements SET nonce = ? WHERE id = ?').run(e.nonce, e.id);
      }
      const steps = db.prepare('SELECT * FROM engagement_steps WHERE engagement_id = ? ORDER BY position').all(e.id);
      const agreement = canonical.canonicalAgreement({
        engagement: e, steps, buyerPubkey: buyerKey.pubkey, providerPubkey: providerKey.pubkey,
      });
      const hash = canonical.agreementHash(agreement);
      const chainId = eip712.chainId();
      const sigs = {};
      for (const [role, key, provided] of [
        ['buyer', buyerKey, body.buyer_signature],
        ['provider', providerKey, body.provider_signature],
      ]) {
        const digest = eip712.agreementDigest({ agreementHash: hash, role, nonce: e.nonce, chainId });
        const sig = provided ? String(provided) : keysmod.signAsParty(db, key, digest);
        if (!eip712.verifyDigest(digest, sig, key.pubkey)) {
          throw new ApiError(400, `invalid ${role} signature for agreement ${hash}`);
        }
        sigs[role] = sig;
      }
      db.prepare('UPDATE engagements SET agreement_hash = ?, buyer_sig = ?, provider_sig = ? WHERE id = ?')
        .run(hash, sigs.buyer, sigs.provider, e.id);
      setState(e.id, to);
      return eventlog.append(db, {
        engagement: hash,
        type: 'AgreementLocked',
        payload: {
          engagement_id: Number(e.id),
          agreement,
          agreement_hash: hash,
          signatures: sigs,
          eip712_domain: { name: eip712.DOMAIN_NAME, version: eip712.DOMAIN_VERSION, chain_id: chainId },
        },
      });
    });
    hard.notifyProvider(e.id, 'engagement.agreed');
    res.json({ ...engagementPublic(getEngagementOr404(e.id)), receipt: receiptsmod.receiptForSeq(db, receipt.seq) });
  });

  // Agent funds the escrow with the upfront percentage.
  router.post('/engagements/:id/fund', hard.idempotent, (req, res) => {
    const e = getEngagementOr404(req.params.id);
    hard.requireActor(req, 'agent', e.agent_id);
    const to = assertTransition(e, 'fund');
    const upfrontCents = Math.round((Number(e.price_cents) * Number(e.upfront_pct)) / 100);
    withTx(db, () => {
      settlementBackend.fund(escrowHandle(e), BigInt(upfrontCents), {
        memo: `escrow downpayment (${e.upfront_pct}%) for engagement #${e.id}`,
      });
      setState(e.id, to);
      logEvent(e, 'EscrowFunded', { amount_cents: upfrontCents, escrow_account: 'upfront' });
    });
    hard.notifyProvider(e.id, 'engagement.funded');
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // SMB marks a step complete with proof. Only after escrow is funded.
  router.post('/engagements/:id/steps/:stepId/complete', async (req, res) => {
    const e = getEngagementOr404(req.params.id);
    hard.requireActor(req, 'smb', e.smb_id);
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
      const record = await registryAdapter.lookup(String(body.registry_ref));
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
      // Evidence bytes never enter the log — only their hash and the registry
      // reference that was independently verified.
      logEvent(e, 'EvidenceSubmitted', {
        step_n: Number(step.position),
        proof_hash: canonical.hashOf({ text: String(body.proof_text), url: body.proof_url ? String(body.proof_url) : null }),
        registry_ref: registryRef,
        registry_verified: Boolean(verified),
      });
    });
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // SMB submits for verification — only when every step is done with proof.
  router.post('/engagements/:id/submit', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    hard.requireActor(req, 'smb', e.smb_id);
    if (!['funded', 'in_progress'].includes(e.state)) {
      throw new ApiError(409, `cannot submit an engagement in state '${e.state}'`);
    }
    const steps = engagementSteps(e.id);
    const incomplete = steps.filter((s) => s.status !== 'done' || !s.proof_text);
    if (incomplete.length > 0) {
      throw new ApiError(409,
        `cannot submit: ${incomplete.length} of ${steps.length} steps missing completion or proof`);
    }
    withTx(db, () => {
      setState(e.id, 'submitted');
      logEvent(e, 'WorkSubmitted', { steps_total: steps.length });
    });
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Agent approves the proofs → settlement. One SQLite transaction draws the
  // remaining balance from the agent, releases the full escrow to the SMB, and
  // flips the state — so double release is structurally impossible.
  router.post('/engagements/:id/approve', hard.idempotent, (req, res) => {
    const e = getEngagementOr404(req.params.id);
    hard.requireActor(req, 'agent', e.agent_id);
    const to = assertTransition(e, 'approve');
    withTx(db, () => {
      const handle = escrowHandle(e);
      // Draw the remainder from the buyer into escrow, then release the full
      // escrow balance to the provider — one transaction, so double release is
      // structurally impossible.
      const remaining = Number(e.price_cents) - Math.round((Number(e.price_cents) * Number(e.upfront_pct)) / 100);
      settlementBackend.fund(handle, BigInt(remaining), {
        memo: `remaining ${100 - Number(e.upfront_pct)}% drawn on approval`,
      });
      const rel = settlementBackend.release(handle, authFor(e), {
        memo: `full payment released to SMB for engagement #${e.id}`,
      });
      setState(e.id, to);
      logEvent(e, 'SettlementApproved', { remaining_drawn_cents: remaining, released_cents: Number(rel.amount_minor) });
    });
    hard.notifyProvider(e.id, 'engagement.completed');
    triggerAnchor();
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Agent rejects the proofs → dispute, held for the arbiter.
  router.post('/engagements/:id/reject', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    hard.requireActor(req, 'agent', e.agent_id);
    const to = assertTransition(e, 'reject');
    const body = requireBody(req, ['reason']);
    withTx(db, () => {
      setState(e.id, to, { dispute_reason: String(body.reason) });
      logEvent(e, 'DisputeOpened', { reason_hash: canonical.hashOf(String(body.reason)) });
    });
    hard.notifyProvider(e.id, 'engagement.disputed');
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Arbiter rules on a dispute. Applies to the escrowed funds only.
  router.post('/engagements/:id/resolve', hard.idempotent, (req, res) => {
    const e = getEngagementOr404(req.params.id);
    hard.requireArbiter(req);
    const to = assertTransition(e, 'resolve');
    const body = requireBody(req, ['ruling']);
    const ruling = String(body.ruling);
    if (!['release', 'refund', 'split'].includes(ruling)) {
      throw new ApiError(400, "ruling must be one of: release, refund, split");
    }
    withTx(db, () => {
      const handle = escrowHandle(e);
      const auth = authFor(e);
      // Held escrow read through the settlement backend, not the ledger's SQL:
      // an onchain vault has no accounts row, so the amount must come from the
      // backend that actually custodies it (src/settlement.js escrowBalance).
      const held = Number(settlementBackend.escrowBalance(handle));
      if (ruling === 'release') {
        settlementBackend.release(handle, auth, { memo: `arbiter ruling: release escrow to SMB (engagement #${e.id})` });
      } else if (ruling === 'refund') {
        settlementBackend.refund(handle, auth, { memo: `arbiter ruling: refund escrow to agent (engagement #${e.id})` });
      } else {
        const agentShare = Math.floor(held / 2); // odd cent goes to the SMB
        settlementBackend.split(handle, BigInt(agentShare), BigInt(held - agentShare), auth, {
          providerMemo: `arbiter ruling: split — SMB share (engagement #${e.id})`,
          buyerMemo: `arbiter ruling: split — agent refund (engagement #${e.id})`,
        });
      }
      // Pacta: an adverse ruling costs the SMB part of its stake (skin in the game).
      let slashed = 0;
      if (pacta) {
        const penalty = staking.penaltyCentsForRuling(e.price_cents, ruling);
        if (penalty > 0) {
          const r = settlementBackend.slash(providerRef(e.smb_id), BigInt(penalty), auth, {
            beneficiary: buyerRef(e.agent_id),
            engagementId: Number(e.id),
            memo: `stake slashed ${staking.SLASH_PCT[ruling]}% for '${ruling}' ruling on engagement #${e.id}`,
          });
          slashed = Number(r.amount_minor);
        }
      }
      setState(e.id, to, { resolution: ruling });
      logEvent(e, 'RulingIssued', { ruling, escrow_distributed_cents: held, stake_slashed_cents: slashed });
      if (slashed > 0) {
        logEvent(e, 'StakeChanged', { owner: `smb_${e.smb_id}`, delta_cents: -slashed, cause: 'slash' });
      }
    });
    hard.notifyProvider(e.id, 'engagement.resolved');
    triggerAnchor();
    res.json(engagementPublic(getEngagementOr404(e.id)));
  });

  // Agent rates the SMB good/bad after settlement. One rating per engagement.
  router.post('/engagements/:id/rate', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    hard.requireActor(req, 'agent', e.agent_id);
    if (!['completed', 'resolved'].includes(e.state)) {
      throw new ApiError(409, `can only rate after settlement (state is '${e.state}')`);
    }
    const body = requireBody(req, ['value']);
    const value = String(body.value);
    if (!['good', 'bad'].includes(value)) throw new ApiError(400, "value must be 'good' or 'bad'");
    const existing = db.prepare('SELECT id FROM ratings WHERE engagement_id = ?').get(e.id);
    if (existing) throw new ApiError(409, 'this engagement has already been rated');
    withTx(db, () => {
      db.prepare('INSERT INTO ratings (engagement_id, smb_id, agent_id, value) VALUES (?, ?, ?, ?)')
        .run(e.id, e.smb_id, e.agent_id, value);
      logEvent(e, 'RatingSubmitted', { value });
    });
    res.status(201).json(engagementPublic(getEngagementOr404(e.id)));
  });

  // ---------- public registry (Pacta) + agent surface ---------------------------

  router.get('/registry/:ref', async (req, res) => {
    const record = await registryAdapter.lookup(req.params.ref);
    if (!record) throw new ApiError(404, `no public record with reference '${req.params.ref}'`);
    res.json({
      ref: record.ref, kind: record.kind, title: record.title,
      issued_to: record.issued_to, details: record.details, created_at: record.created_at,
      source: record.source,
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
        { name: 'get_agreement_proof', method: 'GET', path: '/api/engagements/{id}/proof', description: 'Full receipt set: signed, hash-chained events with Merkle paths to anchored roots (ADR-001).' },
        { name: 'verify_agreement_integrity', method: 'POST', path: '/api/verify', params: { receipt: 'object' }, description: 'Server-side receipt verification, plus the data to re-verify independently with the open verifier.' },
      ],
    });
  });

  // ---------- Phase 0: proofs, receipts, integrity -----------------------------

  // What exactly would I be signing? The canonical agreement, its hash and the
  // EIP-712 digests for both roles — the self-custody flow: register a key
  // (POST /{kind}s/{id}/signing-key), preview, sign the digest with your own
  // key, send the signature to /agree. Read-only: parties without registered
  // keys are told to register (or to rely on the disclosed custodial default).
  router.get('/engagements/:id/agreement-preview', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    if (e.state !== 'draft') throw new ApiError(409, `agreement preview is for drafts; this engagement is '${e.state}'`);
    if (!e.nonce) throw new ApiError(409, 'this engagement predates Phase 0 and has no nonce yet; agreeing will assign one');
    const buyerKey = keysmod.getKey(db, 'agent', e.agent_id);
    const providerKey = keysmod.getKey(db, 'smb', e.smb_id);
    if (!buyerKey || !providerKey) {
      throw new ApiError(409,
        'both parties need a registered signing key to preview: POST /{kind}s/{id}/signing-key, '
        + 'or just call /agree to use the disclosed custodial default');
    }
    const steps = db.prepare('SELECT * FROM engagement_steps WHERE engagement_id = ? ORDER BY position').all(e.id);
    const agreement = canonical.canonicalAgreement({
      engagement: e, steps, buyerPubkey: buyerKey.pubkey, providerPubkey: providerKey.pubkey,
    });
    const hash = canonical.agreementHash(agreement);
    const chainId = eip712.chainId();
    const digest = (role) => `0x${Buffer.from(
      eip712.agreementDigest({ agreementHash: hash, role, nonce: e.nonce, chainId }),
    ).toString('hex')}`;
    res.json({
      engagement_id: Number(e.id),
      agreement,
      agreement_hash: hash,
      eip712_domain: { name: eip712.DOMAIN_NAME, version: eip712.DOMAIN_VERSION, chain_id: chainId },
      signing_digests: { buyer: digest('buyer'), provider: digest('provider') },
    });
  });

  // Full receipt set for an engagement: every log entry that concerns it, with
  // Pacta's signature and (once anchored) the Merkle path to a public root.
  // This is what a party stores outside Pacta to make tampering provable.
  router.get('/engagements/:id/proof', (req, res) => {
    const e = getEngagementOr404(req.params.id);
    const key = engagementKey(e);
    res.json({
      engagement_id: Number(e.id),
      agreement_hash: e.agreement_hash || null,
      pre_phase0: !e.agreement_hash,
      eip712_domain: { name: eip712.DOMAIN_NAME, version: eip712.DOMAIN_VERSION, chain_id: eip712.chainId() },
      platform_pubkey: keysmod.platformPubkey(),
      receipts: receiptsmod.engagementReceipts(db, key),
    });
  });

  // Server-side convenience verification of a receipt. The response says it
  // plainly: do not trust this endpoint — the point of Phase 0 is that anyone
  // can re-run the same checks with the open verifier, offline, against any
  // RPC node, without Pacta's cooperation.
  router.post('/verify', (req, res) => {
    const receipt = (req.body || {}).receipt;
    if (!receipt || typeof receipt !== 'object' || !receipt.entry) {
      throw new ApiError(400, 'body must be { receipt: { entry, merkle_proof, anchor, pacta_sig } }');
    }
    // The verifier package reimplements every formula independently of this
    // backend (that is its contract); the server merely runs it for convenience.
    const { verifyReceipt } = require('../packages/verifier/lib');
    const result = verifyReceipt(receipt, {
      platformPubkey: keysmod.platformPubkey(),
      chainId: eip712.chainId(),
    });
    res.json({
      ...result,
      independent_verification:
        'Do not take this response as proof: re-run these checks yourself with the open-source '
        + 'verifier (packages/verifier — `pacta-verify receipt.json`), which needs no Pacta backend '
        + 'or credentials. Independent re-verification is the point.',
    });
  });

  // Public integrity status: replay the whole hash chain and report anchoring.
  // Additive read-only route (GOVERNANCE carve-out).
  router.get('/integrity', (req, res) => {
    const replayed = eventlog.replay(db);
    const anchorView = (a) => (a ? {
      sequence: Number(a.sequence),
      root: a.root,
      window_start: Number(a.window_start),
      window_end: Number(a.window_end),
      leaf_count: Number(a.leaf_count),
      chain_id: Number(a.chain_id),
      tx_hash: a.tx_hash,
      at: a.created_at,
    } : null);
    const lastAnchor = db.prepare('SELECT * FROM anchors ORDER BY id DESC LIMIT 1').get();
    // The most recent anchor that actually covers log entries (leaf_count > 0).
    // Empty-window heartbeat anchors are real but carry no content, so surfaces
    // that want to show "what's anchored" should prefer this one.
    const lastContentAnchor = db.prepare('SELECT * FROM anchors WHERE leaf_count > 0 ORDER BY id DESC LIMIT 1').get();
    res.json({
      chain: replayed,
      entries: replayed.checked,
      last_anchor: anchorView(lastAnchor),
      last_content_anchor: anchorView(lastContentAnchor),
      platform: {
        pubkey: keysmod.platformPubkey(),
        // The address that actually writes anchors: the anchoring adapter's sender
        // (the rpc anchorer key on a real chain, or the platform address for the
        // local simulated adapter). Falls back to the platform address if the
        // adapter can't be constructed.
        anchor_sender: (() => {
          try { return require('./anchor').createAnchorAdapter(db, process.env).sender; }
          catch { return eip712.addressOf(keysmod.platformPubkey()); }
        })(),
        eip712_domain: { name: eip712.DOMAIN_NAME, version: eip712.DOMAIN_VERSION, chain_id: eip712.chainId() },
      },
    });
  });

  // Pacta's published platform pubkey — what receipt verifiers check pacta_sig
  // against.
  router.get('/keys/platform', (req, res) => {
    res.json({
      pubkey: keysmod.platformPubkey(),
      address: eip712.addressOf(keysmod.platformPubkey()),
      eip712_domain: { name: eip712.DOMAIN_NAME, version: eip712.DOMAIN_VERSION, chain_id: eip712.chainId() },
    });
  });

  // Register a self-custody signing key (or rotate to one). Custodial keys
  // are created automatically at first signature; this is the upgrade path.
  for (const kind of ['agent', 'smb']) {
    router.post(`/${kind}s/:id/signing-key`, (req, res) => {
      const row = db.prepare(`SELECT id FROM ${kind}s WHERE id = ?`).get(req.params.id);
      if (!row) throw new ApiError(404, `${kind} not found`);
      hard.requireActor(req, kind, row.id);
      const body = requireBody(req, ['pubkey']);
      const key = withTx(db, () => {
        const saved = keysmod.registerKey(db, kind, Number(row.id), { pubkey: String(body.pubkey), custody: 'self' });
        eventlog.append(db, {
          engagement: 'platform', type: 'KeyRegistered',
          payload: { owner: `${kind === 'agent' ? 'agt' : 'smb'}_${row.id}`, pubkey: saved.pubkey, custody: 'self' },
        });
        return saved;
      });
      res.status(201).json({
        [`${kind}_id`]: Number(row.id), pubkey: key.pubkey, custody: key.custody,
      });
    });
  }

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
    if (err instanceof ApiError || err instanceof LedgerError
        || err instanceof RegistryUnavailableError || err instanceof HardeningError
        || err instanceof SettlementError || err instanceof keysmod.KeyError) {
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
