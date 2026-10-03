# Graphiti + Neo4j production runbook

Last updated: 2026-10-02T11:23:47Z

Status: deployed and production-smoke verified on `tori` (`192.168.0.20`). Graphiti API and Neo4j are healthy, loopback-only, backed by local Neo4j live data, and have a verified on-demand NAS backup plus disposable restore-test receipt. This service is a shared operational/provenance graph for Hermes homelab work. It does not replace mem0.

## 1. Purpose and scope

Graphiti + Neo4j stores curated, source-backed operational episodes and temporal facts for homelab work: service topology, task handoffs, incident timelines, backup/restore evidence, dependency notes, caveats, and supersession history.

mem0 remains the active personal/preference memory provider for Ben's durable preferences, personal facts, and assistant behavior context. This deployment does not switch Hermes away from mem0, migrate mem0 records, delete mem0 data, or make recovery depend on Graphiti.

Session search remains the right tool for recalling prior Hermes conversations and locating past discussion context. Graphiti is for curated shared operational/provenance facts, not raw transcript recall.

Graphiti output is advisory context with provenance. Operators and agents must still verify current live state from the original system before remediation. The graph can point at evidence; it is not the source of truth by royal YAML decree.

Agent-facing usage guidance lives in `services/graphiti/runbooks/agent-usage-guide.md`. It covers when to use mem0 vs session search vs Graphiti, safe wrapper queries, provenance interpretation, curated ingest boundaries, dashboard fields, degraded/down fallback, backup/restore boundaries, and upgrade notes.

## 2. What is deployed

Live host and services:

```text
host:             tori / 192.168.0.20
runtime root:     /opt/graphiti
Graphiti API:     graphiti-api, 127.0.0.1:8000 only
Neo4j HTTP:       graphiti-neo4j, 127.0.0.1:7474 only
Neo4j Bolt:       graphiti-neo4j, 127.0.0.1:7687 only
Neo4j image:      neo4j:5.26.2
Graphiti image:   zepai/graphiti@sha256:21818c8a8e3b0513fe167370527fec32ed117e98bcc3423f9eb3bc6c73
```

The deployed Graphiti API includes a reviewed tori-local bind-mounted patch:

```text
/opt/graphiti/patches/ingest.py -> /app/graph_service/routers/ingest.py (read-only)
```

That patch works around the pinned `zepai/graphiti:0.30.2` async ingest bug by processing the reviewed curated `/episodes` path synchronously. The service still contains upstream raw destructive routes internally, so agents must not talk to raw Graphiti directly.

Repository evidence:

- `services/graphiti/receipts/2026-10-02-bounded-deploy-remediation.json`
- `services/graphiti/receipts/2026-10-02-production-smoke-backup.json`
- `services/graphiti/docker-compose.tori.yml`
- `services/graphiti/patches/ingest.py`
- `services/graphiti/agent_graphiti/`
- `services/graphiti/scripts/graphiti-agent-wrapper.py`
- `services/graphiti/scripts/graphiti-mcp-server.py`
- `services/graphiti/runbooks/mcp-server-access.md`

## 3. Network exposure and access posture

Intended exposure:

- No public Graphiti route.
- No public Neo4j route.
- No Cloudflare Tunnel route for raw Graphiti or Neo4j.
- No public Traefik route for raw Graphiti or Neo4j.
- Raw ports are bound to tori loopback only.
- Agent access must go through the reviewed wrapper/tool path, not raw write/delete/clear endpoints.

Verified exposure evidence from the production smoke receipt:

- `GET http://127.0.0.1:8000/healthcheck` from tori returned healthy.
- `cypher-shell RETURN 1 AS ok` returned `ok=1`.
- Worker LAN attempts to reach `http://192.168.0.20:8000/healthcheck` and `POST http://192.168.0.20:8000/clear` were refused.
- The raw destructive endpoint was not agent-facing.

## 4. Data and backup layout

Live data stays local to tori:

```text
/opt/graphiti/
  docker-compose.yml              # reviewed runtime compose; rendered/deployed, may reference local secrets
  .env                            # rendered from Vaultwarden; mode 0600; never committed
  patches/ingest.py               # reviewed non-secret tori-local patch

/var/lib/graphiti/neo4j/data/      # live Neo4j database on tori-local ext4 /dev/sda2
/var/lib/graphiti/neo4j/logs/      # Neo4j logs
```

NAS is evidence/backup storage only:

```text
/mnt/pve/NAS/services/graphiti/
  backups/neo4j-dumps/<stamp>/
  config-snapshots/<stamp>/
  restore-tests/<stamp>/
  manifests/neo4j-backup-<stamp>.manifest.json
  status/latest-smoke-backup.json
```

Hard rule: do not place live Neo4j `/data` on NAS, NFS, CIFS, or FUSE storage unless Ben explicitly approves a later exception with a written risk note. The verified live data path is `/var/lib/graphiti/neo4j/data` on ext4 from `/dev/sda2`.

## 5. Secret references and Vaultwarden/BW usage

Vaultwarden is the homelab secret reference model. Git stores only item names, field names, placeholders, render maps, and non-secret receipts.

Vaultwarden location/reference shape:

```text
server: http://192.168.0.50:8084
folder: Homelab
item: graphiti/openrouter
item: graphiti/neo4j
item: graphiti/service-auth          # reserved for later reviewed wrapper auth, if used
```

Required secret/config fields are represented by placeholders in Git only:

```text
graphiti/openrouter:
  OPENROUTER_API_KEY
  base_url=https://openrouter.ai/api/v1
  completion_model=openai/gpt-4o-mini
  embedding_model=openai/text-embedding-3-small
  embedding_dim=1536

graphiti/neo4j:
  username
  password
  uri
  browser_url
```

Secret handling rules:

- Never commit rendered `.env` files.
- Never paste API keys, Neo4j passwords, `BW_SESSION`, `BW_PASSWORD`, dumps, raw graph data, raw transcripts, or token-bearing logs into Git, Kanban comments, dashboard JSON, or docs.
- Use the reviewed repo secret-rendering helpers and Bitwarden session handling; do not pass master passwords on command lines.
- Runtime secret files on tori must remain mode `0600`.

## 6. Model/config shape

Verified OpenRouter/Graphiti model posture:

```text
OpenRouter base URL:       https://openrouter.ai/api/v1
completion/reranker model: openai/gpt-4o-mini
embedding model:           openai/text-embedding-3-small
embedding dimension:       1536
```

Deployment helper and wrapper files:

- `services/graphiti/scripts/deploy-tori-local.sh`
- `services/graphiti/scripts/openrouter-guardrail-preflight.py`
- `services/graphiti/graphiti.env.map.example`
- `services/graphiti/config/vaultwarden-map.example.yml`
- `services/graphiti/agent_graphiti/client.py`

## 7. Health checks

Run health checks from tori or through SSH to tori. Do not expose raw ports to make these easier.

```bash
ssh root@192.168.0.20 'cd /opt/graphiti && docker compose ps'
ssh root@192.168.0.20 'curl -fsS http://127.0.0.1:8000/healthcheck'
ssh root@192.168.0.20 'docker exec graphiti-neo4j /var/lib/neo4j/bin/cypher-shell -a bolt://127.0.0.1:7687 -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" "RETURN 1 AS ok;"'
ssh root@192.168.0.20 'findmnt -T /var/lib/graphiti/neo4j/data'
ssh root@192.168.0.20 "ss -ltnp | grep -E ':(7474|7687|8000)\\b' || true"
```

Expected state:

- `graphiti-api` healthy.
- `graphiti-neo4j` healthy.
- `/healthcheck` returns `{"status":"healthy"}`.
- Cypher readiness returns `ok=1`.
- `8000`, `7474`, and `7687` are loopback-only.
- live data is local ext4, not NAS/NFS/CIFS/FUSE.

A convenience exposure check exists:

```bash
cd /root/work/home-lab
GRAPHITI_VERIFY_HOST=root@192.168.0.20 \
  services/graphiti/scripts/verify-loopback-exposure.sh \
  /tmp/graphiti-listen-scope-after-deploy.txt
```

- `services/graphiti/scripts/publish-graphiti-status.sh` refreshes the Graphiti/Neo4j backend snapshot for the Home Dashboard.
- `services/graphiti/scripts/publish-graphiti-mcp-status.sh` refreshes the separate Graphiti MCP access snapshot after a real MCP client `list_tools`/tool-call smoke.

Record sanitized results under `services/graphiti/receipts/`; do not commit secrets or raw graph dumps.

## 8. Safe ingest/query smoke

Use sanitized, synthetic operational facts and a unique smoke-test group. Do not ingest credentials, raw Hermes transcripts, sensitive incident logs, or personally sensitive data.

### Vector index (required — do not skip)

graphiti-core 0.30.2 does NOT create a VECTOR index on `fact_embedding` (its `build_indices_and_constraints()` only creates RANGE + FULLTEXT indexes). Without the vector index, `vector.similarity.cosine` runs brute-force and `/search` can intermittently hang. Apply the index after every fresh deploy and after a live restore (the dump does not carry indexes):

```bash
cd /root/work/home-lab
NEO4J_USER=neo4j NEO4J_PASSWORD=<runtime-secret> \
  services/graphiti/scripts/ensure-vector-index.sh          # idempotent, verified
NEO4J_USER=neo4j NEO4J_PASSWORD=<runtime-secret> \
  services/graphiti/scripts/ensure-vector-index.sh --dry-run  # read-only plan
```

The index (`fact_embedding_vector`, VECTOR, RELATIONSHIP on `RELATES_TO.fact_embedding`, 1536-dim cosine) must show `ONLINE` / `populationPercent 100.0`.

Production smoke evidence from `t_8a57f068`:

```text
group_id:       services_graphiti_prod_smoke_20261002_102356
source_ref:     kanban:t_8a57f068:20261002T102356Z
ingest:         POST /episodes -> HTTP 201, success=true
query:          POST /search -> HTTP 200, result_count=1
sample fact:    Graphiti production smoke t_8a57f068 confirms curated operational provenance ingest on tori-local.
provenance:     created_at and valid_at timestamps returned
```

Wrapper degradation was also verified by pointing the local wrapper at an unavailable base URL. It returned `graph_unavailable` with an explicit caveat directing agents back to mem0, session history, source-of-truth documents, and live inspection.

For future smokes, prefer the reviewed wrapper/curated ingest path in `services/graphiti/scripts/graphiti-agent-wrapper.py` and `services/graphiti/agent_graphiti/`. Keep groups scoped and source references explicit.

## 9. Backup and restore-test procedure

Neo4j Community dumps are offline dumps. The approved method may stop/restart Graphiti/Neo4j through Docker Compose, so run it in an approved maintenance window.

Dry-run backup plan:

```bash
cd /root/work/home-lab
services/graphiti/scripts/backup-neo4j-dump.sh --dry-run
```

Approved backup:

```bash
cd /root/work/home-lab
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
GRAPHITI_BACKUP_ALLOW_SERVICE_STOP=approved \
  services/graphiti/scripts/backup-neo4j-dump.sh --apply
```

Verified production backup evidence:

```text
timestamp:          2026-10-02T10:36:58Z
method:             offline Neo4j dump to tori local staging, host-side copy to NAS
NAS dump:           /mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/20261002T103658Z/neo4j-20261002T103658Z.dump
sha256:             c279fed0b2973d83debf068b31b7dbefc248c8fc0788f6f4a61be60beebdaddc
size:               74127 bytes
manifest:           /mnt/pve/NAS/services/graphiti/manifests/neo4j-backup-20261002T103658Z.manifest.json
config snapshot:    /mnt/pve/NAS/services/graphiti/config-snapshots/20261002T103658Z
restore evidence:   /mnt/pve/NAS/services/graphiti/restore-tests/20261002T103658Z/restore-test-result.json
```

The host-side NAS copy is intentional. It avoids the known stale-NFS bind-mount failure class seen when Docker containers bind-mount the NAS path directly.

Dry-run restore test:

```bash
cd /root/work/home-lab
services/graphiti/scripts/restore-test-neo4j.sh --dry-run \
  /mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/<stamp>/neo4j-<stamp>.dump
```

Approved restore test:

```bash
cd /root/work/home-lab
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
  services/graphiti/scripts/restore-test-neo4j.sh --apply \
  /mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/<stamp>/neo4j-<stamp>.dump
```

Verified restore-test result:

```text
status:                         passed
target:                         disposable Neo4j container
production data path mounted:   false
nodes:                          3
relationships:                  3
constraints:                    0
indexes:                        33
NAS copy validated by sha256:   true
```

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

Never run `restore-neo4j-dump.sh --apply` merely to prove backups work. Use the restore-test script for verification.

## 11. Dashboard interpretation

The Home Dashboard Overview now distinguishes Graphiti/Neo4j shared operational/provenance memory from mem0 personal/preference memory.

Dashboard handoff evidence:

- Graphiti card: healthy from latest sanitized production smoke/backup snapshot; includes healthcheck, ingest, query, source reference, result count, and freshness.
- Neo4j card: healthy from latest sanitized production smoke/backup snapshot; includes readiness, backup, restore-test, size, local-disk filesystem, and freshness.
- Stale policy: `86400000` ms.
- Runtime snapshots:
  - `/mnt/nas/services/graphiti/status/latest-smoke-backup.json`
  - `/mnt/pve/NAS/services/graphiti/status/latest-smoke-backup.json`

Verified dashboard safety:

- no raw artifact paths in public config;
- no credentials or API keys;
- no internal probe URLs exposed through public config;
- no destructive Graphiti/Neo4j links exposed;
- live authenticated `/api/status` showed fresh Graphiti and Neo4j evidence with `stale=false`.

Interpretation:

- `healthy`: service, Neo4j, ingest/query, backup evidence, restore-test evidence, and safety posture are all within policy.
- `stale`: evidence is too old; inspect service and backup freshness before trusting the graph.
- `degraded`: at least one component/probe is failing but the service is partially reachable.
- `down`: service probes are failing.
- `not_configured`: dashboard has no usable Graphiti/Neo4j status snapshot.

Do not treat a container-running check alone as healthy. Container theater remains theater, even when Docker gives it a nice table.

## 12. Rollback and stop steps

Routine stop:

```bash
ssh root@192.168.0.20
cd /opt/graphiti
docker compose down
```

Rollback after a failed Graphiti API update:

1. Stop only the API first where practical: `cd /opt/graphiti && docker compose stop graphiti-api`.
2. Restore the previous `/opt/graphiti/docker-compose.yml` from `/opt/graphiti/backups/docker-compose.yml.<stamp>` or remove the ingest patch bind mount.
3. Remove or ignore `/opt/graphiti/patches/ingest.py` after compose rollback; it contains no secrets.
4. Start the API again: `cd /opt/graphiti && docker compose up -d graphiti-api`.
5. Verify `/healthcheck`, loopback listeners, and wrapper degraded/query behavior.
6. Preserve `/var/lib/graphiti/neo4j/data` unless a separately approved restore is underway.

Rollback after a bad graph write/import:

- Prefer reviewed graph-level cleanup for scoped disposable groups.
- For broader corruption, restore from a tested dump only under the live restore gates in section 10.
- Do not manually delete live Neo4j data directories.

## 13. Known limitations and residual risks

- The deployed service uses a tori-local bind-mounted patch over the pinned upstream Graphiti image. It is reviewed and bounded, but it is still a local operational patch until upstream behavior is corrected or a later reviewed image replaces it.
- The raw upstream Graphiti API still contains destructive endpoints internally. Safety currently depends on loopback-only binding and agents using the wrapper path instead of raw endpoints.
- Backup/restore evidence is verified on demand. Recurring backup scheduling and alerting must remain visible through dashboard/status/reporting work; if freshness goes stale, treat it as an operator action item.
- NAS/NFS stale-handle history remains a platform risk. The current backup path avoids Docker bind-mounting NAS into backup/restore containers and uses host-side copy instead.
- Graphiti is advisory operational memory, not live state. Before remediation, inspect the actual host/service/source-of-truth.
- mem0 remains active for personal/preference memory; do not assume Graphiti contains Ben's preferences or replaces persistent assistant memory.

## 14. Safety boundaries

Do not do any of the following without a separate reviewed task and explicit approval:

- expose raw Graphiti or Neo4j publicly;
- add a Cloudflare Tunnel route or public Traefik route for raw Graphiti/Neo4j;
- bind raw Graphiti/Neo4j ports to all interfaces;
- point agents directly at Graphiti write/delete/clear endpoints;
- allow arbitrary Cypher from agent/user input;
- move live Neo4j data to NAS/NFS/CIFS/FUSE;
- switch Hermes memory provider away from mem0;
- migrate or delete mem0 data;
- commit secrets, rendered `.env`, dumps, raw graph exports, raw transcripts, or sensitive logs;
- run destructive live restore without a successful restore test and all restore gates;
- delete old backup sets until a reviewed retention policy exists.

## 15. Production receipt checklist

Current production receipts are satisfied by the 2026-10-02 handoffs:

- OpenRouter/Vaultwarden path and model shape verified during deploy/remediation.
- tori deployment applied from reviewed config.
- Graphiti API and Neo4j are healthy.
- Neo4j live data confirmed on local ext4 disk.
- Graphiti API, Neo4j HTTP, and Neo4j Bolt confirmed loopback-only.
- Sanitized ingest/query/provenance smoke passed.
- Wrapper degraded behavior passed.
- NAS backup manifest/dump/config snapshot created.
- Disposable restore-test passed with `production_data_touched=false` behavior.
- Dashboard status surface shows fresh sanitized evidence and keeps mem0 distinct.
- Non-secret receipts committed to Git.
