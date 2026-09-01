# Unified Inbox — Phase 1 deploy plan (t_b98018e3)

Status: READY TO APPLY, awaiting Ben approval. No live mutation has been performed.

## What this deploys

Phase 1 unified inbox read-only backend + Email/RSS/webhook connectors (commit c51434e)
and the Unified Inbox dashboard Overview panel (commit fb9df1c). No message
bodies, senders, secrets, or local paths surface anywhere in the dashboard or
backend status endpoints — all three parent reviews passed (t_2da6cae2 backend,
t_df15d627 dashboard, t_ff28a6f3 connectors).

## Deployment shape (verified by read-only discovery on 2026-09-01)

- Target host: `critical` (192.168.0.50), Alpine LXC.
- Docker present (25.0.5). **No Docker Compose plugin** → use the plain-Docker
  fallback `scripts/run-critical-docker.sh` (mirrors the dashboard pattern).
- No existing container, no `/var/lib/unified-inbox`, no
  `/mnt/nas/services/unified-inbox`, nothing listening on 8766. Clean slate.
- Node is NOT required on the LXC host — the build runs inside `node:22-alpine`.

## Credential state

Vaultwarden is locked; no connector credentials are available. The backend boots
`connectors: []` and reports honest zero/`not_configured` state (verified locally:
`/healthz` → `{ok:true}`, `/api/unified-inbox/status` → empty connectors + the two
mandatory exclusions, no paths). Phase 1 deploy is therefore **fixture-disabled**:
Email/RSS/webhook ship in `not_configured`/`pending_credentials` state. No secret
env rendering is required for this deploy.

## Bounded apply commands (all on `critical`)

```
# 0. Preflight (read-only)
docker ps --format 'table {{.Names}}\t{{.Ports}}'
netstat -ltnp | grep ':8766\b' || echo '8766 free'

# 1. Sync app code to the NAS app path (from tori, git-aware copy)
#    APP_DIR on critical defaults to /mnt/nas/services/unified-inbox/app
#    (see scripts/run-critical-docker.sh). Copy only services/unified-inbox/ from
#    the repo. No secrets are in this tree (verified by reviewer secret scans).

# 2. Host-local runtime root (NOT on NAS/NFS — active state must stay off NFS)
install -d -o root -g root -m 0755 /var/lib/unified-inbox/state
install -d -o root -g root -m 0755 /var/lib/unified-inbox/snapshots/closed

# 3. NAS immutable export dirs
install -d -m 0755 /mnt/nas/services/unified-inbox/snapshots/normalized
install -d -m 0755 /mnt/nas/services/unified-inbox/manifests

# 4. Build + run the container (no env needed — zero-connector fixture state)
sh /mnt/nas/services/unified-inbox/app/scripts/run-critical-docker.sh
```

Notes:
- `run-critical-docker.sh` publishes `172.17.0.1:8766:8766` (Docker bridge IP, not a
  public LAN bind). No Traefik/Cloudflare/DNS changes in this phase — the backend is
  reachable only via the docker bridge host and the LAN `http://192.168.0.50:8766`
  already referenced by the dashboard panel. Exposing it publicly is a **separate**
  later approval (per ADR, `https://inbox.wheeler-network.com` needs its own gate).
- The dashboard panel links point at `http://192.168.0.50:8766` (LAN-only), matching
  the reviewed dashboard config; those URLs are reachable only if 8766 is reachable
  from the viewer's LAN, which the Docker bridge publish does NOT currently provide.
  This is a known gap to confirm at verification (`curl` from a LAN host), not a
  blocker for a `not_configured` fixture deploy.

## Risk

- Live mutation limited to: create `/var/lib/unified-inbox/*` and
  `/mnt/nas/services/unified-inbox/*`, build a local image, run one new container on
  8766 (docker bridge publish only). No existing containers, networks, routes, DNS,
  or credentials touched. No destructive operations.

## Rollback

- Stop + remove only the new container:
  `docker rm -f unified-inbox`
- Optionally remove the image: `docker rmi unified-inbox:local`
- Host/NAS dirs are left in place for inspection unless Ben approves deletion.

## Verification (after apply)

```
curl -fsS http://172.17.0.1:8766/healthz
curl -s http://172.17.0.1:8766/api/unified-inbox/status   # empty connectors, exclusions, no paths
docker ps --format '{{.Names}} {{.Status}}' | grep unified-inbox
# secret scan over rendered tree + logs: no values
```

Downstream verification lane `t_238d29b8` (sentinel) runs the full read-only evidencing pass.