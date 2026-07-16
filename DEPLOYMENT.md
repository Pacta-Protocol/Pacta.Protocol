# Deploying Pacta

One process, one small server:

| Process | Command | Port | What it serves |
|---|---|---|---|
| Marketplace app | `node server-pacta.js` | 3220 | The POC with full trust mechanics (staking, exposure caps, registry-verified proofs) |

Dependency-light Node (≥ 22.5, built-in `node:sqlite`, no external services,
no API keys). Anything that runs Node runs Pacta: a $5 VPS, Docker, Railway/Fly/Render.

## Option A — Docker Compose (recommended)

```bash
git clone https://github.com/Pacta-Protocol/pacta.git /opt/pacta && cd /opt/pacta
docker compose up -d --build
```

- App on `:3220` (SQLite data persisted in the `pacta-data` volume)

## Option B — bare Node + systemd

```bash
git clone https://github.com/Pacta-Protocol/pacta.git /opt/pacta && cd /opt/pacta
npm ci --omit=dev
```

`/etc/systemd/system/pacta-app.service`:

```ini
[Unit]
Description=Pacta marketplace app
After=network.target

[Service]
WorkingDirectory=/opt/pacta
ExecStart=/usr/bin/node server-pacta.js
Restart=always
User=pacta
Environment=PORT=3220

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pacta-app
```

## Reverse proxy (nginx) + TLS

```nginx
server {
    server_name app.your-domain.com;
    location / { proxy_pass http://127.0.0.1:3220; proxy_set_header Host $host; }
}
```

Then `certbot --nginx -d app.your-domain.com` for TLS.

## Verify the deployment

```bash
curl -fsS https://app.your-domain.com/api/config          # feature flags JSON
curl -fsS https://app.your-domain.com/api/agent/manifest   # machine-readable tool list
```

## Environment variables

| Var | Default | Used by |
|---|---|---|
| `PORT` | 3220 (`server-pacta.js`) / 3210 (`server.js`) | app |
| `DB_PATH` | `data/pacta.db` / `data/marketplace.db` | app |

## Notes

- **Website**: the Pacta website lives in its own repository
  ([Pacta-Protocol/pacta-protocol.github.io](https://github.com/Pacta-Protocol/pacta-protocol.github.io))
  and deploys independently (GitHub Pages or any static host). Point its
  `assets/config.js` → `window.PACTA_APP_URL` at this app's public URL.
- **Data**: everything lives in `data/*.db` (SQLite). Back it up by copying the
  directory; reset the demo by deleting it (seed data reloads on boot).
- **Base build**: to also expose the base POC (auto-vetting, no staking), run
  `node server.js` on `:3210` the same way — the two share nothing but code.
- **No auth exists** (POC scope): treat any public deployment as a demo, not as a
  system holding real value.
