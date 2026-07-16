'use strict';
// One-command, self-verifying end-to-end demo: an AI agent buys a real-world
// service through MCP.
//
//   npm run demo:agent           → deterministic MCP-client agent (no API keys)
//   npm run demo:agent:claude    → a real Claude agent drives the same MCP tools
//                                  (requires the `claude` CLI to be installed)
//
// What it does: fresh Pacta marketplace on port 3230 + an SMB bot playing the
// provider side + the buying agent over MCP. Afterwards it independently audits
// the outcome via the REST API (engagement completed, provider paid in full,
// escrow zero, rating recorded, ledger balanced) and exits non-zero on any miss.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.DEMO_PORT || 3230);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, 'data', 'agent-demo.db');
const CLAUDE_MODE = process.argv.includes('--claude');

const children = [];
function launch(name, args, env = {}) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
  p.stdout.on('data', (d) => process.stdout.write(prefix(name, d)));
  p.stderr.on('data', (d) => process.stderr.write(prefix(name, d)));
  children.push(p);
  return p;
}
const prefix = (name, d) => d.toString().split('\n').filter((l) => l.trim()).map((l) => `[${name}] ${l}\n`).join('');
const cleanup = () => children.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function api(pathname) {
  const res = await fetch(`${BASE}/api${pathname}`);
  return res.json();
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server at ${url} did not come up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  console.log('═'.repeat(72));
  console.log('  AGENT PURCHASE DEMO — an AI agent hires a law firm through MCP');
  console.log('═'.repeat(72));

  // Fresh marketplace, fresh money, fresh reputation.
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  launch('marketplace', ['server-pacta.js'], { PORT: String(PORT), DB_PATH: DB, PACTA: '1' });
  await waitFor(`${BASE}/api/ledger/invariant`);
  console.log(`[demo] Pacta marketplace fresh on port ${PORT} (staking + registry verification on)`);

  launch('smb-bot', [path.join('scripts', 'smb-bot.js')], { MARKETPLACE_URL: BASE });

  // Snapshot the "before" picture for the audit.
  const agentBefore = await api('/agents/1');
  const bufeteBefore = await api('/smbs/1');

  let agentExit;
  if (CLAUDE_MODE) {
    const mission =
      'You are the Realtor Assistant Agent (agent id 1) buying on behalf of a client. ' +
      'MISSION: get a Costa Rican company established that can buy land and operate a hotel. Budget: $6,000. ' +
      'Use ONLY the marketplace MCP tools. Search for a suitable vetted provider, review the offer steps and terms, ' +
      'create the engagement, agree to lock the contract, fund the escrow, then wait for the provider to submit. ' +
      'CRITICAL: before approving, independently verify EVERY registry-anchored proof with verify_registry_reference ' +
      'and check the record kind matches the step requirement. Approve and release payment only if all proofs verify; ' +
      'otherwise reject with a reason. After settlement, rate the provider. ' +
      'Finish with a short report: what you bought, from whom, what you paid, and what you verified.';
    const mcpConfig = { mcpServers: { marketplace: {
      command: process.execPath,
      args: [path.join(ROOT, 'mcp', 'server.js')],
      env: { MARKETPLACE_URL: BASE, AGENT_ID: '1' },
    } } };
    const cfgPath = path.join(ROOT, 'data', 'agent-demo-mcp.json');
    fs.writeFileSync(cfgPath, JSON.stringify(mcpConfig, null, 2));
    console.log('[demo] launching a real Claude agent with the marketplace MCP server...');
    agentExit = await new Promise((resolve) => {
      // async spawn (not spawnSync): the event loop must stay alive so the
      // marketplace/smb-bot pipes keep draining during the multi-minute agent run.
      const p = spawn('claude', [
        '-p', mission,
        '--mcp-config', cfgPath,
        '--allowedTools', 'mcp__marketplace__*',
        '--max-turns', '40',
      ], { cwd: ROOT });
      children.push(p);
      p.stdout.on('data', (d) => process.stdout.write(prefix('claude-agent', d)));
      p.stderr.on('data', (d) => process.stderr.write(prefix('claude-agent', d)));
      const timer = setTimeout(() => { p.kill(); resolve(124); }, 600_000);
      p.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    });
  } else {
    agentExit = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'agent-client.js')], {
        cwd: ROOT, stdio: 'inherit', env: { ...process.env, MARKETPLACE_URL: BASE },
      });
      children.push(p);
      p.on('exit', (code) => resolve(code ?? 1));
    });
  }
  if (agentExit !== 0) throw new Error(`agent process exited with code ${agentExit}`);

  // ---- Independent audit via the REST API (not the agent's own claims) --------
  await waitFor(`${BASE}/api/ledger/invariant`);
  console.log('\n' + '─'.repeat(72));
  console.log('  INDEPENDENT AUDIT (REST API, not the agent\'s claims)');
  console.log('─'.repeat(72));
  const checks = [];
  const check = (name, cond, detail) => {
    checks.push(cond);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const engagements = await api('/engagements?agent_id=1');
  const done = engagements.find((e) => e.state === 'completed');
  check('engagement completed', Boolean(done), done && `#${done.id} "${done.title}"`);
  if (done) {
    check('all steps proven', done.steps_done === done.steps_total, `${done.steps_done}/${done.steps_total}`);
    check('every registry-anchored proof platform-verified',
      done.steps.filter((s) => s.verification_kind).every((s) => s.proof_verified),
      done.steps.filter((s) => s.verification_kind).map((s) => s.proof_registry_ref).join(', '));
    check('escrow zeroed', done.escrow_balance_cents === 0);
    check('provider rated', done.rating !== null, `rating: ${done.rating}`);
  }
  const agentAfter = await api('/agents/1');
  const bufeteAfter = await api('/smbs/1');
  check('agent paid exactly the price',
    done && agentBefore.balance_cents - agentAfter.balance_cents === done.price_cents,
    done && `$${(agentBefore.balance_cents - agentAfter.balance_cents) / 100} of $${done.price_cents / 100}`);
  check('provider received the full price',
    done && bufeteAfter.balance_cents - bufeteBefore.balance_cents === done.price_cents,
    `provider balance +$${(bufeteAfter.balance_cents - bufeteBefore.balance_cents) / 100}`);
  const inv = await api('/ledger/invariant');
  check('ledger invariant holds', inv.ok, `Σ balances = Σ minted = $${inv.total_minted_cents / 100}`);

  const allPass = checks.every(Boolean);
  console.log('─'.repeat(72));
  console.log(allPass
    ? '  ✅ DEMO VERIFIED END-TO-END: discovered, contracted, escrowed, delivered,\n     independently verified against the public registry, paid, and rated — via MCP.'
    : '  ❌ DEMO FAILED VERIFICATION — see FAIL lines above.');
  console.log('═'.repeat(72));
  process.exitCode = allPass ? 0 : 1;
}

main().catch((err) => {
  console.error(`[demo] ${err.message}`);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
