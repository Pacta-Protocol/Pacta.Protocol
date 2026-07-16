# DECISIONS

Key design decisions and their rationale.

1. **Stack: Express 5 + built-in `node:sqlite` + vanilla JS SPA.** Node 24 ships a
   stable synchronous SQLite driver, so the only runtime dependency is Express and the
   only dev dependency is Playwright. No build step for the frontend eliminates
   hydration/bundler failure modes in E2E and makes the clean-machine test trivial.
   Requires Node >= 22.5 (documented in README).

2. **Money is integer cents.** All amounts stored/computed in cents; formatted only in
   the UI/API responses (`price_usd` style fields are derived). Avoids float drift in
   the ledger invariant.

3. **Ledger = double-entry with minting.** Seeding credits the agent's account via a
   transaction whose `from_account_id` is NULL ("mint"). Invariant checked as:
   `sum(account balances) == sum(minted cents)` plus per-account replay
   (`balance == credits − debits`). Exposed at `GET /api/ledger/invariant` and
   asserted after every mutation in tests.

4. **`draft` state exists and is where steps are editable.** The handshake is: agent
   creates engagement (draft, steps snapshotted from the offer), reviews/optionally
   tweaks steps, then `agree` locks everything (`agreed`). Any step modification after
   `draft` returns 409 — this immutability is probed by the verification suite.

5. **Settlement on approve draws the remainder automatically.** Approve (from
   `submitted`) runs one SQLite transaction: agent → escrow for the remaining
   (100 − upfront)%, then escrow → SMB for the full price, then state → `completed`.
   If the agent can't cover the remainder, approve fails 409 and state is unchanged.
   Double release impossible: the state check and flip share the transaction.

6. **Arbiter rulings apply to escrowed funds only.** At dispute time escrow holds the
   upfront amount; `release` sends it to the SMB, `refund` returns it to the agent,
   `split` divides it 50/50 (odd cent, if any, goes to the SMB). The un-drawn
   remainder never left the agent, so no further movement is needed.

7. **Rating score = good − bad; ranking = score desc, then price asc.** Simple,
   monotonic, and lets seed data demonstrate reordering: Bufete Herrera (3g/1b = 2)
   ties LexCorp (2g/0b = 2) and loses on price until one more "good" rating lifts it
   to 3 and first place. One rating per engagement, only in `completed`/`resolved`.

8. **Seeded rating history has `engagement_id = NULL`.** Real ratings require a
   settled engagement; historical seed ratings don't reference one. This keeps the
   "rating history present" requirement without fabricating fake engagements.

9. **Role switching = one dropdown of dummy identities** ("Agent — Realtor Assistant
   Agent", "SMB — Bufete Herrera & Asociados", ..., "Arbiter"). The active identity id
   is sent explicitly in API calls (`agent_id`, `smb_id`, ...). No auth — POC scope.

10. **Vetting is a badge column that is always 1** — granted at registration,
    displayed as "Vetted ✓" everywhere. No checks in the base build — POC scope; the
    trust-extensions build replaces this with real staking.

11. **Proofs are text + optional URL.** No file storage; the proof text is required
    at submit time (server-side), URL optional.

12. **Insufficient-funds demo path**: seeded $300,000 offer ("Island Estates
    Development") whose 20% upfront ($60,000) exceeds the agent's $50,000 balance, so
    the unhappy path is exercisable through the real UI without editing balances.

13. **First-run seeding is idempotent**: runs only when the `agents` table is empty.
    Deleting `data/marketplace.db` resets everything (documented in README).

14. **Default port is 3210, not 3000.** 3000/5173/8080 are high-collision ports on
    developer machines (a stale server holding IPv6 `*:3000` makes Node bind IPv4-only
    and `localhost` requests half-land on the stranger), so the POC defaults to 3210
    (override with `PORT`) and exits with a clear message on `EADDRINUSE`. E2E uses
    3100, the verify script 3200.

15. **`in_progress` is entered implicitly** when the SMB marks the first step done
    (from `funded`). An explicit "start" call adds a click without adding meaning in
    a POC.

## Pacta decisions

16. **Pacta is a flag, not a fork.** One codebase; `createApp({ pacta })` /
    `PACTA=1` gates every behavioral difference, so both variants stay testable in one
    suite and base-build regressions are structurally impossible to miss. Pacta runs
    on port 3220 with its own `data/pacta.db`.

17. **Stake deposits are mints.** Stake money arrives from outside the platform
    (simulated bank transfer), so it enters the ledger as a mint into a dedicated
    `stake` account per SMB — the invariant Σ balances = Σ minted keeps holding with
    zero special cases.

18. **Slash percentages: 20% on `refund`, 10% on `split`, 0% on `release`,** always
    bounded by the stake balance, paid to the agent as compensation inside the same
    transaction as the ruling. Vetted status is revoked automatically at zero stake.
    Numbers are POC calibrations; the mechanism is the point.

19. **The public registry is a mock with a real interface.** `registry_records` +
    `GET /api/registry/:ref` stand in for the Registro Nacional / municipality / tax
    authority APIs. Verification checks existence AND kind match, which is exactly the
    contract a real integration would have.

20. **Exposure cap = 5 × stake + 50% × completed GMV, enforced at `agree`.** Draft
    creation stays free (browsing is not a risk); the cap binds when the contract
    forms. Island Estates is seeded so its $300K offer exceeds its own cap — the
    graduated-trust gate is demoable out of the box.
