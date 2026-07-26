'use strict';
// Registry adapters: the pluggable trust anchor behind registry-verified proofs.
//
// A proof is only as strong as the registry it is checked against. This module
// owns that boundary. Every adapter implements one small contract:
//
//   name              short identifier, reported in /api/config
//   async lookup(ref) resolves to a record or null
//
// A record is { ref, kind, title, issued_to, details, created_at, source }.
// `null` means "the registry answered and the reference does not exist".
// A registry that cannot answer (network down, upstream error, malformed
// response) throws RegistryUnavailableError instead: the protocol refuses to
// guess, and the API surfaces it as 502 rather than treating the proof as
// unverified or, worse, verified.
//
// Selection mirrors src/llm.js: setting REGISTRY_URL implies the generic http
// adapter; REGISTRY_ADAPTER forces one of local | http | hacienda-cr; the
// default is the local adapter, which reads the seeded registry_records table
// and keeps every demo and test fully deterministic.

class RegistryUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.status = 502;
  }
}

// The reference implementation: the registry_records SQLite table this codebase
// has always verified against. Deterministic, offline, seeded with demo data.
class LocalRegistryAdapter {
  constructor(db) {
    this.db = db;
    this.name = 'local';
  }

  async lookup(ref) {
    const r = this.db.prepare('SELECT * FROM registry_records WHERE ref = ?').get(String(ref));
    if (!r) return null;
    return {
      ref: r.ref,
      kind: r.kind,
      title: r.title,
      issued_to: r.issued_to,
      details: r.details,
      created_at: r.created_at,
      source: this.name,
    };
  }
}

// Generic adapter for any registry gateway that speaks a minimal JSON contract:
//   GET {baseUrl}/{ref} -> 200 { ref, kind, title, issued_to?, details?, created_at? }
//                          404 when the reference does not exist
// This is the integration point for real public-records systems: put a small
// gateway in front of the source (scraper, SOAP bridge, database mirror) and
// point REGISTRY_URL at it.
class HttpRegistryAdapter {
  constructor({ baseUrl, timeoutMs = 8000, headers = {} } = {}) {
    if (!baseUrl) throw new Error('HttpRegistryAdapter requires a baseUrl');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.headers = headers;
    this.name = 'http';
  }

  async lookup(ref) {
    const url = `${this.baseUrl}/${encodeURIComponent(String(ref))}`;
    let res;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', ...this.headers },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RegistryUnavailableError(`registry endpoint unreachable: ${err.message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new RegistryUnavailableError(`registry endpoint answered ${res.status}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new RegistryUnavailableError('registry endpoint returned a non-JSON body');
    }
    if (!body || body.ref !== String(ref) || typeof body.kind !== 'string' || typeof body.title !== 'string') {
      throw new RegistryUnavailableError('registry endpoint returned a malformed record');
    }
    return {
      ref: body.ref,
      kind: body.kind,
      title: body.title,
      issued_to: typeof body.issued_to === 'string' ? body.issued_to : '',
      details: typeof body.details === 'string' ? body.details : '',
      created_at: typeof body.created_at === 'string' ? body.created_at : null,
      source: this.name,
    };
  }
}

// A real public registry, no API key required: Costa Rica's tax authority
// (Ministerio de Hacienda) publishes the tax status of any cedula at
//   GET https://api.hacienda.go.cr/fe/ae?identificacion={cedula}
// The reference is the cedula itself, with or without dashes
// (3-101-123456 and 3101123456 both work). A live record proves the entity
// exists and is registered with the tax authority, so it maps to the
// verification kind 'tax_registration'.
class HaciendaCrAdapter {
  constructor({ baseUrl = 'https://api.hacienda.go.cr/fe/ae', timeoutMs = 8000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.name = 'hacienda-cr';
  }

  async lookup(ref) {
    const cedula = String(ref).replace(/-/g, '');
    // Not a cedula: this registry cannot hold it, answer "not found" locally.
    if (!/^\d{9,12}$/.test(cedula)) return null;
    let res;
    try {
      res = await fetch(`${this.baseUrl}?identificacion=${cedula}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RegistryUnavailableError(`Hacienda endpoint unreachable: ${err.message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new RegistryUnavailableError(`Hacienda endpoint answered ${res.status}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new RegistryUnavailableError('Hacienda endpoint returned a non-JSON body');
    }
    if (!body || typeof body.nombre !== 'string' || typeof body.situacion !== 'object') {
      throw new RegistryUnavailableError('Hacienda endpoint returned an unexpected shape');
    }
    const situacion = body.situacion || {};
    const actividades = Array.isArray(body.actividades)
      ? body.actividades.filter((a) => a && a.estado === 'A').map((a) => a.descripcion).filter(Boolean)
      : [];
    const detailParts = [];
    if (situacion.estado) detailParts.push(`estado: ${situacion.estado}`);
    if (situacion.moroso) detailParts.push(`moroso: ${situacion.moroso}`);
    if (situacion.omiso) detailParts.push(`omiso: ${situacion.omiso}`);
    if (actividades.length > 0) detailParts.push(`actividades: ${actividades.join('; ')}`);
    return {
      ref: String(ref),
      kind: 'tax_registration',
      title: `Tax registration: ${body.nombre}`,
      issued_to: body.nombre,
      details: detailParts.join(' | '),
      created_at: null,
      source: this.name,
    };
  }
}

const ADAPTERS = ['local', 'http', 'hacienda-cr'];

function createRegistryAdapter(db, env = process.env) {
  const forced = (env.REGISTRY_ADAPTER || '').trim().toLowerCase();
  const url = (env.REGISTRY_URL || '').trim();
  const timeoutMs = Number(env.REGISTRY_TIMEOUT_MS || 8000);
  const choice = forced || (url ? 'http' : 'local');
  if (!ADAPTERS.includes(choice)) {
    throw new Error(`unknown REGISTRY_ADAPTER '${forced}' (expected one of: ${ADAPTERS.join(', ')})`);
  }
  if (choice === 'http') {
    if (!url) throw new Error('REGISTRY_ADAPTER=http requires REGISTRY_URL');
    return new HttpRegistryAdapter({ baseUrl: url, timeoutMs });
  }
  if (choice === 'hacienda-cr') {
    return new HaciendaCrAdapter(url ? { baseUrl: url, timeoutMs } : { timeoutMs });
  }
  return new LocalRegistryAdapter(db);
}

module.exports = {
  createRegistryAdapter,
  LocalRegistryAdapter,
  HttpRegistryAdapter,
  HaciendaCrAdapter,
  RegistryUnavailableError,
};
