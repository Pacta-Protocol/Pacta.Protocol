'use strict';
// The buying agent for `npm run demo:agent` — a deterministic MCP *client* that
// consumes the marketplace exclusively through the MCP server (mcp/server.js),
// exactly like an LLM agent would: same tools, same payloads, same order of
// decisions. Use `npm run demo:agent:claude` to have a real Claude agent drive
// the identical tool surface.
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const MARKETPLACE_URL = process.env.MARKETPLACE_URL || 'http://localhost:3230';
const MISSION = 'Establish a Costa Rican company able to buy land and operate a hotel, budget $6,000.';

const say = (msg) => console.log(`[agent] ${msg}`);

async function main() {
  const client = new Client({ name: 'realtor-assistant-agent', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { ...process.env, MARKETPLACE_URL },
    stderr: 'ignore',
  }));

  const tool = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    if (res.isError) throw new Error(`${name}: ${text}`);
    console.log(`\n→ MCP tool: ${name}(${JSON.stringify(args)})`);
    console.log(text.split('\n').map((l) => `   ${l}`).join('\n'));
    return JSON.parse(text);
  };

  say(`MISSION: ${MISSION}`);
  const { tools } = await client.listTools();
  say(`connected to MCP server — ${tools.length} tools available: ${tools.map((t) => t.name).join(', ')}`);

  // 1. Discover
  const balance0 = await tool('get_my_balance');
  const search = await tool('search_offers', { query: 'lawyer Costa Rica company hotel', category: 'legal' });
  const candidates = search.results.filter((o) => o.provider.vetted);
  if (!candidates.length) throw new Error('no vetted providers found');
  // Pick the offer that actually covers the mission (land + hotel capable company),
  // preferring registry-verifiable steps, then ranking (results come pre-ranked).
  const pick = candidates.find((o) => /land|hotel/i.test(o.title) && o.steps.some((s) => s.requires_registry_proof))
    || candidates[0];
  say(`selected "${pick.title}" by ${pick.provider.name} — ${pick.price}, ` +
      `provider has ${pick.provider.collateral_at_stake} collateral at stake, rating ${pick.provider.rating}`);

  // 2. Contract
  const draft = await tool('create_engagement', { offer_id: pick.offer_id });
  say(`draft contract #${draft.engagement_id} created with ${draft.steps.length} locked-in steps`);
  const agreed = await tool('agree_to_contract', { engagement_id: draft.engagement_id });
  say(`terms locked: ${agreed.downpayment} down, ${agreed.due_on_completion} on completion`);

  // 3. Escrow
  const funded = await tool('fund_escrow', { engagement_id: draft.engagement_id });
  say(`escrow funded with ${funded.escrow_balance} — provider can start work`);

  // 4. Wait for delivery
  say('waiting for the provider to deliver...');
  const delivered = await tool('wait_for_provider_submission', { engagement_id: draft.engagement_id, timeout_seconds: 60 });
  if (delivered.state !== 'submitted') throw new Error(`expected submission, got state '${delivered.state}'`);
  say(`provider submitted all ${delivered.steps.length} steps with proofs`);

  // 5. Verify every registry-anchored proof INDEPENDENTLY against the public registry
  let allVerified = true;
  for (const step of delivered.steps) {
    if (!step.registry_ref) continue;
    try {
      const record = await tool('verify_registry_reference', { ref: step.registry_ref });
      const kindOk = record.kind === step.requires_registry_proof;
      say(`step ${step.position} proof ${step.registry_ref}: ${kindOk ? 'VERIFIED' : 'KIND MISMATCH'} — "${record.title}"`);
      if (!kindOk) allVerified = false;
    } catch (err) {
      say(`step ${step.position} proof ${step.registry_ref}: FAILED verification (${err.message})`);
      allVerified = false;
    }
  }

  // 6. Settle
  if (!allVerified) {
    const disputed = await tool('reject_and_open_dispute', {
      engagement_id: draft.engagement_id, reason: 'Registry verification failed for one or more proofs.',
    });
    say(`proofs failed verification — dispute opened (state: ${disputed.state})`);
    process.exitCode = 2;
    return;
  }
  const completed = await tool('approve_and_release_payment', { engagement_id: draft.engagement_id });
  say(`approved: full ${completed.price} released to ${completed.provider}, escrow now ${completed.escrow_balance}, state '${completed.state}'`);

  // 7. Rate
  await tool('rate_provider', { engagement_id: draft.engagement_id, value: 'good' });
  const balance1 = await tool('get_my_balance');
  say(`rated the provider 'good'. Balance: ${balance0.balance} → ${balance1.balance}`);
  say('MISSION COMPLETE — the company setup was contracted, escrowed, delivered, independently verified and paid, all via MCP.');

  await client.close();
}

main().catch((err) => {
  console.error(`[agent] FAILED: ${err.message}`);
  process.exit(1);
});
