# Graphiti Neo4j backup, restore, and restore-test plan

## Storage policy

- Live Neo4j data belongs on tori-local disk: `/var/lib/graphiti/neo4j/data/`.
- NAS is for dumps, config snapshots, and restore-test evidence only.
- Do not back the live database with NFS/NAS by default. We have already had enough NFS-shaped footguns.

## Backup contents

Each backup set should include:

1. Neo4j database dump.
2. Dump checksum.
3. Non-secret config snapshot:
   - compose file
   - `.env.example` or env key manifest, not values
   - image tag/digest manifest
   - backup script version/commit
4. Graph sanity manifest:
   - node count
   - relationship count
   - latest episode timestamp per group/domain
   - Graphiti package/container version
5. Restore-test evidence and last successful restore-test timestamp.

## Backup cadence

Start with daily backup after the first approved deployment, analogous to the mem0 daily backup pattern. Increase only if curated ingest frequency justifies it.

## Backup acceptance checks

A backup is acceptable only if:

- dump command exits 0
- checksum file exists and verifies
- manifest exists and contains UTC timestamp
- NAS destination has expected file sizes
- latest restore-test age is tracked

## Restore-test acceptance checks

A restore test passes only if:

- isolated Neo4j starts from the dump
- expected indexes/constraints exist or Graphiti can rebuild them without deleting data
- node/relationship counts match the backup manifest within expected delta
- a representative `group_id` query returns facts and source episodes
- evidence is written under `GRAPHITI_NAS_RESTORE_TEST_DIR`

## Destructive boundaries

Restoring into the live database overwrites data. It requires a separate approved restore card and a pre-restore filesystem snapshot/copy of the current live data directory.
