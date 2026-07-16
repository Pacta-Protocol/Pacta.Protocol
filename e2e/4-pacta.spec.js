'use strict';
// Pacta through the real UI: staking badges, the vetting gate, and
// registry-verified proofs. Runs against the dedicated Pacta server (port 3101).
const { test, expect } = require('@playwright/test');
const { watchPage, switchRole } = require('./helpers');

const B = 'http://127.0.0.1:3101';

test('Pacta UI: staked badges, unvetted gate, and self-verifying proofs', async ({ page }) => {
  const watcher = watchPage(page, { allow4xx: true }); // the vetting gate 409 is expected

  // Header shows the Pacta Protocol brand; vetted badges mention the stake
  await page.goto(B + '/');
  await expect(page.locator('.brand')).toHaveAttribute('aria-label', 'Pacta Protocol');
  await page.getByTestId('search-input').fill('lawyer Costa Rica hotel');
  await page.getByTestId('search-button').click();
  const bufeteCard = page.getByTestId('offer-card').filter({ hasText: 'Bufete Herrera' });
  await expect(bufeteCard).toContainText('Vetted ✓ · staked');

  // The unvetted SMB is visibly marked and cannot be contracted
  await page.getByTestId('search-input').fill('budget company formation');
  await page.getByTestId('search-button').click();
  const unvettedCard = page.getByTestId('offer-card').filter({ hasText: 'Despacho Sin Garantía' });
  await expect(unvettedCard.getByTestId('unvetted-badge')).toHaveText('No stake — not vetted');
  await unvettedCard.click();
  await page.getByTestId('create-engagement').click();
  await expect(page.getByTestId('error-banner')).toContainText('not vetted');

  // SMB profile shows collateral economics
  await page.goto(B + '/#/smbs/1');
  await expect(page.getByTestId('smb-stake')).toHaveText('$1,500');
  await expect(page.getByTestId('smb-cap')).toContainText('$7,500');

  // Contract Bufete and fund escrow
  await page.goto(B + '/#/');
  await page.getByTestId('search-input').fill('lawyer Costa Rica hotel');
  await page.getByTestId('search-button').click();
  await page.getByTestId('offer-card').filter({ hasText: 'Bufete Herrera' }).click();
  await page.getByTestId('create-engagement').click();
  await page.getByTestId('agree-button').click();
  await page.getByTestId('fund-button').click();
  await expect(page.getByTestId('engagement-state')).toHaveText('Escrow funded');

  // SMB: registry-anchored step demands a valid public-record reference
  await switchRole(page, 'SMB — Bufete Herrera & Asociados');
  await page.getByTestId('engagement-row').filter({ hasText: 'Establish a Costa Rican company' }).click();

  await page.getByTestId('proof-input-1').fill('S.R.L. incorporated at the National Registry.');
  await page.getByTestId('proof-registry-1').fill('CR-FAKE-000');
  await page.getByTestId('complete-step-1').click();
  await expect(page.getByTestId('error-banner')).toContainText('not found in the public registry');
  await expect(page.getByTestId('step-row-1')).toContainText('Pending');

  await page.getByTestId('proof-registry-1').fill('CR-RN-2026-104512');
  await page.getByTestId('complete-step-1').click();
  await expect(page.getByTestId('proof-verified-1')).toContainText('Verified against public registry');
  await expect(page.getByTestId('proof-verified-1')).toContainText('CR-RN-2026-104512');

  watcher.assertClean();
});
