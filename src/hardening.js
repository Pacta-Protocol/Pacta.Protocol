'use strict';
// Production hardening: API keys, rate limiting, idempotency keys and provider
// webhooks. Everything here is additive to the protocol: with the default
// configuration the API behaves exactly as before (open, deliberately, as the
// spec's simulation boundary documents), and each protection is turned on by
// configuration:
//
//   REQUIRE_API_KEYS=1     mutations must carry a valid actor key
//   ARBITER_API_KEY=...    key the arbiter must present to resolve disputes
//   RATE_LIMIT_PER_MIN=n   requests per minute per client (default 600, 0 = off)
//
// Idempotency keys and provider webhooks are always available: they only act
// when a client sends an Idempotency-Key header or an SMB registers a webhook.
const crypto = require('node:crypto');

class HardeningError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createHardening(db, opts = {}, env = process.env) {
  const requireKeys = opts.requireKeys ?? env.REQUIRE_API_KEYS === '1';
  const arbiterKey = opts.arbiterKey ?? (env.ARBITER_API_KEY || null);
  const rateLimitPerMin = opts.rateLimitPerMin ?? Number(env.RATE_LIMIT_PER_MIN ?? 600);
  const webhookTimeoutMs = opts.webhookTimeoutMs ?? 5000;

  // ---------- API keys ---------------------------------------------------------
  // Keys look like pk_agent_... / pk_smb_...; only the SHA-256 hash is stored.

  const TABLE = { agent: 'agents', smb: 'smbs' };

  function issueKey(kind, id) {
    const key = `pk_${kind}_${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare(`UPDATE ${TABLE[kind]} SET api_key_hash = ? WHERE id = ?`).run(sha256(key), id);
    return key;
  }

  // Bootstrap for entities that predate keys (seeded demo data): the first
  // claim on a keyless identity is open; after that, rotation requires
  // presenting the current key. Demo-grade by design, noted in the gaps doc.
  function claimKey(kind, id, presentedKey) {
    const row = db.prepare(`SELECT id, api_key_hash FROM ${TABLE[kind]} WHERE id = ?`).get(id);
    if (!row) throw new HardeningError(404, `${kind} not found`);
    if (row.api_key_hash) {
      if (!presentedKey || sha256(presentedKey) !== row.api_key_hash) {
        throw new HardeningError(403, `this ${kind} already has an API key; present it to rotate`);
      }
    }
    return issueKey(kind, id);
  }

  function bearer(req) {
    const h = req.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : null;
  }

  // Resolves the Authorization header to an actor { kind, id } when present.
  function actorOf(req) {
    const key = bearer(req);
    if (!key) return null;
    const hash = sha256(key);
    for (const kind of ['agent', 'smb']) {
      const row = db.prepare(`SELECT id FROM ${TABLE[kind]} WHERE api_key_hash = ?`).get(hash);
      if (row) return { kind, id: Number(row.id) };
    }
    return null;
  }

  // Enforcement guard: a no-op until REQUIRE_API_KEYS is on. `id` may be a
  // single id or a list of acceptable ids for the given kind.
  function requireActor(req, kind, id) {
    if (!requireKeys) return;
    const actor = actorOf(req);
    if (!actor) throw new HardeningError(401, 'this operation requires an API key (Authorization: Bearer pk_...)');
    const allowed = Array.isArray(id) ? id.map(Number) : [Number(id)];
    if (actor.kind !== kind || !allowed.includes(actor.id)) {
      throw new HardeningError(403, `this operation belongs to ${kind} ${allowed.join(' or ')}`);
    }
  }

  // Either side of an engagement may act (draft edits, agreement).
  function requireParty(req, engagement) {
    if (!requireKeys) return;
    const actor = actorOf(req);
    if (!actor) throw new HardeningError(401, 'this operation requires an API key (Authorization: Bearer pk_...)');
    const isAgent = actor.kind === 'agent' && actor.id === Number(engagement.agent_id);
    const isSmb = actor.kind === 'smb' && actor.id === Number(engagement.smb_id);
    if (!isAgent && !isSmb) {
      throw new HardeningError(403, 'only a party to this engagement may do this');
    }
  }

  function requireArbiter(req) {
    if (!requireKeys) return;
    if (!arbiterKey) throw new HardeningError(403, 'no arbiter key is configured on this server');
    if (bearer(req) !== arbiterKey) throw new HardeningError(403, 'dispute resolution requires the arbiter key');
  }

  // ---------- rate limiting ----------------------------------------------------
  // Fixed one-minute window per client (API key when present, IP otherwise).
  // In-memory on purpose: single-process deployment, no new dependencies.

  const windows = new Map();
  function rateLimiter(req, res, next) {
    if (!rateLimitPerMin) return next();
    const client = bearer(req) || req.ip || 'unknown';
    const windowId = Math.floor(Date.now() / 60_000);
    const slot = windows.get(client);
    if (!slot || slot.windowId !== windowId) {
      if (windows.size > 10_000) windows.clear(); // crude bound on memory
      windows.set(client, { windowId, count: 1 });
      return next();
    }
    slot.count += 1;
    if (slot.count > rateLimitPerMin) {
      res.set('retry-after', '60');
      return res.status(429).json({ error: `rate limit exceeded: ${rateLimitPerMin} requests per minute` });
    }
    next();
  }

  // ---------- idempotency keys -------------------------------------------------
  // Money-moving POSTs honor an Idempotency-Key header: the first successful
  // response is stored and replayed verbatim on retries, so a client that
  // times out and retries can never move money twice. Only 2xx responses are
  // stored; a failed call may be retried with the same key.

  function idempotent(req, res, next) {
    const key = req.get('idempotency-key');
    if (!key) return next();
    const scope = `${req.method} ${req.originalUrl}`;
    const row = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key);
    if (row) {
      if (row.scope !== scope) {
        return res.status(422).json({ error: `Idempotency-Key was already used for '${row.scope}'` });
      }
      res.set('idempotency-replayed', 'true');
      return res.status(Number(row.status)).type('application/json').send(row.body);
    }
    const json = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, scope, status, body) VALUES (?, ?, ?, ?)')
          .run(key, scope, res.statusCode, JSON.stringify(payload));
      }
      return json(payload);
    };
    next();
  }

  // ---------- provider webhooks ------------------------------------------------
  // Push instead of poll for the SMB side: when an engagement they are party to
  // changes state, POST a signed event to their registered URL. Delivery is
  // best-effort (one attempt, short timeout); the protocol state is always
  // available to poll as the source of truth.

  function setWebhook(smbId, url) {
    const smb = db.prepare('SELECT id FROM smbs WHERE id = ?').get(smbId);
    if (!smb) throw new HardeningError(404, 'SMB not found');
    if (!url) {
      db.prepare('UPDATE smbs SET webhook_url = NULL, webhook_secret = NULL WHERE id = ?').run(smbId);
      return null;
    }
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new HardeningError(400, 'webhook url must be a valid http(s) URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new HardeningError(400, 'webhook url must be a valid http(s) URL');
    }
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare('UPDATE smbs SET webhook_url = ?, webhook_secret = ? WHERE id = ?').run(String(url), secret, smbId);
    return secret;
  }

  function notifyProvider(engagementId, event) {
    const e = db.prepare('SELECT * FROM engagements WHERE id = ?').get(engagementId);
    if (!e) return;
    const smb = db.prepare('SELECT webhook_url, webhook_secret FROM smbs WHERE id = ?').get(e.smb_id);
    if (!smb || !smb.webhook_url) return;
    const payload = JSON.stringify({
      event,
      engagement_id: Number(e.id),
      state: e.state,
      title: e.title,
      price_cents: Number(e.price_cents),
      at: new Date().toISOString(),
    });
    const signature = `sha256=${crypto.createHmac('sha256', smb.webhook_secret).update(payload).digest('hex')}`;
    fetch(smb.webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pacta-signature': signature },
      body: payload,
      signal: AbortSignal.timeout(webhookTimeoutMs),
    }).catch((err) => {
      console.warn(`[webhook] delivery to SMB ${e.smb_id} failed: ${err.message}`);
    });
  }

  return {
    enabled: { requireKeys, rateLimitPerMin },
    issueKey,
    claimKey,
    requireActor,
    requireParty,
    requireArbiter,
    rateLimiter,
    idempotent,
    setWebhook,
    notifyProvider,
  };
}

module.exports = { createHardening, HardeningError };
