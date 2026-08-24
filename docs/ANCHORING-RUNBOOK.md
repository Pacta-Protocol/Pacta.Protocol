# Anchoring service — production runbook

The AnchorRegistry is deployed and source-verified on **Base mainnet**
(`0x866316ae68b297cc2b3ed2daaf3cabd4f5e39de1`, chainId 8453). This runbook covers
running the anchoring service against it so it emits real roots on a 12h cadence.

## What the service does

A background worker builds a Merkle root over the event-log entries in each 12h
window and calls `anchor(root, windowStart, windowEnd, leafCount)` on the registry.
It **always emits**, even for empty windows (`leafCount = 0`, zero root), so a
reviewer never sees a dead system. Windows are contiguous, retried without gaps or
double-anchoring, and only persisted after the on-chain tx succeeds.

Transactions are EIP-1559 (type-2) signed for Base/OP-stack. (Legacy signing is
rejected by op-geth; the adapter signs with `prehash:false` — see ADR-002.)

## Configuration (environment)

The service reads these from the environment. Keep the signer key in a secret store
or a gitignored `.env`, **never in the repo**:

```
ANCHOR_PROVIDER=rpc
ANCHOR_RPC_URL=<a Base mainnet RPC — e.g. your Alchemy/QuickNode endpoint>
ANCHOR_CONTRACT_ADDRESS=0x866316ae68b297cc2b3ed2daaf3cabd4f5e39de1
ANCHOR_CHAIN_ID=8453
ANCHOR_SIGNER_KEY=<the anchorer private key — the wallet that owns anchoring>
ANCHOR_WINDOW_HOURS=12
```

The anchorer wallet is `0x60b134390c33Ae25f4a6f4948b3170fc71F39e67`. Fund it with a
little ETH (each anchor costs fractions of a cent). Rotate it without redeploying
via `setAnchorer(next)` called from the current anchorer key.

Testnet equivalent (Base Sepolia, chainId 84532):
`ANCHOR_CONTRACT_ADDRESS=0xb1cb4c8d26e2457705f0ffaa823019c2ba0c4fa2`,
`ANCHOR_CHAIN_ID=84532`.

## Run it permanently (systemd)

A local `node server-pacta.js` works but stops when the machine sleeps. For the
continuous ≥24h of anchors the application needs, run it on an always-on host:

```ini
# /etc/systemd/system/pacta-anchor.service
[Unit]
Description=Pacta marketplace + anchoring service
After=network.target

[Service]
WorkingDirectory=/opt/pacta
EnvironmentFile=/opt/pacta/.env      # holds ANCHOR_* incl. the signer key (chmod 600)
ExecStart=/usr/bin/node server-pacta.js
Restart=always
User=pacta

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pacta-anchor
journalctl -u pacta-anchor -f          # watch anchoring logs
```

## Keep windows non-empty

On a cold/empty log the worker defers until the first event, then emits every
window. To make most anchored windows carry real content, schedule the
deterministic demo at least daily:

```
# crontab
0 3 * * *  cd /opt/pacta && npm run demo:agent >> /var/log/pacta-demo.log 2>&1
```

## Verify anchors are landing

```bash
# count() should climb over time
cast call 0x866316ae68b297cc2b3ed2daaf3cabd4f5e39de1 "count()(uint256)" \
  --rpc-url https://mainnet.base.org
```

Or open the contract's **Events** tab on Basescan and watch `RootAnchored` events
accrue. Anyone can verify a specific agreement against these roots with the
standalone verifier (`packages/verifier`) using only a public RPC — no Pacta needed.

## Cost

Deploy + each anchor cost fractions of a cent on Base. A few dollars of ETH covers
years of 12h anchoring.
