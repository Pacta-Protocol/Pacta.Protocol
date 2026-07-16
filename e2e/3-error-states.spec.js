'use strict';
// QA-3 error-state sweep: unhappy paths through the real UI. Expected API 4xx
// rejections are allowed; anything else (5xx, asset 404s, JS errors) fails.
// Runs after the happy-path and dispute specs: agent balance starts at $44,325.
const { test, expect } = require('@playwright/test');
const { watchPage, switchRole, expectLedgerBalanced, readAgentBalanceCents, fmtUsd } = require('./helpers');

test('funding with insufficient balance shows a graceful error, state unchanged', async ({ page }) => {
  const watcher = watchPage(page, { allow4xx: true });
  await page.goto('/');
  const startBalance = await readAgentBalanceCents(page);

  await page.getByTestId('search-input').fill('turnkey boutique hotel');
  await page.getByTestId('search-button').click();
  await page.getByTestId('offer-card').filter({ hasText: 'Island Estates' }).click();
  await page.getByTestId('create-engagement').click();
  await page.getByTestId('agree-button').click();
  await page.getByTestId('fund-button').click(); // 20% of $300,000 = $60,000 > balance

  await expect(page.getByTestId('error-banner')).toBeVisible();
  await expect(page.getByTestId('error-banner')).toContainText('insufficient funds');
  await expect(page.getByTestId('engagement-state')).toHaveText('Agreed');
  await expect(page.getByTestId('agent-balance')).toHaveText(`Balance ${fmtUsd(startBalance)}`);
  await expectLedgerBalanced(page);
  watcher.assertClean();
});

test('submitting with incomplete steps is rejected with a clear message', async ({ page }) => {
  const watcher = watchPage(page, { allow4xx: true });
  await page.goto('/');

  // Contract Tico Adventures ($1,200 @ 50% = $600 escrow)
  await page.getByTestId('search-input').fill('eco-tour itinerary');
  await page.getByTestId('search-button').click();
  await page.getByTestId('offer-card').filter({ hasText: 'Tico Adventures' }).click();
  await page.getByTestId('create-engagement').click();
  await page.getByTestId('agree-button').click();
  await page.getByTestId('fund-button').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Escrow funded');

  // SMB completes only 1 of 3 steps, then tries to submit
  await switchRole(page, 'SMB — Tico Adventures Tours');
  await page.getByTestId('engagement-row').filter({ hasText: 'eco-tour itinerary' }).click();
  await page.getByTestId('proof-input-1').fill('Draft itinerary delivered as PDF.');
  await page.getByTestId('complete-step-1').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('In progress');

  await page.getByTestId('submit-verification').click();
  await expect(page.getByTestId('error-banner')).toBeVisible();
  await expect(page.getByTestId('error-banner')).toContainText('cannot submit');
  await expect(page.getByTestId('engagement-state')).toHaveText('In progress');
  watcher.assertClean();
});

test('marking a step complete without proof text is blocked client- and server-side', async ({ page }) => {
  const watcher = watchPage(page, { allow4xx: true });
  await page.goto('/');
  await switchRole(page, 'SMB — Tico Adventures Tours');
  await page.getByTestId('engagement-row').filter({ hasText: 'eco-tour itinerary' }).click();

  await page.getByTestId('complete-step-2').click(); // empty proof input
  await expect(page.getByTestId('error-banner')).toContainText('Proof of completion is required');
  await expect(page.getByTestId('step-row-2')).toContainText('Pending');
  watcher.assertClean();
});

test('double-clicking fund cannot double-spend', async ({ page }) => {
  const watcher = watchPage(page, { allow4xx: true });
  await page.goto('/');
  const startBalance = await readAgentBalanceCents(page);

  // Pura Vida: $2,000 @ 25% = $500 escrow
  await page.getByTestId('search-input').fill('beachfront land scouting');
  await page.getByTestId('search-button').click();
  await page.getByTestId('offer-card').filter({ hasText: 'Pura Vida Realty' }).click();
  await page.getByTestId('create-engagement').click();
  await page.getByTestId('agree-button').click();
  await page.getByTestId('fund-button').dblclick();

  await expect(page.getByTestId('engagement-state')).toHaveText('Escrow funded');
  await expect(page.getByTestId('escrow-balance')).toHaveText('$500');
  await expect(page.getByTestId('agent-balance')).toHaveText(`Balance ${fmtUsd(startBalance - 50_000)}`);
  await expectLedgerBalanced(page);
  watcher.assertClean();
});

test('double-clicking approve cannot double-release funds', async ({ page }) => {
  const watcher = watchPage(page, { allow4xx: true });
  await page.goto('/');

  // SMB finishes the Pura Vida engagement from the previous test
  await switchRole(page, 'SMB — Pura Vida Realty');
  await page.getByTestId('engagement-row').filter({ hasText: 'land scouting' }).click();
  for (let i = 1; i <= 3; i++) {
    await page.getByTestId(`proof-input-${i}`).fill(`Deliverable ${i} attached.`);
    await page.getByTestId(`complete-step-${i}`).click();
    await expect(page.getByTestId(`proof-${i}`)).toBeVisible(); // wait for re-render
  }
  await page.getByTestId('submit-verification').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Submitted for verification');

  // Agent double-clicks approve
  await switchRole(page, 'Agent — Realtor Assistant Agent');
  const balanceBeforeApprove = await readAgentBalanceCents(page);
  await page.getByRole('link', { name: 'My engagements' }).click();
  await page.getByTestId('engagement-row').filter({ hasText: 'land scouting' }).click();
  await page.getByTestId('approve-button').dblclick();

  await expect(page.getByTestId('engagement-state')).toHaveText('Completed');
  await expect(page.getByTestId('escrow-balance')).toHaveText('$0');
  // exactly one $1,500 remainder draw; SMB paid exactly once ($2,000 total)
  await expect(page.getByTestId('agent-balance')).toHaveText(`Balance ${fmtUsd(balanceBeforeApprove - 150_000)}`);
  await switchRole(page, 'SMB — Pura Vida Realty');
  await page.getByRole('link', { name: 'My profile & offers' }).click();
  await expect(page.getByTestId('smb-balance')).toHaveText('$2,000');
  await expectLedgerBalanced(page);
  watcher.assertClean();
});

test('double-clicking "start engagement" does not create duplicate engagements', async ({ page }) => {
  const watcher = watchPage(page, { allow4xx: true });
  await page.goto('/');
  await page.getByTestId('search-input').fill('bookkeeping tax registration');
  await page.getByTestId('search-button').click();
  await page.getByTestId('offer-card').filter({ hasText: 'Sandoval Accounting' }).click();
  await page.getByTestId('create-engagement').dblclick();
  await expect(page.getByTestId('engagement-state')).toHaveText('Draft');

  await page.getByRole('link', { name: 'My engagements' }).click();
  await expect(page.getByTestId('engagement-row').filter({ hasText: 'bookkeeping' })).toHaveCount(1);
  watcher.assertClean();
});

test('refreshing mid-flow: state and role persist', async ({ page }) => {
  const watcher = watchPage(page);
  await page.goto('/');
  await switchRole(page, 'SMB — Tico Adventures Tours');
  await page.getByTestId('engagement-row').filter({ hasText: 'eco-tour itinerary' }).click();
  await expect(page.getByTestId('engagement-state')).toHaveText('In progress');

  await page.reload();
  await expect(page.getByTestId('engagement-state')).toHaveText('In progress');
  await expect(page.getByTestId('role-switcher')).toHaveValue('smb:3');
  await expect(page.getByTestId('proof-1')).toContainText('Draft itinerary delivered');
  watcher.assertClean();
});

test('empty search results show a graceful empty state', async ({ page }) => {
  const watcher = watchPage(page);
  await page.goto('/');
  await page.getByTestId('search-input').fill('submarine repairs antarctica quantum');
  await page.getByTestId('search-button').click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('empty-state')).toContainText('No offers match');
  await expect(page.getByTestId('offer-card')).toHaveCount(0);
  watcher.assertClean();
});
