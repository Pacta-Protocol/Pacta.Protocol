'use strict';
// The full Costa Rica demo scenario, driven through the real UI start to finish.
// Runs first on a freshly seeded database (see scripts/e2e-server.js).
const { test, expect } = require('@playwright/test');
const { watchPage, switchRole, expectLedgerBalanced } = require('./helpers');

test('Costa Rica scenario: search → contract → escrow → fulfill → verify → settle → rate', async ({ page }) => {
  const watcher = watchPage(page); // zero tolerance: no console errors, no failed requests

  // 1. Agent searches the marketplace ----------------------------------------
  await page.goto('/');
  await expect(page.getByTestId('role-switcher')).toHaveValue('agent:1');
  await expect(page.getByTestId('agent-balance')).toHaveText('Balance $50,000');

  await page.getByTestId('search-input').fill('lawyer Costa Rica hotel');
  await page.getByTestId('search-button').click();
  const bufeteCard = page.getByTestId('offer-card').filter({ hasText: 'Bufete Herrera & Asociados' });
  await expect(bufeteCard).toBeVisible();
  await expect(bufeteCard).toContainText('Vetted ✓');
  await expect(bufeteCard).toContainText('$5,000');

  // 2. Review steps → agree → engagement created ------------------------------
  await bufeteCard.click();
  await expect(page.getByRole('heading', { name: /Establish a Costa Rican company/ })).toBeVisible();
  await expect(page.locator('.steps li')).toHaveCount(4);
  await expect(page.locator('.steps li').first()).toContainText('Incorporate S.R.L. company in Costa Rica');
  await expect(page.locator('body')).toContainText('20% downpayment · 80% on completion');

  await page.getByTestId('create-engagement').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Draft');
  await page.getByTestId('agree-button').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Agreed');

  // 3. Fund 20% escrow → balances update in the UI -----------------------------
  await page.getByTestId('fund-button').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Escrow funded');
  await expect(page.getByTestId('escrow-balance')).toHaveText('$1,000');
  await expect(page.getByTestId('agent-balance')).toHaveText('Balance $49,000');
  await expectLedgerBalanced(page);

  // 4. SMB marks all 4 steps complete with proofs ------------------------------
  await switchRole(page, 'SMB — Bufete Herrera & Asociados');
  const row = page.getByTestId('engagement-row').filter({ hasText: 'Establish a Costa Rican company' });
  await row.click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Escrow funded');

  const proofs = [
    'S.R.L. incorporated — National Registry cédula jurídica 3-102-887766.',
    'Company registered as eligible to hold land title and operate lodging.',
    'Municipal construction permit + health operation permit granted.',
    'Tax registration, legal books and UBO declaration filed. Fully compliant.',
  ];
  for (let i = 1; i <= 4; i++) {
    await page.getByTestId(`proof-input-${i}`).fill(proofs[i - 1]);
    if (i === 1) await page.getByTestId('proof-url-1').fill('https://example.com/registro-nacional/receipt-1.pdf');
    await page.getByTestId(`complete-step-${i}`).click();
    await expect(page.getByTestId(`proof-${i}`)).toContainText(proofs[i - 1]);
    await expect(page.getByTestId('engagement-state')).toHaveText('In progress');
  }

  // 5. Submit for verification --------------------------------------------------
  await page.getByTestId('submit-verification').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Submitted for verification');

  // 6. Agent reviews proofs → approve → funds released --------------------------
  await switchRole(page, 'Agent — Realtor Assistant Agent');
  await page.getByRole('link', { name: 'My engagements' }).click();
  await page.getByTestId('engagement-row').filter({ hasText: 'Establish a Costa Rican company' }).click();
  await expect(page.getByTestId('proof-1')).toContainText('3-102-887766');

  await page.getByTestId('approve-button').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Completed');
  await expect(page.getByTestId('escrow-balance')).toHaveText('$0');
  await expect(page.getByTestId('agent-balance')).toHaveText('Balance $45,000');
  await expectLedgerBalanced(page);

  // 7. Rate good → profile aggregate updates and search ranking reflects it -----
  await page.getByTestId('rate-good').click();
  await expect(page.getByTestId('engagement-rating')).toContainText('good');

  await page.goto('/#/smbs/1');
  await expect(page.getByTestId('rating-summary')).toHaveText(/👍 4 · 👎 1 · score 3/);

  await page.goto('/#/');
  await page.getByTestId('search-input').fill('lawyer Costa Rica company hotel');
  await page.getByTestId('search-button').click();
  await expect(page.getByTestId('offer-card').first()).toContainText('Bufete Herrera & Asociados');

  watcher.assertClean();
});
