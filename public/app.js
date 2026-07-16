'use strict';
/* Pacta (Agent Services Marketplace) — vanilla JS SPA.
 * Hash routing (refresh-safe), one role switcher, consumes the same REST API
 * a real agent would call. No build step. */

(() => {
  const $ = (sel, root) => (root || document).querySelector(sel);

  const state = {
    users: { agents: [], smbs: [], arbiters: [] },
    role: loadRole(), // { kind: 'agent'|'smb'|'arbiter', id } — persisted across refreshes
    lastSearch: { q: '', category: '', vetted: false },
    config: { plan: 'base', features: {} },
  };
  const pacta = () => state.config.plan === 'pacta';

  // ---------- utilities -------------------------------------------------------

  const esc = (s) => String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

  const fmt = (cents) => {
    const dollars = cents / 100;
    return '$' + dollars.toLocaleString('en-US', {
      minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
      maximumFractionDigits: 2,
    });
  };

  const STATE_LABELS = {
    draft: 'Draft', agreed: 'Agreed', funded: 'Escrow funded', in_progress: 'In progress',
    submitted: 'Submitted for verification', completed: 'Completed', disputed: 'Disputed', resolved: 'Resolved',
  };

  class ApiFailure extends Error {}

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiFailure((data && data.error) || `${method} ${path} failed (${res.status})`);
    return data;
  }

  function showError(msg) {
    const banner = $('#error-banner');
    banner.hidden = false;
    banner.innerHTML = `<span>⚠️ ${esc(msg)}</span><button type="button" data-action="dismiss-error">Dismiss</button>`;
  }
  function clearError() {
    const banner = $('#error-banner');
    banner.hidden = true;
    banner.innerHTML = '';
  }

  // ---------- role handling ----------------------------------------------------

  const roleKey = (r) => (r ? `${r.kind}:${r.id}` : '');
  function loadRole() {
    try {
      const raw = localStorage.getItem('asm-role');
      if (raw) {
        const [kind, id] = raw.split(':');
        if (['agent', 'smb', 'arbiter'].includes(kind) && Number(id)) return { kind, id: Number(id) };
      }
    } catch { /* private mode */ }
    return null;
  }
  function saveRole(r) {
    try { localStorage.setItem('asm-role', roleKey(r)); } catch { /* private mode */ }
  }

  function currentRoleEntity() {
    if (!state.role) return null;
    const pool = state.role.kind === 'agent' ? state.users.agents
      : state.role.kind === 'smb' ? state.users.smbs : state.users.arbiters;
    return pool.find((u) => u.id === state.role.id) || null;
  }

  async function refreshUsers() {
    state.users = await api('GET', '/users');
    if (!state.role || !currentRoleEntity()) {
      state.role = { kind: 'agent', id: state.users.agents[0].id };
      saveRole(state.role);
    }
  }

  function renderHeader() {
    const sel = $('#role-switcher');
    const options = [
      ...state.users.agents.map((a) => ({ key: `agent:${a.id}`, label: `Agent — ${a.name}` })),
      ...state.users.smbs.map((s) => ({ key: `smb:${s.id}`, label: `SMB — ${s.name}` })),
      ...state.users.arbiters.map((a) => ({ key: `arbiter:${a.id}`, label: `Arbiter — ${a.name}` })),
    ];
    sel.innerHTML = options.map((o) => `<option value="${o.key}">${esc(o.label)}</option>`).join('');
    sel.value = roleKey(state.role);

    const chip = $('#balance-chip');
    if (state.role.kind === 'agent') {
      const agent = currentRoleEntity();
      chip.hidden = false;
      chip.textContent = `Balance ${fmt(agent.balance_cents)}`;
    } else {
      chip.hidden = true;
      chip.textContent = '';
    }

    const links = {
      agent: [
        ['#/', 'Find services'], ['#/engagements', 'My engagements'], ['#/ledger', 'Ledger'],
      ],
      smb: [
        ['#/', 'My engagements'], ['#/profile', 'My profile & offers'], ['#/onboard', 'Onboarding'], ['#/ledger', 'Ledger'],
      ],
      arbiter: [
        ['#/', 'Disputes'], ['#/ledger', 'Ledger'],
      ],
    };
    const hash = location.hash || '#/';
    $('#nav').innerHTML = links[state.role.kind]
      .map(([href, label]) => `<a href="${href}" class="${hash === href ? 'active' : ''}">${esc(label)}</a>`)
      .join('');
  }

  // ---------- views ------------------------------------------------------------

  const view = () => $('#view');

  const ratingBadge = (r) => `<span class="badge rating" title="score ${r.score}">👍 ${r.good} · 👎 ${r.bad}</span>`;
  const vettedBadge = (smb) => {
    if (smb.vetted) return `<span class="badge vetted">Vetted ✓${pacta() ? ' · staked' : ''}</span>`;
    return pacta() ? '<span class="badge" style="background:#fdecea;color:#b42318" data-testid="unvetted-badge">No stake — not vetted</span>' : '';
  };
  const escrowTerms = (o) => `${o.upfront_pct}% downpayment · ${100 - o.upfront_pct}% on completion`;

  function offerCard(o) {
    return `
      <div class="card clickable" data-testid="offer-card" data-action="open-offer" data-id="${o.id}">
        <div class="row spread">
          <div class="grow">
            <div class="row">
              <strong>${esc(o.title)}</strong>
            </div>
            <div class="row small" style="margin-top:4px">
              <span>${esc(o.smb.name)}</span>
              ${vettedBadge(o.smb)}
              <span class="badge cat">${esc(o.smb.category)}</span>
              <span class="muted">📍 ${esc(o.smb.location)}</span>
              ${ratingBadge(o.smb.rating)}
            </div>
            <div class="muted" style="margin-top:6px">${esc(o.description)}</div>
          </div>
          <div class="right">
            <div class="price">${fmt(o.price_cents)}</div>
            <div class="muted">${escrowTerms(o)}</div>
            <div class="muted">${o.steps.length} steps</div>
          </div>
        </div>
      </div>`;
  }

  async function searchResultsHtml() {
    const { q, category, vetted } = state.lastSearch;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (category) params.set('category', category);
    if (vetted) params.set('vetted', 'true');
    const offers = await api('GET', '/offers' + (params.size ? `?${params}` : ''));
    return offers.length
      ? offers.map(offerCard).join('')
      : '<div class="empty" data-testid="empty-state">No offers match your search. Try fewer or different keywords.</div>';
  }

  async function viewSearch() {
    const { q, category, vetted } = state.lastSearch;
    return `
      <h1>Find services</h1>
      <p class="sub">Search vetted SMBs offering real-world services your agent can contract, escrow and verify.</p>
      <form class="search-bar" data-form="search">
        <input type="text" name="q" data-testid="search-input" placeholder="e.g. lawyer Costa Rica hotel" value="${esc(q)}">
        <select name="category" class="input" data-testid="category-filter">
          <option value="">All categories</option>
          ${['legal', 'tourism', 'real-estate', 'accounting'].map((c) => `<option value="${c}" ${c === category ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <label class="vetted-toggle" title="Show only SMBs with collateral staked">
          <input type="checkbox" name="vetted" data-testid="vetted-filter" ${vetted ? 'checked' : ''}>
          Vetted only
        </label>
        <button class="btn" type="submit" data-testid="search-button">Search</button>
      </form>
      <div data-testid="search-results">
        ${await searchResultsHtml()}
      </div>`;
  }

  async function viewOffer(id) {
    const o = await api('GET', `/offers/${id}`);
    const isAgent = state.role.kind === 'agent';
    return `
      <p class="small"><a href="#/">← Back to search</a></p>
      <div class="card">
        <div class="row spread">
          <div class="grow">
            <h1>${esc(o.title)}</h1>
            <div class="row small">
              <a href="#/smbs/${o.smb.id}">${esc(o.smb.name)}</a>
              ${vettedBadge(o.smb)}
              <span class="badge cat">${esc(o.smb.category)}</span>
              <span class="muted">📍 ${esc(o.smb.location)}</span>
              ${ratingBadge(o.smb.rating)}
            </div>
            <p>${esc(o.description)}</p>
          </div>
          <div class="right">
            <div class="price">${fmt(o.price_cents)}</div>
            <div class="muted">${escrowTerms(o)}</div>
          </div>
        </div>
        <h2>Fulfillment steps</h2>
        <ol class="steps">
          ${o.steps.map((s) => `
            <li>
              <div class="step-head">
                <span class="step-num">${s.position}</span>
                <div><strong>${esc(s.title)}</strong>
                  ${s.description ? `<div class="muted small">${esc(s.description)}</div>` : ''}
                </div>
              </div>
            </li>`).join('')}
        </ol>
        ${isAgent
          ? `<button class="btn" data-action="create-engagement" data-id="${o.id}" data-testid="create-engagement">
               Start engagement (draft)</button>
             <span class="muted small" style="margin-left:10px">Creates a draft contract with these steps; you agree &amp; fund next.</span>`
          : '<div class="notice">Switch to the Agent role to contract this offer.</div>'}
      </div>`;
  }

  function stepItem(e, s, role) {
    const canWork = role === 'smb' && ['funded', 'in_progress'].includes(e.state) && s.status !== 'done';
    return `
      <li class="${s.status === 'done' ? 'done' : ''}" data-testid="step-row-${s.position}">
        <div class="step-head">
          <span class="step-num">${s.status === 'done' ? '✓' : s.position}</span>
          <div class="grow">
            <strong>${esc(s.title)}</strong>
            ${s.description ? `<div class="muted small">${esc(s.description)}</div>` : ''}
          </div>
          <span class="muted small">${s.status === 'done' ? 'Complete' : 'Pending'}</span>
        </div>
        ${s.status === 'done' ? `
          <div class="proof" data-testid="proof-${s.position}">
            <strong>Proof:</strong> ${esc(s.proof_text)}
            ${s.proof_url ? ` · <a href="${esc(s.proof_url)}" target="_blank" rel="noopener">attachment</a>` : ''}
            ${s.proof_verified ? `<div style="color:var(--good);font-weight:600;margin-top:4px" data-testid="proof-verified-${s.position}">
              ✓ Verified against public registry: <code>${esc(s.proof_registry_ref)}</code></div>` : ''}
          </div>` : ''}
        ${canWork ? `
          <div class="proof-form">
            <input type="text" data-testid="proof-input-${s.position}" id="proof-text-${s.id}" placeholder="Proof of completion (required) — e.g. filing receipt #, summary of work">
            ${s.verification_kind ? `
              <input type="text" data-testid="proof-registry-${s.position}" id="proof-registry-${s.id}"
                placeholder="Public registry reference (required — kind: ${esc(s.verification_kind)}, e.g. CR-RN-2026-104512)">` : `
              <input type="url" data-testid="proof-url-${s.position}" id="proof-url-${s.id}" placeholder="Proof URL (optional)">`}
            <div><button class="btn" data-action="complete-step" data-id="${e.id}" data-step="${s.id}"
              data-testid="complete-step-${s.position}">Mark step complete</button></div>
          </div>` : ''}
      </li>`;
  }

  function engagementActions(e) {
    const role = state.role.kind;
    const parts = [];
    if (role === 'agent') {
      if (e.state === 'draft') {
        parts.push(`<button class="btn" data-action="agree" data-id="${e.id}" data-testid="agree-button">Agree — lock terms &amp; steps</button>
          <span class="muted small">Locks the ${e.steps_total} steps and ${escrowTerms(e)} into an immutable contract.</span>`);
      }
      if (e.state === 'agreed') {
        parts.push(`<button class="btn" data-action="fund" data-id="${e.id}" data-testid="fund-button">
            Fund escrow — ${fmt(e.upfront_cents)} (${e.upfront_pct}%)</button>
          <span class="muted small">Moves the downpayment into escrow so work can start.</span>`);
      }
      if (e.state === 'submitted') {
        parts.push(`
          <div class="ok-banner">The SMB submitted all steps with proofs. Review them above, then settle:</div>
          <div class="row">
            <button class="btn good" data-action="approve" data-id="${e.id}" data-testid="approve-button">
              Approve — release ${fmt(e.price_cents)} total</button>
          </div>
          <div style="margin-top:14px">
            <label class="field">Or reject with a reason (opens a dispute for the arbiter):
              <textarea data-testid="reject-reason" id="reject-reason-${e.id}" placeholder="What is wrong with the delivered proofs?"></textarea>
            </label>
            <button class="btn danger" data-action="reject" data-id="${e.id}" data-testid="reject-button">Reject — open dispute</button>
          </div>`);
      }
      if (['completed', 'resolved'].includes(e.state) && !e.rating) {
        parts.push(`
          <div class="notice">How was <strong>${esc(e.smb.name)}</strong>? Your rating affects their search ranking.</div>
          <div class="row">
            <button class="btn good" data-action="rate" data-value="good" data-id="${e.id}" data-testid="rate-good">👍 Rate good</button>
            <button class="btn danger" data-action="rate" data-value="bad" data-id="${e.id}" data-testid="rate-bad">👎 Rate bad</button>
          </div>`);
      }
    }
    if (role === 'smb') {
      if (e.state === 'agreed') parts.push('<div class="notice">Waiting for the agent to fund escrow before work can start.</div>');
      if (['funded', 'in_progress'].includes(e.state)) {
        parts.push(`<button class="btn" data-action="submit" data-id="${e.id}" data-testid="submit-verification">
            Submit for verification (${e.steps_done}/${e.steps_total} steps complete)</button>
          <span class="muted small">All steps must be complete with proof before submitting.</span>`);
      }
      if (e.state === 'submitted') parts.push('<div class="notice">Waiting for the agent to verify your proofs.</div>');
    }
    if (role === 'arbiter' && e.state === 'disputed') {
      parts.push(`
        <div class="notice"><strong>Dispute reason:</strong> ${esc(e.dispute_reason)}</div>
        <p class="small muted">Ruling applies to the ${fmt(e.escrow_balance_cents)} currently held in escrow.</p>
        <div class="row">
          <button class="btn good" data-action="resolve" data-ruling="release" data-id="${e.id}" data-testid="ruling-release">Release to SMB</button>
          <button class="btn" data-action="resolve" data-ruling="split" data-id="${e.id}" data-testid="ruling-split">Split 50 / 50</button>
          <button class="btn danger" data-action="resolve" data-ruling="refund" data-id="${e.id}" data-testid="ruling-refund">Refund agent</button>
        </div>`);
    }
    return parts.join('\n');
  }

  async function viewEngagement(id) {
    const e = await api('GET', `/engagements/${id}`);
    const role = state.role.kind;
    const backHref = role === 'agent' ? '#/engagements' : '#/';
    return `
      <p class="small"><a href="${backHref}">← Back</a></p>
      <div class="card">
        <div class="row spread">
          <div class="grow">
            <h1>Engagement #${e.id} — ${esc(e.title)}</h1>
            <div class="row small">
              <span class="state ${e.state}" data-testid="engagement-state">${STATE_LABELS[e.state]}</span>
              ${e.resolution ? `<span class="badge rating" data-testid="resolution">Ruling: ${esc(e.resolution)}</span>` : ''}
              ${e.rating ? `<span class="badge rating" data-testid="engagement-rating">Rated: ${e.rating === 'good' ? '👍 good' : '👎 bad'}</span>` : ''}
            </div>
          </div>
          <div class="right">
            <div class="price">${fmt(e.price_cents)}</div>
            <div class="muted">${escrowTerms(e)}</div>
          </div>
        </div>
        <dl class="kv" style="margin-top:14px">
          <dt>Agent (client)</dt><dd>${esc(e.agent.name)}</dd>
          <dt>SMB (provider)</dt><dd><a href="#/smbs/${e.smb.id}">${esc(e.smb.name)}</a></dd>
          <dt>Escrow balance</dt><dd data-testid="escrow-balance">${fmt(e.escrow_balance_cents)}</dd>
          <dt>Downpayment</dt><dd>${fmt(e.upfront_cents)} (${e.upfront_pct}%)</dd>
          <dt>On completion</dt><dd>${fmt(e.remaining_cents)}</dd>
          ${e.dispute_reason ? `<dt>Dispute reason</dt><dd data-testid="dispute-reason">${esc(e.dispute_reason)}</dd>` : ''}
        </dl>
        <h2>Steps (${e.steps_done}/${e.steps_total} complete)</h2>
        <ol class="steps">${e.steps.map((s) => stepItem(e, s, role)).join('')}</ol>
        <div id="engagement-actions">${engagementActions(e)}</div>
      </div>`;
  }

  async function viewEngagementList() {
    const role = state.role;
    const qs = role.kind === 'agent' ? `?agent_id=${role.id}` : `?smb_id=${role.id}`;
    const list = await api('GET', `/engagements${qs}`);
    const who = role.kind === 'agent' ? 'smb' : 'agent';
    return `
      <h1>My engagements</h1>
      <p class="sub">${role.kind === 'agent' ? 'Contracts your agent holds with SMBs.' : 'Work your business has been contracted for.'}</p>
      ${list.length ? list.map((e) => `
        <div class="card clickable" data-testid="engagement-row" data-action="open-engagement" data-id="${e.id}">
          <div class="row spread">
            <div class="grow">
              <strong>#${e.id} — ${esc(e.title)}</strong>
              <div class="muted small">with ${esc(e[who].name)} · ${e.steps_done}/${e.steps_total} steps</div>
            </div>
            <div class="row">
              <span class="state ${e.state}">${STATE_LABELS[e.state]}</span>
              <span class="price">${fmt(e.price_cents)}</span>
            </div>
          </div>
        </div>`).join('')
        : `<div class="empty" data-testid="empty-state">No engagements yet.${role.kind === 'agent' ? ' <a href="#/">Find a service</a> to get started.' : ''}</div>`}`;
  }

  async function viewSmbProfile(id) {
    const s = await api('GET', `/smbs/${id}`);
    const own = state.role.kind === 'smb' && state.role.id === s.id;
    return `
      <div class="card">
        <div class="row spread">
          <div class="grow">
            <h1>${esc(s.name)}</h1>
            <div class="row small">
              ${vettedBadge(s)}
              <span class="badge cat">${esc(s.category)}</span>
              <span class="muted">📍 ${esc(s.location)}</span>
            </div>
            <p>${esc(s.description)}</p>
            <p class="muted small">Capabilities: ${esc(s.capabilities)}</p>
          </div>
          <div class="right">
            <div class="badge rating" data-testid="rating-summary" style="font-size:14px;padding:6px 14px">
              👍 ${s.rating.good} · 👎 ${s.rating.bad} · score ${s.rating.score}
            </div>
            ${own ? `<div class="price" style="margin-top:10px" data-testid="smb-balance">${fmt(s.balance_cents)}</div><div class="muted">account balance</div>` : ''}
          </div>
        </div>
        ${pacta() ? `
        <dl class="kv" style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
          <dt>Stake (collateral)</dt><dd data-testid="smb-stake">${fmt(s.stake_cents || 0)}</dd>
          <dt>Exposure cap</dt><dd data-testid="smb-cap">${fmt(s.exposure_cap_cents || 0)} <span class="muted small">(5× stake + 50% of completed volume)</span></dd>
          <dt>Active exposure</dt><dd data-testid="smb-exposure">${fmt(s.active_exposure_cents || 0)}</dd>
        </dl>
        ${own ? `
        <div class="row" style="margin-top:12px">
          <input type="number" id="stake-amount" min="1" step="1" placeholder="USD" style="width:130px" data-testid="stake-amount">
          <button class="btn" data-action="add-stake" data-id="${s.id}" data-testid="add-stake">Add stake${s.vetted ? '' : ' — get Vetted ✓'}</button>
          <span class="muted small">Simulated external deposit. Collateral at risk in disputes.</span>
        </div>` : ''}` : ''}
      </div>
      <h2>Published offers</h2>
      ${s.offers.length ? s.offers.map(offerCard).join('') : '<div class="empty">No offers published yet.</div>'}`;
  }

  async function viewDisputes() {
    const list = await api('GET', '/disputes');
    const open = list.filter((e) => e.state === 'disputed');
    const closed = list.filter((e) => e.state === 'resolved');
    const row = (e) => `
      <div class="card clickable" data-testid="dispute-row" data-action="open-engagement" data-id="${e.id}">
        <div class="row spread">
          <div class="grow">
            <strong>#${e.id} — ${esc(e.title)}</strong>
            <div class="muted small">${esc(e.agent.name)} vs ${esc(e.smb.name)} · escrow holds ${fmt(e.escrow_balance_cents)}</div>
            ${e.dispute_reason ? `<div class="small">“${esc(e.dispute_reason)}”</div>` : ''}
          </div>
          <div class="row">
            <span class="state ${e.state}">${STATE_LABELS[e.state]}</span>
            ${e.resolution ? `<span class="badge rating">${esc(e.resolution)}</span>` : ''}
          </div>
        </div>
      </div>`;
    return `
      <h1>Dispute resolution</h1>
      <p class="sub">Open disputes awaiting your ruling. Rulings apply to the funds held in escrow.</p>
      ${open.length ? open.map(row).join('') : '<div class="empty" data-testid="empty-state">No open disputes. 🎉</div>'}
      ${closed.length ? `<h2>Resolved</h2>${closed.map(row).join('')}` : ''}`;
  }

  async function viewLedger() {
    const l = await api('GET', '/ledger');
    const acctName = (id) => {
      if (id === null) return '💰 mint (seed)';
      const a = l.accounts.find((x) => x.id === id);
      return a ? a.owner : `account #${id}`;
    };
    return `
      <h1>Simulated USD ledger</h1>
      <p class="sub">Internal double-entry ledger — no real payments. Money only enters via seeding, so total balances must always equal total minted.</p>
      <div class="${l.invariant.ok ? 'ok-banner' : 'error-banner'}" data-testid="invariant-status">
        ${l.invariant.ok ? '✓ Ledger balanced' : '✗ LEDGER INVARIANT BROKEN'} —
        ${fmt(l.invariant.total_balances_cents)} across all accounts vs ${fmt(l.invariant.total_minted_cents)} minted
      </div>
      <h2>Accounts</h2>
      <table class="tbl">
        <thead><tr><th>Account</th><th>Kind</th><th class="right">Balance</th></tr></thead>
        <tbody>
          ${l.accounts.map((a) => `
            <tr data-testid="account-row">
              <td>${esc(a.owner)}</td><td>${a.kind}</td>
              <td class="right"><strong>${fmt(a.balance_cents)}</strong></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <h2>Transactions (latest first)</h2>
      <table class="tbl">
        <thead><tr><th>#</th><th>From</th><th>To</th><th class="right">Amount</th><th>Type</th><th>Memo</th></tr></thead>
        <tbody>
          ${l.transactions.map((t) => `
            <tr>
              <td>${t.id}</td><td>${esc(acctName(t.from_account_id))}</td><td>${esc(acctName(t.to_account_id))}</td>
              <td class="right">${fmt(t.amount_cents)}</td><td>${esc(t.type)}</td><td class="muted">${esc(t.memo)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  async function viewOnboard() {
    const smb = state.role.kind === 'smb' ? currentRoleEntity() : null;
    return `
      <h1>SMB onboarding</h1>
      <p class="sub">Register a business (vetting is auto-granted in this POC) and publish service offers agents can discover.</p>
      <div class="grid2">
        <div class="card">
          <h2 style="margin-top:0">Register a new SMB</h2>
          <form data-form="register-smb">
            <label class="field">Business name <input type="text" name="name" data-testid="smb-name" required></label>
            <label class="field">Category
              <select name="category" class="input" data-testid="smb-category">
                ${['legal', 'tourism', 'real-estate', 'accounting'].map((c) => `<option value="${c}">${c}</option>`).join('')}
              </select>
            </label>
            <label class="field">Location <input type="text" name="location" data-testid="smb-location" placeholder="e.g. Costa Rica" required></label>
            <label class="field">Description <textarea name="description"></textarea></label>
            <label class="field">Capabilities (comma-separated keywords) <input type="text" name="capabilities" placeholder="lawyer, permits, ..."></label>
            ${pacta() ? `<label class="field">Initial stake (USD) — collateral at risk; required for the Vetted ✓ badge
              <input type="number" name="stake" min="0" step="1" value="500" data-testid="smb-stake-input"></label>` : ''}
            <button class="btn" type="submit" data-testid="register-smb-button">${pacta() ? 'Register & post stake' : 'Register — get Vetted ✓'}</button>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Publish a service offer</h2>
          ${smb ? `
          <form data-form="publish-offer">
            <p class="muted small">Publishing as <strong>${esc(smb.name)}</strong></p>
            <label class="field">Title <input type="text" name="title" data-testid="offer-title" required></label>
            <label class="field">Description <textarea name="description"></textarea></label>
            <label class="field">Price (USD) <input type="number" name="price" min="1" step="1" data-testid="offer-price" required></label>
            <label class="field">Downpayment % (rest paid on completion)
              <input type="number" name="upfront" min="0" max="100" value="20" data-testid="offer-upfront" required></label>
            <label class="field">Steps — one per line, "Title | optional description"
              <textarea name="steps" data-testid="offer-steps" rows="5" placeholder="Incorporate company | Register with National Registry&#10;Obtain permits"></textarea></label>
            <button class="btn" type="submit" data-testid="publish-offer-button">Publish offer</button>
          </form>` : '<div class="notice">Switch to an SMB role to publish an offer for that business.</div>'}
        </div>
      </div>`;
  }

  // ---------- router -----------------------------------------------------------

  let renderSeq = 0;

  async function routeHtml(seg) {
    if (seg.length === 0) {
      if (state.role.kind === 'agent') return viewSearch();
      if (state.role.kind === 'smb') return viewEngagementList();
      return viewDisputes();
    }
    if (seg[0] === 'offers' && seg[1]) return viewOffer(seg[1]);
    if (seg[0] === 'engagements' && seg[1]) return viewEngagement(seg[1]);
    if (seg[0] === 'engagements') return viewEngagementList();
    if (seg[0] === 'smbs' && seg[1]) return viewSmbProfile(seg[1]);
    if (seg[0] === 'profile' && state.role.kind === 'smb') return viewSmbProfile(state.role.id);
    if (seg[0] === 'ledger') return viewLedger();
    if (seg[0] === 'onboard') return viewOnboard();
    return '<div class="empty">Page not found. <a href="#/">Go home</a></div>';
  }

  async function render() {
    const seq = ++renderSeq;
    clearError();
    renderHeader();
    const hash = location.hash || '#/';
    const [path] = hash.slice(1).split('?');
    const seg = path.split('/').filter(Boolean);
    let html;
    try {
      html = await routeHtml(seg);
    } catch (err) {
      if (!(err instanceof ApiFailure)) throw err;
      html = `<div class="empty">Could not load this page: ${esc(err.message)}<br><br><a href="#/">Go home</a></div>`;
    }
    if (seq === renderSeq) view().innerHTML = html; // a newer render superseded us otherwise
  }

  // Navigate via hash so refreshes and the back button work; when the hash is
  // already current (hashchange will not fire) render explicitly.
  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  async function rerenderWithFreshUsers() {
    await refreshUsers();
    await render();
  }

  // ---------- actions ----------------------------------------------------------

  const actions = {
    'dismiss-error': () => clearError(),

    'open-offer': (el) => navigate(`#/offers/${el.dataset.id}`),
    'open-engagement': (el) => navigate(`#/engagements/${el.dataset.id}`),

    'create-engagement': async (el) => {
      const e = await api('POST', '/engagements', { offer_id: Number(el.dataset.id), agent_id: state.role.id });
      navigate(`#/engagements/${e.id}`);
    },
    agree: async (el) => {
      await api('POST', `/engagements/${el.dataset.id}/agree`, {});
      await render();
    },
    fund: async (el) => {
      await api('POST', `/engagements/${el.dataset.id}/fund`, {});
      await rerenderWithFreshUsers(); // header balance changed
    },
    'complete-step': async (el) => {
      const stepId = el.dataset.step;
      const text = ($(`#proof-text-${stepId}`) || {}).value || '';
      const url = ($(`#proof-url-${stepId}`) || {}).value || '';
      const registryRef = ($(`#proof-registry-${stepId}`) || {}).value || '';
      if (!text.trim()) { showError('Proof of completion is required to mark a step complete.'); return; }
      await api('POST', `/engagements/${el.dataset.id}/steps/${stepId}/complete`, {
        proof_text: text.trim(),
        ...(url.trim() ? { proof_url: url.trim() } : {}),
        ...(registryRef.trim() ? { registry_ref: registryRef.trim() } : {}),
      });
      await render();
    },
    'add-stake': async (el) => {
      const amount = ($('#stake-amount') || {}).value || '';
      const cents = Math.round(Number(amount) * 100);
      if (!cents || cents <= 0) { showError('Enter a stake amount in USD.'); return; }
      await api('POST', `/smbs/${el.dataset.id}/stake`, { amount_cents: cents });
      await rerenderWithFreshUsers();
    },
    submit: async (el) => {
      await api('POST', `/engagements/${el.dataset.id}/submit`, {});
      await render();
    },
    approve: async (el) => {
      await api('POST', `/engagements/${el.dataset.id}/approve`, {});
      await rerenderWithFreshUsers();
    },
    reject: async (el) => {
      const reason = ($(`#reject-reason-${el.dataset.id}`) || {}).value || '';
      if (!reason.trim()) { showError('Please provide a reason for rejecting — the arbiter will see it.'); return; }
      await api('POST', `/engagements/${el.dataset.id}/reject`, { reason: reason.trim() });
      await render();
    },
    resolve: async (el) => {
      await api('POST', `/engagements/${el.dataset.id}/resolve`, { ruling: el.dataset.ruling });
      await rerenderWithFreshUsers();
    },
    rate: async (el) => {
      await api('POST', `/engagements/${el.dataset.id}/rate`, { value: el.dataset.value });
      await rerenderWithFreshUsers();
    },
  };

  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    // Clicks on links/buttons inside a clickable card should win over the card.
    if (el.dataset.action && ev.target.closest('a') && !el.matches('a')) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    ev.preventDefault();
    if (el.disabled) return;
    const isButton = el.tagName === 'BUTTON';
    if (isButton) el.disabled = true; // double-click guard
    try {
      clearError();
      await fn(el);
    } catch (err) {
      showError(err instanceof ApiFailure ? err.message : 'Something went wrong. Please try again.');
      if (!(err instanceof ApiFailure)) console.error('[ui]', err); // surfaces real UI bugs in E2E
    } finally {
      if (isButton && document.contains(el)) el.disabled = false;
    }
  });

  document.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      clearError();
      if (form.dataset.form === 'search') {
        state.lastSearch = { q: (data.q || '').trim(), category: data.category || '', vetted: !!data.vetted };
        const container = $('[data-testid="search-results"]');
        if (container) container.innerHTML = await searchResultsHtml();
        else await render();
      }
      if (form.dataset.form === 'register-smb') {
        const smb = await api('POST', '/smbs', {
          name: data.name, category: data.category, location: data.location,
          description: data.description || '', capabilities: data.capabilities || '',
          ...(pacta() ? { stake_cents: Math.round(Number(data.stake || 0) * 100) } : {}),
        });
        await refreshUsers();
        state.role = { kind: 'smb', id: smb.id };
        saveRole(state.role);
        navigate(`#/smbs/${smb.id}`);
      }
      if (form.dataset.form === 'publish-offer') {
        const steps = (data.steps || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
          const [title, description] = line.split('|').map((x) => x.trim());
          return { title, description: description || '' };
        });
        const offer = await api('POST', '/offers', {
          smb_id: state.role.id, title: data.title, description: data.description || '',
          price_cents: Math.round(Number(data.price) * 100), upfront_pct: Number(data.upfront), steps,
        });
        navigate(`#/offers/${offer.id}`);
      }
    } catch (err) {
      showError(err instanceof ApiFailure ? err.message : 'Something went wrong. Please try again.');
    } finally {
      if (btn && document.contains(btn)) btn.disabled = false;
    }
  });

  $('#role-switcher').addEventListener('change', async (ev) => {
    const [kind, id] = ev.target.value.split(':');
    state.role = { kind, id: Number(id) };
    saveRole(state.role);
    navigate('#/');
  });

  window.addEventListener('hashchange', () => { render(); });

  // ---------- boot ---------------------------------------------------------------

  (async () => {
    try {
      try { state.config = await api('GET', '/config'); } catch { /* pre-Pacta server */ }
      await refreshUsers();
      await render();
    } catch (err) {
      return `<div class="empty">Failed to load the marketplace: ${esc(err.message)}</div>`;
    }
  })();
})();
