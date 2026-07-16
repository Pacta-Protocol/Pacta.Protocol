'use strict';
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  // The specs share one server + database and build on each other's ledger state
  // (they replay the demo scenario in order), so they must run sequentially.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/e2e-server.js',
      url: 'http://127.0.0.1:3100/api/ledger/invariant',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // Pacta instance for e2e/4-pacta.spec.js (which uses absolute URLs)
      command: 'node scripts/e2e-server-pacta.js',
      url: 'http://127.0.0.1:3101/api/ledger/invariant',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
