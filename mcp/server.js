'use strict';
// MCP server exposing Pacta (the Agent Services Marketplace) to any AI agent.
// Wraps the Pacta REST API 1:1 as MCP tools over stdio — the same surface a
// production integration would offer to Claude, GPT or any MCP-capable agent.
//
// Env: MARKETPLACE_URL (default http://localhost:3220), AGENT_ID (default 1).
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE = (process.env.MARKETPLACE_URL || 'http://localhost:3220').replace(/\/$/, '');
const AGENT_ID = Number(process.env.AGENT_ID || 1);

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `${method} ${path} → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US');

// Trim API payloads to what an agent needs — smaller context, clearer decisions.
const offerSummary = (o) => ({
  offer_id: o.id,
  title: o.title,
  price: usd(o.price_cents),
  escrow_terms: `${o.upfront_pct}% downpayment, ${100 - o.upfront_pct}% on completion`,
  steps: o.steps.map((s) => ({
    position: s.position, title: s.title,
    ...(s.verification_kind ? { requires_registry_proof: s.verification_kind } : {}),
  })),
  provider: {
    smb_id: o.smb.id, name: o.smb.name, location: o.smb.location, category: o.smb.category,
    vetted: o.smb.vetted,
    ...(o.smb.stake_cents !== undefined ? { collateral_at_stake: usd(o.smb.stake_cents) } : {}),
    rating: `${o.smb.rating.good} good / ${o.smb.rating.bad} bad (score ${o.smb.rating.score})`,
  },
});

const engagementSummary = (e) => ({
  engagement_id: e.id,
  state: e.state,
  title: e.title,
  price: usd(e.price_cents),
  escrow_balance: usd(e.escrow_balance_cents),
  downpayment: usd(e.upfront_cents),
  due_on_completion: usd(e.remaining_cents),
  provider: e.smb.name,
  steps: e.steps.map((s) => ({
    position: s.position,
    title: s.title,
    status: s.status,
    ...(s.proof_text ? { proof: s.proof_text } : {}),
    ...(s.verification_kind ? { requires_registry_proof: s.verification_kind } : {}),
    ...(s.proof_registry_ref ? { registry_ref: s.proof_registry_ref, verified_by_platform: s.proof_verified } : {}),
  })),
  ...(e.dispute_reason ? { dispute_reason: e.dispute_reason } : {}),
  ...(e.resolution ? { resolution: e.resolution } : {}),
  ...(e.rating ? { your_rating: e.rating } : {}),
});

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Error${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}` }],
});
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); } catch (err) { return fail(err); }
};

const server = new McpServer({ name: 'agent-services-marketplace', version: '1.0.0' });

server.tool(
  'search_offers',
  'Search the marketplace for real-world services offered by vetted SMBs. Results are ranked by provider rating, then price.',
  { query: z.string().describe('Keywords, e.g. "lawyer Costa Rica hotel"'), category: z.string().optional().describe('legal | tourism | real-estate | accounting') },
  wrap(async ({ query, category }) => {
    const params = new URLSearchParams({ q: query });
    if (category) params.set('category', category);
    const offers = await api('GET', `/offers?${params}`);
    return { results: offers.map(offerSummary) };
  }),
);

server.tool(
  'get_offer',
  'Full detail of one offer: fulfillment steps, escrow terms and provider profile.',
  { offer_id: z.number().int() },
  wrap(async ({ offer_id }) => offerSummary(await api('GET', `/offers/${offer_id}`))),
);

server.tool(
  'create_engagement',
  'Create a draft contract from an offer. The offer steps are snapshotted; nothing is binding or paid yet.',
  { offer_id: z.number().int() },
  wrap(async ({ offer_id }) => engagementSummary(await api('POST', '/engagements', { offer_id, agent_id: AGENT_ID }))),
);

server.tool(
  'agree_to_contract',
  'Lock the engagement terms and steps into an immutable contract (draft → agreed). After this, steps cannot be modified by anyone.',
  { engagement_id: z.number().int() },
  wrap(async ({ engagement_id }) => engagementSummary(await api('POST', `/engagements/${engagement_id}/agree`, {}))),
);

server.tool(
  'fund_escrow',
  'Move the agreed downpayment from your balance into the engagement escrow account. The provider cannot start work before this.',
  { engagement_id: z.number().int() },
  wrap(async ({ engagement_id }) => engagementSummary(await api('POST', `/engagements/${engagement_id}/fund`, {}))),
);

server.tool(
  'get_engagement',
  'Current state of an engagement: steps, proofs, platform verification flags, and escrow balance.',
  { engagement_id: z.number().int() },
  wrap(async ({ engagement_id }) => engagementSummary(await api('GET', `/engagements/${engagement_id}`))),
);

server.tool(
  'wait_for_provider_submission',
  'Block until the provider finishes all steps and submits the engagement for your verification (or time out). Use after funding escrow.',
  { engagement_id: z.number().int(), timeout_seconds: z.number().int().min(1).max(120).optional() },
  wrap(async ({ engagement_id, timeout_seconds = 60 }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    for (;;) {
      const e = await api('GET', `/engagements/${engagement_id}`);
      if (e.state !== 'funded' && e.state !== 'in_progress') return engagementSummary(e);
      if (Date.now() > deadline) {
        return { timed_out: true, note: `provider still working after ${timeout_seconds}s`, ...engagementSummary(e) };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }),
);

server.tool(
  'verify_registry_reference',
  'Independently verify a proof against the public registry (company registry, municipal permits, tax authority). Returns the official record or an error if it does not exist.',
  { ref: z.string().describe('e.g. CR-RN-2026-104512') },
  wrap(async ({ ref }) => api('GET', `/registry/${encodeURIComponent(ref)}`)),
);

server.tool(
  'approve_and_release_payment',
  'Accept the delivered proofs. Draws the remaining balance from your account and releases the FULL price to the provider. Irreversible — verify the proofs first.',
  { engagement_id: z.number().int() },
  wrap(async ({ engagement_id }) => engagementSummary(await api('POST', `/engagements/${engagement_id}/approve`, {}))),
);

server.tool(
  'reject_and_open_dispute',
  'Reject the delivered proofs with a reason. Escrow is held and a neutral arbiter will rule (release / refund / split). The provider risks its stake.',
  { engagement_id: z.number().int(), reason: z.string() },
  wrap(async ({ engagement_id, reason }) => engagementSummary(await api('POST', `/engagements/${engagement_id}/reject`, { reason }))),
);

server.tool(
  'rate_provider',
  'Rate the provider after settlement (good or bad). Ratings are tied to real settled money and drive search ranking.',
  { engagement_id: z.number().int(), value: z.enum(['good', 'bad']) },
  wrap(async ({ engagement_id, value }) => engagementSummary(await api('POST', `/engagements/${engagement_id}/rate`, { value }))),
);

server.tool(
  'get_my_balance',
  'Your current simulated USD balance.',
  {},
  wrap(async () => {
    const a = await api('GET', `/agents/${AGENT_ID}`);
    return { agent: a.name, balance: usd(a.balance_cents) };
  }),
);

(async () => {
  await server.connect(new StdioServerTransport());
  console.error(`[mcp] agent-services-marketplace connected (marketplace: ${BASE}, agent #${AGENT_ID})`);
})();
