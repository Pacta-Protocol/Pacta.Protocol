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
| `REQUIRE_API_KEYS` / `ARBITER_API_KEY` / `RATE_LIMIT_PER_MIN` | off / none / 600 | hardening (see README) |
| `REGISTRY_ADAPTER` / `REGISTRY_URL` | `local` | registry verification |

### Phase 0 - cryptographic immutability (ADR-001)

All optional; with the defaults the server signs custodially and anchors to a
deterministic local adapter (no wallet, no RPC, no gas), so nothing below is
required to run.

| Var | Default | Used by |
|---|---|---|
| `PLATFORM_SIGNING_KEY` | auto-generated, persisted to `PLATFORM_KEY_FILE` | platform receipt/anchor signing |
| `PLATFORM_KEY_FILE` | `data/platform-key` | where the platform key is read/written |
| `ANCHOR_PROVIDER` | `local` (`rpc` if `ANCHOR_RPC_URL` set) | anchoring adapter |
| `ANCHOR_RPC_URL` / `ANCHOR_CONTRACT_ADDRESS` / `ANCHOR_SIGNER_KEY` | none | `rpc` anchoring to a real EVM chain |
| `ANCHOR_CHAIN_ID` | `8453` (Base mainnet) | EIP-712 domain + anchor tx chain (`84532` = Base Sepolia) |
| `ANCHOR_WINDOW_HOURS` / `ALERT_AFTER_MINUTES` | 12 / 30 | anchor window length / failure-alert threshold |
| `ALERT_WEBHOOK_URL` | none | anchor-failure alerts |
| `ANCHOR_AUTOSTART` | on (`0` disables) | in-process anchor worker |

To anchor to Base: deploy `contracts/AnchorRegistry.sol` with
`DEPLOY_NETWORK=base-sepolia|base-mainnet DEPLOY_SIGNER_KEY=0x… node scripts/deploy-anchor-registry.js`.
The script is network-aware (default `base-mainnet`): it picks the public RPC and
the right Basescan explorer for you (override the RPC with `DEPLOY_RPC_URL`),
compiles with a pinned solc, and prints the address plus verification steps —
see the script header, ADR-002, and `.primos/blockers-wp1.md` for the exact
copy-paste commands for both networks. Then fund the `ANCHOR_SIGNER_KEY` anchorer
wallet with a little ETH and set `ANCHOR_PROVIDER=rpc`, `ANCHOR_RPC_URL`,
`ANCHOR_CONTRACT_ADDRESS`, and `ANCHOR_CHAIN_ID` (`84532` Sepolia / `8453`
mainnet). The service anchors one Merkle root per `ANCHOR_WINDOW_HOURS` window,
always emitting — empty windows go out with `leafCount = 0`. Verify a receipt end
to end with `packages/verifier` (`pacta-verify receipt.json --rpc <url>`).

#### Deployed `AnchorRegistry` contracts

The reference `AnchorRegistry` is **deployed and source-verified on Base**. Point
a production deployment's `rpc` anchoring adapter at the mainnet contract; use the
Sepolia mirror for testing. Both were deployed 2026-08-23 from
`scripts/deploy-anchor-registry.js`.

| | Production — Base mainnet | Testnet — Base Sepolia |
|---|---|---|
| `ANCHOR_CHAIN_ID` | `8453` | `84532` |
| `ANCHOR_CONTRACT_ADDRESS` | `0x866316ae68b297cc2b3ed2daaf3cabd4f5e39de1` | `0xb1cb4c8d26e2457705f0ffaa823019c2ba0c4fa2` |
| `ANCHOR_RPC_URL` | `https://mainnet.base.org` | `https://sepolia.base.org` |
| Anchorer address | `0x60b134390c33Ae25f4a6f4948b3170fc71F39e67` | `0xd09ff24418Fc067F2C56F16CD486ADB169C9AeEa` |
| Basescan (source verified) | [mainnet](https://basescan.org/address/0x866316ae68b297cc2b3ed2daaf3cabd4f5e39de1#code) | [sepolia](https://sepolia.basescan.org/address/0xb1cb4c8d26e2457705f0ffaa823019c2ba0c4fa2#code) |

The `ANCHOR_SIGNER_KEY` you configure must be the private key of the anchorer
address for that network (or a new one you rotate in with `setAnchorer`); keep it
in a secret store, never in a file. To anchor to production, set
`ANCHOR_PROVIDER=rpc`, the mainnet `ANCHOR_CONTRACT_ADDRESS`, `ANCHOR_RPC_URL` and
`ANCHOR_CHAIN_ID=8453`, and fund the anchorer wallet with a little ETH for gas.

## Notes

- **Website**: the Pacta website lives in its own repository
  ([Pacta-Protocol/pacta-protocol.github.io](https://github.com/Pacta-Protocol/pacta-protocol.github.io))
  and deploys independently (GitHub Pages or any static host). Point its
  `assets/config.js` → `window.PACTA_APP_URL` at this app's public URL.
- **Data**: everything lives in `data/*.db` (SQLite). Back it up by copying the
  directory; reset the demo by deleting it (seed data reloads on boot).
- **Platform signing key**: `data/platform-key` is the platform's persistent
  Phase 0 signing identity, auto-generated on first boot. It signs every
  receipt, so back it up alongside the database. Deleting `data/` rotates it
  and invalidates all previously issued receipts and signatures - for a real
  deployment set `PLATFORM_SIGNING_KEY` (or `PLATFORM_KEY_FILE`) from a secret
  store instead of relying on the on-disk default. The Docker `pacta-data`
  volume already persists it; bare-Node/systemd operators must handle it.
- **Base build**: to also expose the base POC (auto-vetting, no staking), run
  `node server.js` on `:3210` the same way — the two share nothing but code.
- **No auth exists** (POC scope): treat any public deployment as a demo, not as a
  system holding real value.
