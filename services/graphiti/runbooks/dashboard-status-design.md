# Home Dashboard status design for Graphiti

Dashboard work is intentionally design-only in this phase. Do not add live dashboard links until Graphiti exists and its access posture is reviewed.

## Status card goals

The dashboard should answer:

- Is the read-only Graphiti wrapper/API reachable?
- Is Neo4j ready?
- How fresh is the latest curated episode/fact per group?
- How old is the latest successful backup?
- How old is the latest successful restore test?
- Are any destructive raw Graphiti endpoints exposed to agents or the LAN?

## Candidate status JSON

```json
{
  "service": {
    "name": "graphiti-knowledge-graph",
    "state": "not_deployed|healthy|degraded|down|unsafe_exposure_detected",
    "mode": "experimental-read-only",
    "public_route": false
  },
  "api": {
    "healthcheck": "ok|fail|not_configured",
    "read_only_wrapper": "ok|missing|not_deployed",
    "raw_destructive_endpoints_exposed": false
  },
  "neo4j": {
    "ready": "ok|fail|not_deployed",
    "node_count": 0,
    "relationship_count": 0
  },
  "freshness": {
    "latest_episode_at": null,
    "groups": []
  },
  "backups": {
    "latest_backup_at": null,
    "latest_backup_exit_code": null,
    "latest_restore_test_at": null,
    "restore_test_age_state": "missing|fresh|stale"
  }
}
```

## Dashboard exposure rule

Link only to a protected LAN/admin route if one exists. Otherwise show status without an operator link. No credentials, local filesystem paths, NAS paths, stderr, tokens, or raw query text in dashboard output.
