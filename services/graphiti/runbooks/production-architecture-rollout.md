# Graphiti + Neo4j production architecture and rollout spec

Status: production rollout specification for the shared operational/provenance graph layer. This document is not an approval to deploy by itself; live service changes still require the gated implementation/review tasks.

Related evidence:

- Final recommendation artifact: `/root/.hermes/kanban/attachments/t_0a509175/GRAPHITI_NEO4J_FINAL_RECOMMENDATION.md`
- Spike report: `/root/.hermes/kanban/attachments/t_6296cbe7/SPIKE_REPORT.md`
- Prior scaffold task: `t_26187ddc`, local commit `32e61e654a8a399155c919069635b5aadea97d11`
- Dashboard status-card task lineage: `t_072cdf31` and follow-up dashboard deployment lanes

## 1. Production decision

Deploy Graphiti + Neo4j as an optional shared operational/provenance knowledge graph for Hermes agents and homelab operations.

Do not replace mem0. mem0 remains the active personal/preference memory provider unless Ben explicitly approves a later provider change. Graphiti is an adjacent evidence layer for source-backed operational facts, temporal/supersession history, and cross-agent provenance.

Production posture:

- host: `tori` (`192.168.0.20`) first
- public exposure: none
- Graphiti API exposure: loopback first; LAN only if protected by an authenticated read-only wrapper
- Neo4j exposure: no public browser or Bolt; loopback/LAN-admin only after review
- live database storage: tori-local disk, not NAS/NFS
- NAS usage: dumps, config snapshots, backup manifests, and restore-test evidence only
- agent access: read-only query wrapper returning provenance/caveats; no raw write, delete, or clear endpoints

This is deliberately boring. Boring services are easier to restore at 02:00, which is when services like to express themselves.

## 2. Existing scaffold reconciliation

The prior scaffold task `t_26187ddc` produced commit `32e61e654a8a399155c919069635b5aadea97d11` with the following non-secret service scaffold:

- `services/graphiti/.env.example`
- `services/graphiti/docker-compose.candidate.yml`
- `services/graphiti/config/vaultwarden-map.example.yml`
- `services/graphiti/scripts/openrouter-guardrail-preflight.py`
- `services/graphiti/scripts/backup-neo4j-dump.sh`
- `services/graphiti/scripts/restore-neo4j-dump.sh`
- `services/graphiti/scripts/restore-test-neo4j.sh`
- `services/graphiti/runbooks/backup-restore.md`
- `services/graphiti/runbooks/dashboard-status-design.md`
- `services/graphiti/runbooks/deploy-read-only-service.md`
- `services/graphiti/runbooks/read-only-agent-wrapper.md`

That scaffold aligns with the final recommendation and is promoted here as the baseline production candidate, with these reconciliations:

1. The service is no longer merely a spike follow-up; it is the production candidate, still behind implementation/review gates.
2. The `guardrail-preflight-result.json` is historical evidence only. The infra task must re-run the preflight using the current deployment credential path before deployment.
3. `docker-compose.candidate.yml` remains a candidate template, not a live desired-state apply file, until tori container startup and storage paths are verified.
4. Backup and restore scripts remain draft/gated scripts until the infra task validates them on tori and captures restore-test evidence.
5. Dashboard status work must represent verified service health, query freshness, backup age, and restore-test age; a container-running check alone is not production health.

## 3. System boundaries

### mem0: personal/preference memory

mem0 remains authoritative for:

- Ben's durable preferences and personal facts
- stable profile-level operating context injected into sessions
- personal assistant behavior conventions
- low-latency memory-provider recall used by Hermes today

No Graphiti rollout task may switch Hermes `memory_provider` away from mem0, change mem0 service config, migrate mem0 records, or delete mem0 data.

### Session search: transcript retrieval

Hermes session search remains the place to retrieve raw or near-raw conversation history. Graphiti should not ingest bulk raw transcripts by default.

Allowed use is curated episode extraction from selected transcripts or Kanban handoffs after redaction and review. Session search remains the source to inspect the original transcript when needed.

### Graphiti/Neo4j: temporal provenance graph

Graphiti stores curated operational/provenance episodes and derived facts where source, time, supersession, dependency, and caveat matter.

Initial domains:

- `homelab`: service topology, host dependencies, incidents, backup/restore facts
- `agents`: profile capabilities, task ownership, cross-agent execution decisions
- `services`: service lifecycle notes, routes, runtime dependencies, owner/runbook pointers
- `incidents`: symptom, evidence, remediation, rollback, residual risk
- `decisions`: architecture choices, superseded paths, explicit approvals/deferrals

Graphiti output is advisory context. Agents must still verify current live system state before remediation.

## 4. Deployment architecture

### Runtime layout

Use these target paths unless the infra task discovers a tori-specific blocker:

```text
/opt/graphiti/
  docker-compose.yml              # rendered/reviewed runtime compose, not committed with secrets
  .env                            # rendered from Vaultwarden, mode 0600, never Git
  config-snapshots/               # optional local staging before NAS copy

/var/lib/graphiti/neo4j/data/      # live Neo4j database, tori-local disk
/var/lib/graphiti/neo4j/logs/      # local logs if not container-managed

/mnt/pve/NAS/services/graphiti/
  backups/neo4j-dumps/
  config-snapshots/
  restore-tests/
  manifests/
```

Hard rule: do not place Neo4j live `/data` on NAS/NFS unless Ben explicitly approves a later exception after a written risk note. Dumps on NAS are fine; a live graph database on NFS is how storage gremlins get tenure.

### Container shape

Expected components:

- `neo4j`
  - image: `neo4j:5.26.2` or a reviewed pinned digest after tori verification
  - bind-mounted live data on tori-local disk
  - browser/Bolt bound to loopback unless LAN-admin access is explicitly reviewed
- `graphiti-api`
  - image/version pinned after implementation verifies the chosen upstream image
  - depends on Neo4j readiness
  - reads OpenRouter and Neo4j config from rendered runtime env
  - loopback-only by default
- optional `graphiti-readonly-wrapper`
  - the only agent-facing interface
  - exposes query-only operations and strips/deserializes raw Graphiti responses into provenance-safe schema
  - blocks `/clear`, `DELETE`, mutation endpoints, and arbitrary Cypher

### Network and auth boundary

Default binds:

```text
Graphiti API: 127.0.0.1:8000
Neo4j HTTP:   127.0.0.1:7474
Neo4j Bolt:   127.0.0.1:7687
Wrapper:      127.0.0.1 first; reviewed LAN bind only if needed
```

Do not create a Cloudflare Tunnel route, public Traefik route, or raw agent tool pointed at upstream Graphiti.

If cross-host agents need access, implement the wrapper first and gate it with a non-secret auth design using Vaultwarden-referenced service token material. Dashboard output must not include tokens, local filesystem paths, raw query text, logs, or graph dumps.

### Neo4j browser operator access

Recommendation: keep Neo4j HTTP and Bolt loopback-only on `tori` and use a short-lived SSH tunnel when Ben needs the Neo4j browser. This preserves the reviewed no-public/no-LAN raw Neo4j exposure posture while still giving an operator a browser UI.

From the workstation where the browser will run:

```bash
ssh -N -L 7474:127.0.0.1:7474 root@192.168.0.20
```

Then open `http://127.0.0.1:7474`. The Home Dashboard Neo4j card may link to that loopback URL; it only works on a machine where the tunnel is already running. The dashboard/runbooks must not embed Neo4j usernames, passwords, Bolt credentials, query strings, fragments, or tokenized URLs. Neo4j's browser login prompt supplies credentials from the operator's approved secret source.

Do not bind Neo4j HTTP or Bolt to `192.168.0.20`, the LAN, Traefik, or Cloudflare without a separate reviewed change and Ben's explicit approval for the exact bind/port/exposure scope.

## 5. Secrets and configuration

Vaultwarden remains the secrets reference model:

```text
server: http://192.168.0.50:8084
folder: homelab

item: graphiti/openrouter
  api_key
  base_url
  completion_model
  embedding_model
  embedding_dim

item: graphiti/neo4j
  username
  password
  uri
  browser_url

item: graphiti/service-auth
  api_token
```

Git may contain only:

- item and field names
- `.env.example` placeholders
- render maps
- runbooks
- non-secret manifests
- sanitized guardrail/health results

Git must not contain API keys, Neo4j passwords, rendered `.env`, dumps, raw graph data, raw transcripts, dashboard internals with secrets, or token-bearing logs.

## 6. Failure and degradation behavior

Graphiti must be optional. If unavailable:

1. Hermes continues using mem0, session search, source files, and live inspection.
2. Agent wrappers return a clear `graph_unavailable`/`graph_stale` status rather than blocking unrelated tasks.
3. Dashboard shows degraded/down/stale status with latest verified backup and restore-test ages.
4. No homelab recovery, Proxmox quorum, Vaultwarden, NAS startup, or critical service startup path may depend on Graphiti.

Temporal invalidation is advisory until reviewed. A result with `invalid_at` should be presented with provenance and caveat, not treated as operational truth by itself.

## 7. Production acceptance gates

The infra implementation task may call the service production-ready only after all gates below have receipts.

### Gate 1: OpenRouter guardrail preflight

Run `services/graphiti/scripts/openrouter-guardrail-preflight.py` from the deployment credential path and verify:

- base URL: `https://openrouter.ai/api/v1`
- completion/reranker/small model: `openai/gpt-4o-mini`
- embedding model: `openai/text-embedding-3-small`
- embedding dimension observed: `1536`
- no API key or secret appears in output, logs, comments, dashboard JSON, or committed files

Historical scaffold evidence showed these exact models available on 2026-09-21, but that result is not current-state proof.

### Gate 2: Neo4j target-host startup

On tori, verify the selected Neo4j image starts with local disk data paths.

Required receipts:

- image name and immutable digest or exact version
- data path is local disk, not NAS/NFS
- Neo4j readiness succeeds
- logs show no FileDispatcher/permission failure like the earlier non-target spike environment
- browser/Bolt are not publicly exposed

If the container image fails on tori, document exact logs and either block for decision or use a reviewed alternative. Do not silently pivot to unsafe storage or public exposure.

### Gate 3: Graphiti API startup

Verify:

- Graphiti API starts against Neo4j
- `/healthcheck` or equivalent health endpoint succeeds from allowed bind scope
- no destructive raw endpoints are agent-facing
- service config is rendered from Vaultwarden references, not committed secrets

### Gate 4: Ingest/query/provenance smoke

Using explicitly disposable sanitized test data only:

- ingest a tiny production-shaped episode with a unique test group
- query through the intended read-only path
- verify response includes fact, source episode/title, source timestamp, group/domain, and caveat/validity fields when available
- verify mutation/delete/clear operations are unavailable from the agent-facing path

This gate is what prevents “container is running” theater. We have enough theater. The costumes are terrible.

### Gate 5: Backup

Before agent-facing use, produce a Neo4j backup/dump and non-secret manifest containing:

- dump filename/checksum/size
- created timestamp
- source image/version/digest
- node/relationship counts
- latest episode timestamp/group summary
- script version or commit
- backup exit code

Store dump/evidence under the NAS Graphiti backup path, not live DB storage.

### Gate 6: Restore test

Run an isolated restore test and verify:

- restored Neo4j starts
- counts match the manifest within expected delta
- indexes/constraints exist or are rebuilt safely
- a representative group query returns expected fact plus source episode
- restore-test evidence is written under NAS restore-test path

### Gate 7: Dashboard healthy/fresh status

Home Dashboard Overview can show healthy only when it verifies more than process liveness:

- Graphiti/wrapper health
- Neo4j readiness
- latest curated episode/fact timestamp per group or summary
- latest backup age and last exit code
- latest restore-test age
- unsafe exposure check is passing or not applicable

If Graphiti is not deployed, the dashboard should show `not_deployed`/hidden-not-healthy rather than pretending.

## 8. Implementation order

1. Re-run scaffold validation in the active repo/worktree and resolve drift from `t_26187ddc`.
2. Confirm Vaultwarden item references exist; create missing item shells only if the implementation task has approval and without storing values in Git.
3. Run OpenRouter guardrail preflight using deployment credential path.
4. Verify tori runtime prerequisites: Docker/container runtime, local disk path, NAS backup path reachability, and port availability.
5. Start Neo4j only with local disk data and loopback/LAN-reviewed binds; capture digest/log/readiness receipts.
6. Start Graphiti API only after Neo4j readiness; keep loopback by default.
7. Run disposable ingest/query/provenance smoke.
8. Implement/readiness-test read-only wrapper before any agent-facing access.
9. Run backup and restore-test automation; capture manifests/evidence.
10. Add/enable Home Dashboard status using the real service and restore-test evidence.
11. Hand to review before any broader automation or ingest expansion.

## 9. Blockers and escalation points

Block rather than guess if any of these occur:

- OpenRouter key/model guardrails reject `openai/gpt-4o-mini` or `openai/text-embedding-3-small`
- Vaultwarden access is missing or item references cannot be resolved
- tori cannot run the selected Neo4j container safely on local disk
- implementation requires binding Graphiti/Neo4j beyond loopback/LAN-reviewed scope
- any live mutation would expose public routes, alter Hermes memory-provider config, rotate secrets, delete data, or clear non-disposable graph data
- backup/restore-test cannot be made to pass before agent-facing use

## 10. Downstream task handoff

### Infra task (`t_5a650bed` / kobold)

Use this spec plus the scaffold as the implementation contract. The infra task owns tori deployment verification, service config finalization, backup/restore automation, and receipts. It must not mark production ready until all acceptance gates pass or it blocks on a specific human prerequisite.

### Ingest policy task (`t_87852d3e` / scribe)

Policy artifact: `services/graphiti/runbooks/curated-ingest-policy.md`.

Define the curation policy before broad automation: allowed sources, prohibited data classes, redaction checklist, grouping, temporal invalidation review, OpenRouter spend controls, and initial seed set. The wrapper/ingest automation should not expand beyond disposable/manual seed data until this policy exists and is used as an enforcement contract.

### Wrapper/review/dashboard tasks

The read-only wrapper must enforce no destructive endpoints and return provenance/caveats. Review should verify safety boundaries before deploy broadens access. Dashboard work should show real health/freshness/backup/restore state, not decorative optimism.
