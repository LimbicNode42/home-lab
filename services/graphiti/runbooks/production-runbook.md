# Graphiti + Neo4j production runbook

Last updated: 2026-10-01T10:00:20Z

Status: ready-to-run blocked configuration. The Git-backed deployment, backup, restore-test, and dashboard surfaces exist, but the live Graphiti/Neo4j service is not deployed yet because the required Vaultwarden/OpenRouter preflight has not been rerun from an unlocked secret-manager session.

## 1. Purpose and scope

Graphiti + Neo4j is the planned shared operational/provenance graph for Hermes homelab work. Its job is to store curated, source-backed operational episodes and temporal facts: service topology, task handoffs, incident timelines, backup/restore evidence, dependency notes, caveats, and supersession history.

It is not the personal memory provider.

mem0 remains the active personal/preference provider for Ben's durable preferences, personal facts, and assistant behavior context. This rollout must not switch Hermes away from mem0, migrate mem0 records, delete mem0 data, or make homelab recovery depend on Graphiti.

Graphiti output is advisory context only. Operators and agents must still verify current live state from the original system before remediation. The graph can point at evidence; it is not the source of truth by decree. Small mercy.

## 2. Current verified state

Live state, as captured by the verified infrastructure handoff:

- Target host: `tori` (`192.168.0.20`).
- SSH to `root@192.168.0.20`: verified OK by the infra worker.
- Docker on tori: `Docker version 26.1.5+dfsg1, build a72d7cd`.
- `/` and `/var/lib`: `/dev/sda2` ext4, local disk.
- `/mnt/pve/NAS`: NFS mount from `192.168.0.250:/export/nas`; `/mnt/pve/NAS/services` reachable.
- No `graphiti` or `neo4j` containers were observed by the bounded name/image probe.
- No listeners were observed on `7474`, `7687`, or `8000`.
- No live deployment, backup, restore test, public route, Cloudflare Tunnel route, Traefik route, raw agent-facing endpoint, or Hermes memory-provider change has been performed.

Blocked prerequisite:

- `bw status` in the worker environment was `locked`.
- No `BW_SESSION` or `BW_PASSWORD` was available.
- The OpenRouter guardrail preflight could not be rerun through the Vaultwarden-backed credential path.

Evidence locations:

- `services/graphiti/runbooks/infra-implementation-status.md`
- `services/graphiti/runbooks/implementation-unblock-instructions.md`
- `services/graphiti/receipts/2026-10-01-implementation-blocked.json`
- `services/graphiti/receipts/2026-10-01-backup-restore-blocked.json`
- `services/graphiti/receipts/2026-10-01-dashboard-status.json`

## 3. Architecture and posture

Production candidate posture:

- Host: `tori` (`192.168.0.20`) first.
- Runtime root: `/opt/graphiti` on tori.
- Graphiti API: loopback-only by default.
- Neo4j HTTP and Bolt: loopback-only by default.
- Public exposure: none.
- Cloudflare Tunnel route: none.
- Public Traefik route: none.
- Agent access: only through a later reviewed read-only wrapper/tool. Do not point agents at raw Graphiti.
- Neo4j live data: tori-local disk only.
- NAS: backup dumps, config snapshots, manifests, and restore-test evidence only.

Default binds from the production candidate:

```text
Graphiti API: 127.0.0.1:8000
Neo4j HTTP:   127.0.0.1:7474
Neo4j Bolt:   127.0.0.1:7687
```

Expected repository artifacts:

- `services/graphiti/docker-compose.tori.yml` - reviewed tori-local production template.
- `services/graphiti/.env.example` - non-secret environment shape.
- `services/graphiti/config/vaultwarden-map.example.yml` - Vaultwarden item/field references.
- `services/graphiti/graphiti.env.map.example` - repo-wide secret-rendering map format.
- `services/graphiti/scripts/deploy-tori-local.sh` - preflight/deploy helper.
- `services/graphiti/scripts/openrouter-guardrail-preflight.py` - exact-model OpenRouter probe.
- `services/graphiti/scripts/verify-loopback-exposure.sh` - unsafe-bind check.
- `services/graphiti/scripts/backup-neo4j-dump.sh` - gated Neo4j dump/config snapshot/manifest automation.
- `services/graphiti/scripts/restore-test-neo4j.sh` - gated disposable restore-test automation.
- `services/graphiti/scripts/restore-neo4j-dump.sh` - destructive live restore helper, not routine verification.

## 4. Data placement

Runtime paths on tori:

```text
/opt/graphiti/
  docker-compose.yml              # rendered/reviewed runtime compose; not committed with secrets
  .env                            # rendered from Vaultwarden; mode 0600; never committed

/var/lib/graphiti/neo4j/data/      # live Neo4j database on tori-local disk
/var/lib/graphiti/neo4j/logs/      # local logs if not container-managed
```

NAS evidence paths:

```text
/mnt/pve/NAS/services/graphiti/
  backups/neo4j-dumps/<stamp>/
  config-snapshots/<stamp>/
  restore-tests/<stamp>/
  manifests/neo4j-backup-<stamp>.manifest.json
```

Hard rule: do not place live Neo4j `/data` on NAS, NFS, CIFS, or FUSE storage unless Ben explicitly approves a later exception with a written risk note. The backup script checks the live data filesystem type before apply and refuses unsafe live data targets.

## 5. Secret references and BW/Vaultwarden usage

Vaultwarden is the homelab secret reference model. Git stores only item and field names, placeholders, render maps, and non-secret receipts.

Vaultwarden location:

```text
server: http://192.168.0.50:8084
folder: Homelab / homelab as documented by the current map in use
```

Important note: repository files currently contain both historical lower-case `homelab` references and current implementation references to case-sensitive `Homelab`. Before running, use the exact folder spelling from the deployed render map and `bw list folders`; do not guess if Bitwarden CLI lookup fails.

Required items/fields:

```text
item: graphiti/openrouter
  api_key or login password -> OPENROUTER_API_KEY
  base_url                  -> https://openrouter.ai/api/v1
  completion_model          -> openai/gpt-4o-mini
  embedding_model           -> openai/text-embedding-3-small
  embedding_dim             -> 1536

item: graphiti/neo4j
  username
  password
  uri
  browser_url

item: graphiti/service-auth
  api_token                 # only for a later reviewed wrapper, not raw public exposure
```

Secret handling rules:

- Never commit rendered `.env` files.
- Never paste API keys, Neo4j passwords, `BW_SESSION`, `BW_PASSWORD`, dumps, raw graph data, raw transcripts, or token-bearing logs into Git, comments, dashboard JSON, or handoffs.
- Use `bw unlock --raw` or the repo's reviewed secret-rendering helper; do not pass master passwords on command lines.
- Render runtime files on tori with restrictive permissions (`0600`).

## 6. Deploy/update procedure

Run all commands from `/root/work/home-lab` or from a reviewed deployed copy of this repository. Do not run the apply path until the preflight-only path passes.

### 6.1 Preflight only, no live mutation

Unlock Vaultwarden for the operator/worker first:

```bash
bw config server http://192.168.0.50:8084
export BW_SESSION="$(bw unlock --raw)"
```

Then run the deployment preflight:

```bash
cd /root/work/home-lab
services/graphiti/scripts/deploy-tori-local.sh --preflight-only
```

The preflight must verify the exact OpenRouter model posture:

- base URL: `https://openrouter.ai/api/v1`
- completion/reranker/small model: `openai/gpt-4o-mini`
- embedding model: `openai/text-embedding-3-small`
- embedding dimension observed: `1536`
- no secret appears in output or logs

If preflight fails, stop and record the failing gate. Do not start services optimistically. That is how YAML becomes folklore.

### 6.2 Apply deployment

Only after preflight passes and the deploy card is approved:

```bash
cd /root/work/home-lab
GRAPHITI_IMAGE=zepai/graphiti@sha256:<reviewed_64_hex_digest> \
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
  services/graphiti/scripts/deploy-tori-local.sh --apply
```

Expected effects of apply, per the committed helper/template:

- require `GRAPHITI_IMAGE` to be an explicit reviewed `@sha256:<64-hex>` image digest;
- render/copy reviewed runtime material to tori;
- keep secrets out of Git;
- start Neo4j only from the tori-local compose shape;
- bind raw service ports to loopback;
- keep live Neo4j data on `/var/lib/graphiti/neo4j/data`.

The Graphiti API start is a reviewed second stage after Neo4j health/log receipts are captured:

```bash
ssh root@192.168.0.20 \
  "cd /opt/graphiti && docker compose up -d graphiti-api && docker compose ps"
```

Before running that command, confirm `/opt/graphiti/.env` still contains the reviewed immutable `GRAPHITI_IMAGE` digest and the Neo4j readiness/exposure receipts are acceptable. Do not use the second-stage command to bypass the preflight/apply gates.

After any update, repeat the health and exposure verification below and update receipts.

## 7. Health verification

### 7.1 Loopback exposure receipt

After deployment or update:

```bash
cd /root/work/home-lab
GRAPHITI_VERIFY_HOST=root@192.168.0.20 \
  services/graphiti/scripts/verify-loopback-exposure.sh \
  /tmp/graphiti-listen-scope-after-deploy.txt
```

Required result:

- Graphiti API, Neo4j HTTP, and Neo4j Bolt are not bound to `0.0.0.0` or `::`.
- No public route exists.
- No dashboard response exposes internal probe URLs, credentials, raw query text, or logs.

### 7.2 Service readiness checks

From tori, verify:

```bash
findmnt -T /var/lib/graphiti/neo4j/data
ss -ltnp | grep -E ':(7474|7687|8000)\b' || true
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
```

Expected state after full two-stage deployment:

- `/var/lib/graphiti/neo4j/data` is on local disk, not NAS/NFS/CIFS/FUSE.
- `neo4j` is healthy/ready.
- `graphiti-api` is reachable only through the reviewed bind posture.
- no raw destructive endpoint is agent-facing.

Record sanitized output as a receipt under `services/graphiti/receipts/`; do not include secrets or raw graph dumps.

## 8. Ingest/query/provenance smoke test

Do this only after deploy health passes. Use sanitized data and a unique smoke-test group so the test can be identified and cleaned/reviewed later.

Procedure:

1. Create a small synthetic operational episode such as: `Graphiti production smoke test at <timestamp>; source=operator smoke test; no secrets; safe to delete/review`.
2. Ingest it into a dedicated group, for example `ops-smoke-<YYYYMMDDHHMMSS>`.
3. Query for the synthetic fact through the reviewed API path.
4. Verify the response contains provenance/source metadata and the smoke-test group identifier.
5. Verify the response does not expose raw credentials, raw transcripts, API keys, internal logs, or unrestricted Cypher.
6. Record the sanitized request shape, response status, group name, and provenance fields in a receipt.

Do not use production secrets, real incident logs containing credentials, raw Hermes transcripts, or customer/personally sensitive data for this smoke test.

## 9. Backup and restore-test procedure

Backup and restore-test automation is present and dry-run/syntax validated, but no live backup or restore-test has run because the service is not deployed.

### 9.1 Dry-run backup plan

```bash
cd /root/work/home-lab
services/graphiti/scripts/backup-neo4j-dump.sh --dry-run
```

### 9.2 Approved backup

Neo4j Community dumps are treated as offline dumps. This backup may stop/restart Graphiti/Neo4j through Docker Compose, so run it in an approved window:

```bash
cd /root/work/home-lab
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
GRAPHITI_BACKUP_ALLOW_SERVICE_STOP=approved \
  services/graphiti/scripts/backup-neo4j-dump.sh --apply
```

Expected outputs:

- `/mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/<stamp>/neo4j-<stamp>.dump`
- dump checksum sidecar
- `/mnt/pve/NAS/services/graphiti/config-snapshots/<stamp>/`
- `/mnt/pve/NAS/services/graphiti/manifests/neo4j-backup-<stamp>.manifest.json`

The backup is not production-complete until the corresponding restore test passes.

### 9.3 Dry-run restore test

```bash
cd /root/work/home-lab
services/graphiti/scripts/restore-test-neo4j.sh --dry-run \
  /mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/<stamp>/neo4j-<stamp>.dump
```

### 9.4 Approved restore test

```bash
cd /root/work/home-lab
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
  services/graphiti/scripts/restore-test-neo4j.sh --apply \
  /mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/<stamp>/neo4j-<stamp>.dump
```

Expected behavior:

- uses a disposable container and temporary local data path;
- does not call the production compose file;
- does not mount `/var/lib/graphiti`;
- captures node/relationship/constraint/index counts;
- writes sanitized evidence to `/mnt/pve/NAS/services/graphiti/restore-tests/<stamp>/restore-test-result.json`;
- records `production_data_touched: false`.

## 10. Live restore procedure and boundary

Live restore is destructive and is not used for routine verification. Use it only from a separate approved restore card after a successful restore test for the exact dump.

Required gates:

```bash
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved
GRAPHITI_RESTORE_TARGET=live-neo4j
GRAPHITI_RESTORE_PRE_SNAPSHOT_CONFIRMED=approved
```

Before live restore, record:

1. successful restore-test evidence for the exact dump;
2. filesystem snapshot/copy of current live data;
3. rollback decision for the pre-restore state;
4. planned service disruption window;
5. explicit approval for the destructive restore.

Never run `restore-neo4j-dump.sh --apply` merely to prove that backups work. That is the restore-test script's job.

## 11. Dashboard interpretation

The Home Dashboard has a Graphiti/Neo4j shared operational/provenance graph surface wired in a blocked/not-deployed state.

Current dashboard receipt:

- card id: `knowledge-graph`
- status check type: `graphitiNeo4jHealth`
- Graphiti state: `not_deployed`
- Neo4j state: `not_deployed`
- blocked narrative: live service is blocked on Vaultwarden/OpenRouter preflight
- public config hides internal probe URLs and credentials
- no public route was created

Verified dashboard test evidence from the dashboard handoff:

- config tests: `25/25 pass`
- status tests: `25/25 pass`
- full suite: `280/281 pass`, with one unrelated pre-existing investment-screener fixture failure
- bounded local server run on `PORT=4455` confirmed `/api/config/public` and `/api/status` did not leak credentials, unsafe URLs, or probe URLs

Interpretation:

- `not_deployed`: expected current state until the Vaultwarden/OpenRouter preflight, deploy, backup, and restore-test gates pass.
- `not_configured`: dashboard has no usable probe configuration.
- `degraded`: at least one component/probe is failing but the service is partially reachable.
- `down`: service probes are failing.
- `stale`: service may be reachable but freshness/backup/restore-test evidence is too old.
- `healthy`: service, Neo4j, backup evidence, restore-test evidence, and safety posture are all within policy.

Do not treat a container-running check alone as `healthy`.

## 12. Rollback and stop steps

For a routine stop of the deployed stack on tori:

```bash
ssh root@192.168.0.20
cd /opt/graphiti
docker compose down
```

For rollback after a failed deploy/update:

1. Stop the new stack with `docker compose down` from `/opt/graphiti`.
2. Preserve `/opt/graphiti/.env`, compose files, and logs locally for operator review, but do not commit secrets or sensitive logs.
3. Restore the previous reviewed compose/config snapshot if one exists.
4. Start only after confirming the restored `.env` still comes from Vaultwarden and the live data path is local disk.
5. Re-run loopback exposure and readiness checks.
6. Update receipts with the rollback reason and final state.

For data rollback after a bad graph write/import, prefer reviewed graph-level cleanup or restoring from a tested dump. Do not delete live Neo4j data directories manually. Do not run destructive restore without the live restore gates in section 10.

## 13. Known blocked prerequisites

Current blockers before production-ready:

1. Vaultwarden/BW access is locked for the worker/operator path used by this lane.
2. `deploy-tori-local.sh --preflight-only` has not been rerun with the current Vaultwarden-backed OpenRouter secret.
3. The live service has not been deployed on tori.
4. Neo4j readiness on tori has not been captured after deployment.
5. Graphiti ingest/query/provenance smoke evidence has not been captured.
6. No live backup has been taken.
7. No restore test has passed against a live dump.
8. Dashboard remains correctly `not_deployed` until those receipts exist.
9. The dashboard branch was committed locally by the worker but push was blocked by host Git credential state; do not assume remote GitHub has that dashboard receipt until push is confirmed.

## 14. Safety boundaries

Do not do any of the following without a separate reviewed task and explicit approval:

- expose raw Graphiti or Neo4j publicly;
- add a Cloudflare Tunnel route or public Traefik route;
- bind raw Graphiti/Neo4j ports to all interfaces;
- point agents directly at Graphiti write/delete/clear endpoints;
- allow arbitrary Cypher from agent/user input;
- move live Neo4j data to NAS/NFS/CIFS/FUSE;
- switch Hermes memory provider away from mem0;
- migrate or delete mem0 data;
- commit secrets, rendered `.env`, dumps, raw graph exports, raw transcripts, or sensitive logs;
- run destructive live restore without a successful restore test and all restore gates;
- delete old backup sets until a reviewed retention policy exists.

## 15. Receipt checklist before declaring production ready

Production-ready requires all of these current receipts:

- OpenRouter/Vaultwarden preflight passed from the deployment credential path.
- tori deployment applied from reviewed config.
- Neo4j live data confirmed on local disk.
- Graphiti API, Neo4j HTTP, and Neo4j Bolt confirmed loopback-only or otherwise reviewed.
- Graphiti/Neo4j readiness captured.
- sanitized ingest/query/provenance smoke test captured.
- backup manifest created under NAS Graphiti path.
- restore-test result created under NAS Graphiti path with `production_data_touched: false`.
- dashboard state updated from `not_deployed` to the correct live status without leaking secrets or internal probe URLs.
- non-secret receipts committed to Git.
