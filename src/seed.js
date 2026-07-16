'use strict';
const { withTx } = require('./db');
const { getOrCreateAccount, mint } = require('./ledger');
const { depositStake } = require('./staking');

// Idempotent: seeds only when the database is empty (no agents yet).
function seedIfEmpty(db, { pacta = false } = {}) {
  const count = Number(db.prepare('SELECT COUNT(*) AS c FROM agents').get().c);
  if (count > 0) return false;

  withTx(db, () => {
    // ---- Agent (the buying side) + arbiter ------------------------------------
    const agentId = insert(db, 'INSERT INTO agents (name) VALUES (?)', ['Realtor Assistant Agent']);
    const agentAcct = getOrCreateAccount(db, 'agent', agentId);
    mint(db, agentAcct.id, 50_000_00, 'seed balance for Realtor Assistant Agent');
    insert(db, 'INSERT INTO arbiters (name) VALUES (?)', ['Marketplace Arbiter']);

    // ---- SMBs -----------------------------------------------------------------
    const smb = (name, category, location, description, capabilities) => {
      const id = insert(
        db,
        'INSERT INTO smbs (name, category, location, description, capabilities, vetted) VALUES (?, ?, ?, ?, ?, 1)',
        [name, category, location, description, capabilities],
      );
      getOrCreateAccount(db, 'smb', id);
      return id;
    };
    const offer = (smbId, title, description, priceCents, upfrontPct, steps) => {
      const offerId = insert(
        db,
        'INSERT INTO offers (smb_id, title, description, price_cents, upfront_pct) VALUES (?, ?, ?, ?, ?)',
        [smbId, title, description, priceCents, upfrontPct],
      );
      steps.forEach((s, i) => {
        insert(db,
          'INSERT INTO offer_steps (offer_id, position, title, description, verification_kind) VALUES (?, ?, ?, ?, ?)', [
            offerId, i + 1, s[0], s[1] || '', (pacta && s[2]) || null,
          ]);
      });
      return offerId;
    };
    const history = (smbId, good, bad) => {
      for (let i = 0; i < good; i++) {
        insert(db, 'INSERT INTO ratings (engagement_id, smb_id, agent_id, value) VALUES (NULL, ?, NULL, ?)', [smbId, 'good']);
      }
      for (let i = 0; i < bad; i++) {
        insert(db, 'INSERT INTO ratings (engagement_id, smb_id, agent_id, value) VALUES (NULL, ?, NULL, ?)', [smbId, 'bad']);
      }
    };

    // 1. Bufete Herrera — the exact demo scenario. Rating history: 3 good / 1 bad
    //    (score 2) so it ties LexCorp (score 2) and initially loses on price; one
    //    more "good" rating lifts it to first place in the legal search results.
    const bufete = smb(
      'Bufete Herrera & Asociados', 'legal', 'Costa Rica',
      'Full-service Costa Rican law firm specializing in foreign investment, real estate and hospitality ventures.',
      'lawyer, corporate law, company incorporation, real estate law, hotel permits, land ownership, compliance',
    );
    history(bufete, 3, 1);
    offer(
      bufete,
      'Establish a Costa Rican company able to buy land and operate a hotel',
      'End-to-end legal setup: incorporation, land/hotel ownership eligibility, permits, and all remaining filings. Lawyer-led, Costa Rica.',
      5_000_00, 20,
      [
        ['Incorporate S.R.L. company in Costa Rica', 'Draft and register articles of incorporation with the National Registry.', 'incorporation'],
        ['Register company for land and hotel ownership eligibility', 'Complete registrations enabling the company to hold land title and operate lodging.', 'land_eligibility'],
        ['Obtain construction/operation permits for hotel', 'Secure municipal and health permits required to build and operate a hotel.', 'permit'],
        ['Handle all remaining legal filings and compliance', 'Tax registration, legal books, ultimate-beneficial-owner declaration, and closing compliance.', 'tax_filing'],
      ],
    );

    // 2. LexCorp — competing legal SMB in Costa Rica; dispute-path counterparty.
    const lexcorp = smb(
      'LexCorp Legal Solutions', 'legal', 'Costa Rica',
      'Boutique corporate law practice for foreign investors entering the Costa Rican market.',
      'lawyer, company formation, corporate law, hotel licensing, immigration, contracts',
    );
    history(lexcorp, 2, 0);
    offer(
      lexcorp,
      'Costa Rica company formation package for foreign investors',
      'Form a Costa Rican corporation with lawyer support, including hotel and tourism licensing guidance.',
      4_500_00, 30,
      [
        ['Incorporate corporation', 'Register the entity with the National Registry.'],
        ['Obtain corporate tax ID and legal books', 'Hacienda registration and legalized corporate books.'],
        ['Deliver compliance starter kit', 'Licensing guidance for hotel/tourism operations.'],
      ],
    );

    // 3–7. Breadth across categories.
    const tico = smb(
      'Tico Adventures Tours', 'tourism', 'Costa Rica',
      'Local eco-tourism operator: itineraries, guides and bookings across Costa Rica.',
      'tour planning, eco-tours, itinerary design, bookings, guides',
    );
    history(tico, 4, 0);
    offer(tico, 'Design and book a 7-day eco-tour itinerary', 'Custom itinerary with confirmed bookings for a 7-day trip.', 1_200_00, 50, [
      ['Draft itinerary', 'Day-by-day plan matched to client interests.'],
      ['Confirm bookings', 'Reserve lodging, transport and activities.'],
      ['Deliver travel pack', 'Final documents, vouchers and emergency contacts.'],
    ]);

    const puraVida = smb(
      'Pura Vida Realty', 'real-estate', 'Costa Rica',
      'Real-estate services firm covering land scouting, due diligence and closing support in Guanacaste.',
      'land scouting, real estate, due diligence, property reports, beachfront',
    );
    history(puraVida, 1, 1);
    offer(puraVida, 'Beachfront land scouting report (Guanacaste)', 'Shortlist of vetted beachfront parcels with pricing and title status.', 2_000_00, 25, [
      ['Scout candidate parcels', 'Identify at least 5 beachfront parcels matching criteria.'],
      ['Verify title status', 'Registry check on each shortlisted parcel.'],
      ['Deliver scouting report', 'Full report with photos, pricing and recommendations.'],
    ]);

    const sandoval = smb(
      'Sandoval Accounting Group', 'accounting', 'Costa Rica',
      'Accounting and tax firm for new and foreign-owned Costa Rican companies.',
      'bookkeeping, tax registration, accounting, payroll, compliance',
    );
    history(sandoval, 2, 1);
    offer(sandoval, 'Set up bookkeeping & tax registration for a new company', 'Hacienda registration, chart of accounts and first-month bookkeeping.', 1_500_00, 20, [
      ['Register with tax authority', 'Complete Hacienda registration.'],
      ['Set up chart of accounts', 'Bookkeeping system configured for the business.'],
      ['Deliver first monthly close', 'First month of bookkeeping delivered and reviewed.'],
    ]);

    const horizonte = smb(
      'Horizonte Legal Panamá', 'legal', 'Panama',
      'Panamanian firm handling corporations, banking and cross-border structures.',
      'lawyer, panama corporation, bank account setup, offshore structures',
    );
    history(horizonte, 1, 0);
    offer(horizonte, 'Panama corporation + bank account setup', 'Incorporate a Panamanian S.A. and open a corporate bank account.', 3_800_00, 20, [
      ['Incorporate S.A.', 'Register the corporation in Panama.'],
      ['Appoint directors and issue shares', 'Corporate governance documents executed.'],
      ['Open corporate bank account', 'Account opened with a local bank.'],
    ]);

    // Priced so its 20% upfront ($60,000) exceeds the agent's $50,000 balance —
    // exercises the insufficient-funds path through the real UI.
    const island = smb(
      'Island Estates Development', 'real-estate', 'Costa Rica',
      'Development firm assembling turnkey hospitality real-estate packages.',
      'real estate, hotel development, land acquisition, project management',
    );
    history(island, 3, 0);
    offer(island, 'Turnkey boutique hotel land acquisition package', 'Sourcing, negotiation and closing of a boutique-hotel-ready parcel.', 300_000_00, 20, [
      ['Source parcel', 'Identify and secure a qualifying parcel.'],
      ['Negotiate and contract', 'Negotiate terms and sign purchase agreement.'],
      ['Close acquisition', 'Complete closing and title transfer.'],
    ]);

    if (pacta) seedPacta(db, { bufete, lexcorp, tico, puraVida, sandoval, horizonte, island, smb, offer });
  });

  return true;
}

// Pacta: trust is collateralized. Every seeded SMB posts a stake sized so the demo
// scenario fits its exposure cap (cap = 5×stake + 50% of completed GMV); one SMB is
// deliberately left unstaked to demo the vetting gate; the public registry holds the
// records Bufete's registry-anchored steps must reference.
function seedPacta(db, s) {
  const stakes = [
    [s.bufete, 1_500_00],   // cap $7,500 → fits the $5,000 flagship engagement
    [s.lexcorp, 1_000_00],  // cap $5,000
    [s.tico, 500_00],
    [s.puraVida, 500_00],
    [s.sandoval, 500_00],
    [s.horizonte, 800_00],
    [s.island, 5_000_00],   // cap $25,000 — its $300K offer exceeds it: demoable gate
  ];
  for (const [smbId, cents] of stakes) depositStake(db, smbId, cents, 'seed stake deposit');
  db.prepare('UPDATE smbs SET vetted = 1 WHERE id IN (' + stakes.map(() => '?').join(',') + ')')
    .run(...stakes.map(([id]) => id));

  // The vetting gate, demoable: registered but never posted a stake.
  const unvetted = s.smb(
    'Despacho Sin Garantía', 'legal', 'Costa Rica',
    'Newly registered practice that has not posted a stake yet.',
    'lawyer, company formation, notary',
  );
  db.prepare('UPDATE smbs SET vetted = 0 WHERE id = ?').run(unvetted);
  s.offer(unvetted, 'Budget company formation', 'Bare-bones incorporation service.', 900_00, 50, [
    ['Incorporate company', 'Registration with the National Registry.'],
  ]);

  // Public registry records — what the registry-anchored proofs verify against.
  const records = [
    ['CR-RN-2026-104512', 'incorporation', 'S.R.L. incorporation certificate', 'Cédula jurídica 3-102-887766, Registro Nacional de Costa Rica'],
    ['CR-RN-2026-104513', 'land_eligibility', 'Land & lodging ownership eligibility registration', 'Enables land title holding and lodging operation'],
    ['CR-MUNI-SJ-88231', 'permit', 'Municipal construction & hotel operation permit', 'Municipalidad de San José + Ministerio de Salud'],
    ['CR-HAC-2026-55710', 'tax_filing', 'Tax registration & compliance filing', 'Hacienda registration, legal books, UBO declaration'],
    ['CR-RN-2026-200001', 'incorporation', 'S.A. incorporation certificate (unrelated company)', 'A valid record of the wrong kind, for negative tests'],
  ];
  for (const [ref, kind, title, details] of records) {
    db.prepare('INSERT INTO registry_records (ref, kind, title, issued_to, details) VALUES (?, ?, ?, ?, ?)')
      .run(ref, kind, title, 'Registro Nacional de Costa Rica', details);
  }
}

function insert(db, sql, params) {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}

module.exports = { seedIfEmpty };
