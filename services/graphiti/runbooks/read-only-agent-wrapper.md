# Read-only agent wrapper contract

Agents must not receive raw Graphiti write/delete/clear access. This directory now includes a concrete Python wrapper and curated-ingest validator under `services/graphiti/agent_graphiti/`, with the executable entrypoint:

```bash
services/graphiti/scripts/graphiti-agent-wrapper.py status
services/graphiti/scripts/graphiti-agent-wrapper.py query "graphiti policy" --group-id services.graphiti --limit 5
services/graphiti/scripts/graphiti-agent-wrapper.py validate-ingest services/graphiti/seeds/initial-approved-episodes.json
services/graphiti/scripts/graphiti-agent-wrapper.py ingest services/graphiti/seeds/initial-approved-episodes.json       # dry-run default
services/graphiti/scripts/graphiti-agent-wrapper.py ingest services/graphiti/seeds/initial-approved-episodes.json --apply # live curated ingest
```

Default endpoint posture is loopback-only:

- `GRAPHITI_API_URL=http://127.0.0.1:8000`
- `GRAPHITI_SEARCH_PATH=/search`
- `GRAPHITI_HEALTH_PATH=/healthcheck`
- `GRAPHITI_INGEST_PATH=/episodes`

The wrapper is not a Hermes memory provider and must not switch Hermes away from mem0. Graphiti remains advisory operational/provenance context.

## Allowed operations

Agent-facing query consumers may use only:

- `status()` / CLI `status`
- `search_facts(query, group_id?, limit?)` / CLI `query`

Curated ingest is operator-controlled and policy-gated:

- `validate-ingest <episode-file>` validates allowlisted source classes, required provenance, redaction flags, date fields, group/domain shape, and secret-blocking checks without contacting Graphiti.
- `ingest <episode-file>` is dry-run by default and returns sanitized receipts.
- `ingest <episode-file> --apply` calls only the configured Graphiti ingest endpoint after validation.

## Required response shape

Each fact returned to an agent includes provenance and caveats in this normalized shape:

```json
{
  "fact": "string",
  "source_episode": "string or null",
  "source_ref": "task id, doc path, or source reference",
  "source_timestamp": "ISO-8601 or null",
  "valid_at": "ISO-8601 or null",
  "invalid_at": "ISO-8601 or null",
  "confidence": "low|medium|high|unknown",
  "caveat": "string or null",
  "group": "services.graphiti",
  "domain": "services",
  "status": "ok"
}
```

If Graphiti is unavailable, the query path returns a safe degradation object instead of blocking unrelated work:

```json
{
  "status": "graph_unavailable",
  "results": [],
  "caveat": "Graphiti is unavailable; use mem0/session/source-of-truth/live inspection instead."
}
```

## Prohibited operations

Do not expose direct agent tools for:

- `POST /clear`
- deleting groups
- deleting episodes
- deleting edges
- arbitrary Cypher writes
- raw graph dumps
- raw transcript/session ingest
- automated broad ingest from logs or private memories

The client constructor rejects mutation-shaped read paths such as `/clear`, and the query method rejects mutation-shaped query text. This is guardrail code, not a legal shield. Do not point agents at raw Graphiti.

## Curated seed ingest

The initial approved seed fixture is `services/graphiti/seeds/initial-approved-episodes.json`. It contains sanitized production-shaped episodes for:

- Graphiti/mem0 memory boundary
- tori-local Graphiti deployment posture
- Nippon qdevice/quorum risk
- Vaultwarden homelab secret-reference convention
- Jellyfin/media stale-NFS incident pattern

These are representative smoke data, not proof that the live graph is deployed. The file is intentionally small and reviewable.

## Tests and smoke checks

Run from repo root:

```bash
python3 -m py_compile services/graphiti/agent_graphiti/*.py services/graphiti/scripts/graphiti-agent-wrapper.py services/graphiti/tests/test_agent_graphiti.py
python3 -m unittest discover -s services/graphiti/tests -v
services/graphiti/scripts/graphiti-agent-wrapper.py validate-ingest services/graphiti/seeds/initial-approved-episodes.json
services/graphiti/scripts/graphiti-agent-wrapper.py ingest services/graphiti/seeds/initial-approved-episodes.json
services/graphiti/scripts/graphiti-agent-wrapper.py --base-url http://127.0.0.1:9 query "graphiti policy" --group-id services.graphiti
```

The last command intentionally verifies Graphiti-down degradation.

## Agent instruction

Wrapper consumers must treat Graphiti as advisory context. For homelab remediation, live state still wins: inspect the current source system before changing anything. Temporal invalidation fields are advisory until reviewed.
