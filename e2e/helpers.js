'use strict';
const { expect } = require('@playwright/test');

// Watches a page for console errors, uncaught exceptions and failed network
// requests. Call assertClean() at the end of the test. Error-state specs pass
// allow4xx: true so *expected* API rejections (4xx from our own /api/) are
// tolerated — anything else (5xx, asset 404s, uncaught JS errors) still fails.
function watchPage(page, { allow4xx = false } = {}) {
  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400) {
      failedRequests.push({ status: res.status(), method: res.request().method(), url: res.url() });
    }
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({ status: 0, method: req.method(), url: req.url(), error: req.failure()?.errorText });
  });

  return {
    assertClean() {
      const isAllowedApi4xx = (r) => allow4xx && r.status >= 400 && r.status < 500 && r.url.includes('/api/');
      const badRequests = failedRequests.filter((r) => !isAllowedApi4xx(r));
      // Chrome logs an expected 4xx fetch as a "Failed to load resource" console
      // error; tolerate exactly those when 4xx responses are allowed.
      const badConsole = consoleErrors.filter(
        (c) => !(allow4xx && c.includes('Failed to load resource')),
      );
      expect(badRequests, `unexpected failed network requests:\n${JSON.stringify(badRequests, null, 2)}`).toEqual([]);
      expect(badConsole, `unexpected console errors:\n${badConsole.join('\n')}`).toEqual([]);
    },
  };
}

async function switchRole(page, label) {
  await page.getByTestId('role-switcher').selectOption({ label });
}

async function expectLedgerBalanced(page) {
  const res = await page.request.get('/api/ledger/invariant');
  expect(res.ok()).toBeTruthy();
  const inv = await res.json();
  expect(inv.ok, `ledger invariant broken: ${JSON.stringify(inv)}`).toBe(true);
}

// Reads the agent's header balance chip ("Balance $49,000") as integer cents,
// so specs can assert exact deltas without depending on which specs ran before.
async function readAgentBalanceCents(page) {
  const { expect: expect_ } = require('@playwright/test');
  await expect_(page.getByTestId('agent-balance')).toBeVisible();
  const text = await page.getByTestId('agent-balance').innerText();
  return Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100);
}

function fmtUsd(cents) {
  const dollars = cents / 100;
  return '$' + dollars.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

module.exports = { watchPage, switchRole, expectLedgerBalanced, readAgentBalanceCents, fmtUsd };
