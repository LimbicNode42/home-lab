# Read-only agent wrapper contract

Agents must not receive raw Graphiti write/delete/clear access in this phase.

## Allowed operations

A future wrapper may expose only read-only calls such as:

- `search_facts(query, group_id?, limit?)`
- `get_episode_sources(fact_id)`
- `get_entity_context(entity, group_id?)`
- `status()`

## Required response shape

Each fact returned to an agent must include provenance and caveats:

```json
{
  "fact": "string",
  "source_episode": "string",
  "source_timestamp": "ISO-8601 or null",
  "valid_at": "ISO-8601 or null",
  "invalid_at": "ISO-8601 or null",
  "confidence": "low|medium|high|unknown",
  "caveat": "string or null",
  "query_group": "homelab|hermes|incident|other"
}
```

## Prohibited operations

Do not expose direct agent tools for:

- `POST /clear`
- deleting groups
- deleting episodes
- deleting edges
- arbitrary Cypher writes
- automated broad ingest from raw chat/session data

## Agent instruction

Wrapper consumers must treat Graphiti as advisory context. For homelab remediation, live state still wins: inspect the current source system before changing anything.
