# Obsidian LiveSync (self-hosted CouchDB) — operate runbook

Status: LIVE on `critical` (LXC 100, 192.168.0.50), LAN-only.

## What this is

- CouchDB 3.3.3 (single-node), Docker container `obsidian-couchdb`, bound to
  `192.168.0.50:5984`.
- Data + config persisted to NAS at `/mnt/nas/services/obsidian-livesync/`.
- Obsidian vault (the human's markdown) at `/mnt/nas/obsidian/vault/` — owned by
  the Obsidian client, NOT this container, NOT Git.
- Secrets live in Vaultwarden folder `Homelab`: `obsidian-livesync/couchdb`
  (admin) and `obsidian-livesync/livesync` (client user). Never commit values.

## Architecture authority

`docs/obsidian-source-of-truth.md` is the canonical spec. This service implements
sections A (vault layout) and B (CouchDB component map) of that spec.

## LAN-only posture (do not relax without an explicit new task)

- Bind is `192.168.0.50:5984`, so only clients that can reach that interface
  connect. Confirm with `ss -tulpn | grep 5984` → `192.168.0.50:5984`, NOT
  `0.0.0.0:5984`.
- There is NO Traefik router, no TLS, no Cloudflare Tunnel, no public hostname.
  Remote access is deferred. If you add a Traefik router for this service you
  are violating the agreed posture — stop and get explicit approval.

## Deploy / reconcile

The host `critical` has no docker compose plugin; existing services
(vaultwarden/postgres/traefik) are launched with raw `docker run`. The committed
`docker-compose.yml` is desired state; once you apply it, reconcile the running
container to it.

```bash
# On the worker (Tori), render .env from Vaultwarden:
cd /root/work/home-lab
eval "$(scripts/secrets/bw-login-vaultwarden.sh)"
scripts/secrets/render-env-from-vaultwarden.sh \
  services/obsidian-livesync/obsidian-livesync.env.map.example > services/obsidian-livesync/.env
chmod 0600 services/obsidian-livesync/.env

# Copy .env + config to critical (do NOT commit .env):
scp services/obsidian-livesync/.env root@192.168.0.50:/mnt/nas/services/obsidian-livesync/.env
scp services/obsidian-livesync/config/10-single-node.ini \
    root@192.168.0.50:/mnt/nas/services/obsidian-livesync/config/10-single-node.ini
```

Launch (LAN-only, single-node, admin from Vaultwarden):

```bash
docker run -d --name obsidian-couchdb --restart unless-stopped \
  --env-file /mnt/nas/services/obsidian-livesync/.env \
  -p 192.168.0.50:5984:5984 \
  -v /mnt/nas/services/obsidian-livesync/data:/opt/couchdb/data \
  -v /mnt/nas/services/obsidian-livesync/config:/opt/couchdb/etc/local.d \
  couchdb@sha256:307a3f5276f64c0db28f226b7b5c180b8f2c851afa681cfb4fbb1b1fe7fd5587
```

Note: the image entrypoint ignores `COUCHDB_SINGLE_NODE`; single-node mode is
enforced by `config/10-single-node.ini` (`[couchdb] single_node = true`).

## Provision the database + scoped user (first deploy only)

Admin creds: Vaultwarden `Homelab/obsidian-livesync/couchdb` (username/password).

```bash
ADMIN_USER='<couchdb admin username>'
ADMIN_PASS='<couchdb admin password>'
LIVE_USER='<livesync username>'
LIVE_PASS='<livesync password>'
BASE="http://192.168.0.50:5984"

# Create the `obsidian` database (LiveSync target DB).
curl -sS -u "$ADMIN_USER:$ADMIN_PASS" -X PUT "$BASE/obsidian" | jq .

# Create the scoped `livesync` user with _admin role (LiveSync needs admin to
# create local DBs on first sync; if you want least privilege instead, grant
# the user as a member of the `obsidian` DB and use it for replication only).
curl -sS -u "$ADMIN_USER:$ADMIN_PASS" -X PUT "$BASE/_node/_local/_config/admins" \
  # (not used) — instead create the _users doc directly:
curl -sS -u "$ADMIN_USER:$ADMIN_PASS" -X PUT \
  "$BASE/_users/org.couchdb.user:$LIVE_USER" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$LIVE_USER\",\"password\":\"$LIVE_PASS\",\"roles\":[],\"type\":\"user\"}" | jq .
```

The Obsidian LiveSync plugin onboarding URI is `obsidian://setuplivesync?…`
encoding `http://192.168.0.50:5984` + the livesync username/password. Record that
credential in Vaultwarden `Homelab/obsidian-livesync/livesync` (fields username/
password/database/host/port), NOT in Git.

## Verify

```bash
# Reachable on LAN + admin auth works:
curl -sS -u "$ADMIN_USER:$ADMIN_PASS" http://192.168.0.50:5984/_up          # {"status":"ok"}
curl -sS -u "$ADMIN_USER:$ADMIN_PASS" http://192.168.0.50:5984/_all_dbs     # includes "obsidian"
# Data persisted to NAS:
ls /mnt/nas/services/obsidian-livesync/data
# NOT on 0.0.0.0:
ss -tulpn | grep 5984     # must show 192.168.0.50:5984, not 0.0.0.0:5984
# No Traefik route (empty result):
curl -s http://192.168.0.50:8080/api/http/routers | jq '.[] | select(.service|test("couch|obsidian|livesync";"i"))'
```

## Backup

CouchDB data on NAS under `/mnt/nas/services/obsidian-livesync/data`. Confirm
the NAS backup matrix in `docs/backup-coverage-matrix.md` covers this path
(follow-up if not). The vault itself (`/mnt/nas/obsidian/vault/`) is the human's
source of truth and is synced to clients via LiveSync, not backed up here.