'use strict';
const { createApp } = require('../src/app');

// Starts a fresh app on an ephemeral port with an isolated in-memory DB.
function startTestServer({ pacta = false, registry, hardening } = {}) {
  const { app, db } = createApp({ dbPath: ':memory:', pacta, registry, hardening });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        server,
        db,
        base,
        close: () => new Promise((r) => server.close(r)),
        api: async (method, path, body, headers = {}) => {
          const res = await fetch(`${base}/api${path}`, {
            method,
            headers: {
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
          let json = null;
          try { json = await res.json(); } catch { /* non-JSON */ }
          return { status: res.status, body: json, headers: res.headers };
        },
      });
    });
  });
}

module.exports = { startTestServer };
