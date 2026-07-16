'use strict';
// Dispute path through the UI: reject → arbiter split ruling → resolved,
// balances correct on screen. Runs after the happy path (agent starts at $45,000).
const { test, expect } = require('@playwright/test');
const { watchPage, switchRole, expectLedgerBalanced, readAgentBalanceCents, fmtUsd } = require('./helpers');

test('dispute: reject proofs → arbiter splits escrow → resolved with correct balances', async ({ page }) => {
  const watcher = watchPage(page);

  // Agent contracts LexCorp's offer ($4,500, 30% down = $1,350 escrow)
  await page.goto('/');
  const startBalance = await readAgentBalanceCents(page);
  await page.getByTestId('search-input').fill('company formation Costa Rica');
  await page.getByTestId('search-button').click();
  await page.getByTestId('offer-card').filter({ hasText: 'LexCorp Legal Solutions' }).click();
  await page.getByTestId('create-engagement').click();
  await page.getByTestId('agree-button').click();
  await page.getByTestId('fund-button').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Escrow funded');
  await expect(page.getByTestId('escrow-balance')).toHaveText('$1,350');
  await expect(page.getByTestId('agent-balance')).toHaveText(`Balance ${fmtUsd(startBalance - 135_000)}`);

  // SMB completes all 3 steps and submits
  await switchRole(page, 'SMB — LexCorp Legal Solutions');
  await page.getByTestId('engagement-row').filter({ hasText: 'company formation package' }).click();
  for (let i = 1; i <= 3; i++) {
    await page.getByTestId(`proof-input-${i}`).fill(`Delivered: work item ${i} (see file LC-${i}).`);
    await page.getByTestId(`complete-step-${i}`).click();
    await expect(page.getByTestId(`proof-${i}`)).toBeVisible(); // wait for re-render
  }
  await page.getByTestId('submit-verification').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Submitted for verification');

  // Agent rejects with a reason → dispute
  await switchRole(page, 'Agent — Realtor Assistant Agent');
  await page.getByRole('link', { name: 'My engagements' }).click();
  await page.getByTestId('engagement-row').filter({ hasText: 'company formation package' }).click();
  await page.getByTestId('reject-reason').fill('Corporate legal books were never delivered despite the proof claim.');
  await page.getByTestId('reject-button').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Disputed');
  await expect(page.getByTestId('dispute-reason')).toContainText('legal books were never delivered');

  // Arbiter rules: split 50/50 → $675 each
  await switchRole(page, 'Arbiter — Marketplace Arbiter');
  const disputeRow = page.getByTestId('dispute-row').filter({ hasText: 'company formation package' });
  await expect(disputeRow).toContainText('escrow holds $1,350');
  await disputeRow.click();
  await page.getByTestId('ruling-split').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Resolved');
  await expect(page.getByTestId('resolution')).toContainText('split');
  await expect(page.getByTestId('escrow-balance')).toHaveText('$0');

  // Balances on screen: agent got $675 back, LexCorp received $675
  await switchRole(page, 'Agent — Realtor Assistant Agent');
  await expect(page.getByTestId('agent-balance')).toHaveText(`Balance ${fmtUsd(startBalance - 67_500)}`);
  await switchRole(page, 'SMB — LexCorp Legal Solutions');
  await page.getByRole('link', { name: 'My profile & offers' }).click();
  await expect(page.getByTestId('smb-balance')).toHaveText('$675');

  // Ledger view agrees and the invariant holds
  await page.getByRole('link', { name: 'Ledger' }).click();
  await expect(page.getByTestId('invariant-status')).toContainText('✓ Ledger balanced');
  await expectLedgerBalanced(page);

  watcher.assertClean();
});
