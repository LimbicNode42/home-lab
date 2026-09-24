# mem0 and MetaMCP outage handling - 2026-09-25

Status: MetaMCP recovered and verified healthy. mem0 remains degraded: read/search works, but write/add is blocked by the upstream LLM credential/quota path. This note is based on kanban parent handoffs for incident `t_bb702e0a`; it intentionally avoids secrets, raw memory contents, raw provider responses, and stack traces.

## Service locations and supervision

### mem0

- Placement: Docker Compose project `mem0` on `tori`.
- API binding: `127.0.0.1:8888` only; no LAN/WAN exposure.
- Containers: `mem0-mem0-1` and `mem0-postgres-1`.
- Supervision: Docker restart policy (`unless-stopped`) under the Compose deployment.
- Storage dependency: internal Postgres container on the Docker network.
- External dependency: chat-capable LLM provider access for fact extraction/write paths; embeddings remain separate.
- Dashboard surface: personal dashboard `mem0Health` status card and `/api/status` payload.

### MetaMCP

- Placement: Docker container `metamcp` on `tori`.
- Local gateway: `127.0.0.1:12008`.
- LAN path: `192.168.0.20:12008` via host-level relay/allowlist services; friendly mDNS name documented in `docs/metamcp-lan-exposure.md`.
- Containers: `metamcp`, `metamcp-pg`, and upstream `eodhd-mcp` on the MetaMCP Docker network.
- Supervision: Docker containers plus systemd-managed LAN relay, allowlist, and mDNS services.
- Dashboard surface: personal dashboard MetaMCP overview/status backed by a publisher snapshot plus live gateway health.

## Known incident result

### mem0

Observed state from triage: degraded, not fully down.

Evidence summarized by the triage worker:

- `/auth/setup-status` returned HTTP 200 via the container health path.
- `/docs` returned HTTP 200.
- Hermes `mem0_search` smoke check completed successfully.
- `mem0-postgres-1` was healthy.
- Write/add failed because the fact-extraction LLM call was rejected by the upstream provider quota/access path.

Do not describe this as a database outage unless new probes show DB failure. Current ground truth is: read/search path works; add/write path fails before completion because the upstream LLM write dependency is not usable.

### MetaMCP

Observed state from triage: recovered and healthy.

Evidence summarized by the triage worker:

- Root cause: upstream `eodhd-mcp` stopped responding over the HTTP/MCP path while its Docker healthcheck stayed green; after `eodhd-mcp` restarted, `metamcp` still retained stale upstream state.
- Applied remediation: restarted only `eodhd-mcp` and `metamcp`.
- Post-fix verification: MetaMCP `/health` returned HTTP 200; authenticated MCP initialize returned HTTP 200 with a session id; authenticated `tools/list` returned HTTP 200 with 89 tools including expected EODHD names; direct `eodhd-mcp` initialize/tools-list also responded.

## Health probes

Run read-only probes first. Use credentials from the approved local secret source only; never paste keys into notes, shell transcripts, comments, or committed docs.

### mem0 read-only probes

```bash
curl -fsS http://127.0.0.1:8888/auth/setup-status >/dev/null
curl -fsS http://127.0.0.1:8888/docs >/dev/null
curl -fsS http://127.0.0.1:8888/openapi.json >/dev/null
docker ps --filter 'name=mem0' --format 'table {{.Names}}\t{{.Status}}'
```

Hermes path smoke:

- Read/search: run a profile-scoped `mem0_search` for a harmless synthetic term. Do not dump memory contents.
- Write/add: after the LLM credential/quota issue is fixed, run a synthetic add/search/delete or add/update/delete smoke for a harmless marker and delete it immediately.

### mem0 dependency checks

```bash
docker inspect mem0-mem0-1 mem0-postgres-1 --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'
docker logs --since 30m mem0-mem0-1
```

When reporting log evidence, summarize only coarse signals such as `recent datastore error` or `upstream LLM quota/access failure`; do not copy raw stack traces or provider responses.

### MetaMCP read-only probes

```bash
curl -fsS http://127.0.0.1:12008/health >/dev/null
curl -fsS http://192.168.0.20:12008/health >/dev/null
systemctl is-active metamcp-lan-relay.service metamcp-lan-allowlist.service metamcp-mdns-alias.service
```

Authenticated MCP verification, using an API key without printing it:

- Initialize against `/metamcp/financial-data/mcp` and confirm HTTP 200 plus a session id.
- Call `tools/list` with the returned session id and confirm the expected EODHD tools are present.
- If MetaMCP is healthy but tools are missing or hanging, directly probe `eodhd-mcp` from the MetaMCP Docker network before restarting anything.

### MetaMCP dependency checks

```bash
docker inspect metamcp metamcp-pg eodhd-mcp --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'
docker logs --since 30m metamcp
docker logs --since 30m eodhd-mcp
```

Summarize failures by component (`gateway`, `registry snapshot`, `upstream eodhd-mcp`, `Postgres`) rather than dumping raw traces.

## Safe restart boundaries

Allowed only after read-only probes identify the affected component and the operator has approved any live mutation required by the current safety policy.

### mem0

- Do not restart the Hermes gateway to fix mem0.
- Do not mutate Hermes memory provider config during outage handling unless Ben explicitly approves that configuration change.
- Do not restart Postgres or recreate volumes for a write-path LLM quota/access failure.
- After a chat-capable mem0 LLM credential/model is provided or provider quota is reset, restart/recreate only `mem0-mem0-1` unless dependency checks show Postgres is also unhealthy.
- Verify with setup/docs/openapi, read/search smoke, and a synthetic write/add smoke that is immediately cleaned up.

### MetaMCP

- Preferred bounded recovery for the observed failure class: restart only `eodhd-mcp`, then restart only `metamcp` if the gateway retains stale upstream state.
- Do not restart unrelated Docker services, the Hermes gateway, Traefik, or host networking for an upstream-tool stall.
- Do not alter the LAN relay, allowlist, mDNS, or API-key boundary unless probes show that layer is the failure.
- Verify both service health and MCP behavior: `/health`, authenticated initialize, authenticated `tools/list`, expected EODHD tool count/names, and direct upstream response where relevant.

## Dashboard/status interpretation

### mem0

Dashboard source: `mem0Health` status card and `/api/status`.

Interpretation from the repaired dashboard lane:

- Healthy/up: setup/docs/openapi probes succeed, containers are healthy, read/search succeeds, and write/add succeeds.
- Degraded/stale: service is reachable but a dependency warning exists, such as recent datastore/log errors or write/add failing while read/search still works.
- Down: API liveness, Postgres/container health, or authenticated read/search fails.
- Current incident state: `degraded`, with a safe summary equivalent to: docs reachable, OpenAPI reachable, containers healthy, recent datastore/log error signal present.
- Freshness: status payload must include freshness metadata; absence or stale status should be treated as a dashboard/status problem, not proof that mem0 is healthy.

The public payload must not expose API keys, raw memory contents, provider responses, stack traces, or host-local paths.

### MetaMCP

Dashboard source: MetaMCP overview/status API backed by live gateway health plus the publisher snapshot named by `METAMCP_STATUS_FILE`.

Interpretation from the repaired dashboard lane:

- Healthy: gateway health is healthy, snapshot cache is fresh, registry counts are present, and unhealthy server count is zero.
- Degraded: `/health` is HTTP 200 but authenticated tools/list hangs, returns zero or unexpected tools, the upstream direct probe fails, or the publisher snapshot is stale/missing.
- Down: `/health` fails or the `metamcp` container is not running.
- Stale: `cacheStatus`/freshness marks the publisher snapshot stale even if live gateway health is OK; treat this as incomplete observability until the publisher is refreshed.
- Current incident state after recovery: `healthy`, `cacheStatus: fresh`, `freshness_stale: false`, registry counts included 2 namespaces, 7 servers, and 0 unhealthy servers.

The dashboard should show counts and safe component summaries only. It must not expose API keys, raw stack traces, sensitive endpoint config, or local filesystem paths.

## Remaining gap / human action

mem0 write/add recovery needs one human-controlled input: provide or rotate a chat-capable mem0 LLM credential/model, or reset/raise the OpenRouter quota used by mem0. After that, the bounded service action is to restart/recreate only the mem0 API container and verify synthetic write/add through both the mem0 API path and the Hermes mem0 tool path.

MetaMCP has no remaining outage gap from this incident. Keep the upstream `eodhd-mcp` direct probe in the runbook because its Docker healthcheck can be green while the HTTP/MCP path is not useful. Healthchecks: occasionally decorative; probes are where the bodies are buried.
