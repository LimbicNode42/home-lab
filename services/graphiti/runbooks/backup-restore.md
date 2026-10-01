# Graphiti Neo4j backup, restore, and restore-test runbook

## Scope and placement

Graphiti + Neo4j is an optional shared operational/provenance graph. It does not replace mem0; mem0 remains the active personal/preference memory provider.

Production posture for the first deployment:

- Host: `tori` (`192.168.0.20`).
- Runtime compose directory: `/opt/graphiti`.
- Live Neo4j data: `/var/lib/graphiti/neo4j/data` on tori-local disk only.
- NAS output root: `/mnt/pve/NAS/services/graphiti`.
- NAS is for dumps, non-secret config snapshots, manifests, and restore-test evidence only.
- No public route, no Cloudflare Tunnel hostname, and no raw destructive Graphiti endpoints for agents.

## Scripts

From the repo copy on the operator machine or from a reviewed copy deployed to tori:

- `services/graphiti/scripts/backup-neo4j-dump.sh`
  - `--dry-run`: prints the backup plan and performs no Docker/NAS mutation.
  - `--apply`: creates a backup set and manifest under the NAS target.
- `services/graphiti/scripts/restore-test-neo4j.sh`
  - `--dry-run /path/to/dump`: verifies whether the dump exists and prints the disposable restore plan.
  - `--apply /path/to/dump`: loads the dump into an isolated disposable Neo4j container/path, captures counts and evidence, then removes the container.
- `services/graphiti/scripts/restore-neo4j-dump.sh`
  - live destructive restore only; not used for routine verification.

## Backup behavior

Neo4j Community dumps are treated as offline dumps. The backup script is explicit about this instead of pretending an online dump is application-consistent.

`backup-neo4j-dump.sh --apply` requires both gates:

```bash
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved
GRAPHITI_BACKUP_ALLOW_SERVICE_STOP=approved
```

When applied, it:

1. Verifies the live Neo4j data path is not NFS/CIFS/fuse-backed.
2. Creates timestamped NAS directories:
   - `${GRAPHITI_NAS_BACKUP_DIR:-/mnt/pve/NAS/services/graphiti/backups/neo4j-dumps}/<stamp>/`
   - `${GRAPHITI_NAS_SNAPSHOT_DIR:-/mnt/pve/NAS/services/graphiti/config-snapshots}/<stamp>/`
   - `${GRAPHITI_NAS_MANIFEST_DIR:-/mnt/pve/NAS/services/graphiti/manifests}/`
3. Copies the compose file and an `env.keys` manifest only. Runtime `.env` values are never copied.
4. Captures a sanitized image manifest from `docker inspect` containing image names/IDs only.
5. Stops `graphiti-api` and `neo4j` through Docker Compose.
6. Runs an ephemeral Neo4j container against the compose-mounted data and writes a dump to the NAS backup set.
7. Writes and verifies a SHA-256 checksum.
8. Writes a JSON manifest with file path, size, checksum, live-data filesystem type, and restore-test-required status.
9. Restarts `neo4j` and `graphiti-api`.

A backup is not considered production-complete until the corresponding restore test passes.

## Restore-test behavior

Restore tests must use disposable targets only. The restore-test script does not call the production compose file and does not mount `/var/lib/graphiti`.

`restore-test-neo4j.sh --apply <dump>` requires:

```bash
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved
```

When applied, it:

1. Verifies the dump path exists and is not under `/var/lib/graphiti`.
2. Verifies a sidecar checksum if `<dump>.sha256` exists; otherwise it computes a standalone checksum for evidence.
3. Loads the dump into a temporary `/tmp/graphiti-restore-test.*` data path.
4. Starts a uniquely named disposable Neo4j container bound only to loopback ports `127.0.0.1:17474` and `127.0.0.1:17687` by default.
5. Waits for `cypher-shell` readiness.
6. Captures node count, relationship count, constraint count, and index count.
7. Writes sanitized evidence to `${GRAPHITI_NAS_RESTORE_TEST_DIR:-/mnt/pve/NAS/services/graphiti/restore-tests}/<stamp>/restore-test-result.json` plus container logs.
8. Removes the disposable container and temporary data path unless `GRAPHITI_RESTORE_TEST_WORKDIR` is explicitly set for debugging.

The evidence JSON records `production_data_touched: false`.

## Live restore boundary

`restore-neo4j-dump.sh` is intentionally harder to run than the restore test. It is destructive and requires a separate approved restore card plus all of these gates:

```bash
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved
GRAPHITI_RESTORE_TARGET=live-neo4j
GRAPHITI_RESTORE_PRE_SNAPSHOT_CONFIRMED=approved
```

Before a live restore, an operator must complete and record:

1. Successful restore-test evidence for the exact dump.
2. A filesystem snapshot/copy of the current live data path.
3. A rollback decision for the pre-restore state.
4. A planned service disruption window.

Do not use the live restore script to prove backups. That is what the restore-test script is for.

## Operator examples

Dry-run backup plan on tori:

```bash
services/graphiti/scripts/backup-neo4j-dump.sh --dry-run
```

Approved backup run on tori:

```bash
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
GRAPHITI_BACKUP_ALLOW_SERVICE_STOP=approved \
  services/graphiti/scripts/backup-neo4j-dump.sh --apply
```

Dry-run restore test from a dump:

```bash
services/graphiti/scripts/restore-test-neo4j.sh --dry-run \
  /mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/<stamp>/neo4j-<stamp>.dump
```

Approved restore test:

```bash
GRAPHITI_ENABLE_LIVE_MUTATION=reviewed-approved \
  services/graphiti/scripts/restore-test-neo4j.sh --apply \
  /mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/<stamp>/neo4j-<stamp>.dump
```

## Retention assumptions

Initial assumption: daily backup after the first approved deployment, retained for 14 daily sets and at least 4 weekly restore-test evidence sets, unless NAS capacity or Ben's backup policy says otherwise. Do not delete old backup sets automatically until a retention policy is explicitly approved. A future pruning script must refuse to delete anything unless it has its own reviewed retention gate.

## Current execution status

As of `2026-10-01`, the live service is still blocked in this worker lane because Vaultwarden/BW is locked for kobold and the worker cannot rerun the required Vaultwarden-backed OpenRouter preflight. Therefore:

- the scripts are durable and syntax/dry-run validated;
- no live backup was taken;
- no restore test was run against production data;
- the blocked execution path is explicit: unlock/provide an ephemeral `BW_SESSION`/`BW_PASSWORD`, rerun `deploy-tori-local.sh --preflight-only`, deploy the service only after that passes, then run backup and restore-test under the gates above.

## Dashboard and downstream evidence locations

Dashboard work should treat these paths as status inputs:

- backup manifests: `/mnt/pve/NAS/services/graphiti/manifests/neo4j-backup-*.manifest.json`
- dump sets: `/mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/<stamp>/`
- restore-test evidence: `/mnt/pve/NAS/services/graphiti/restore-tests/<stamp>/restore-test-result.json`
- blocked receipts in Git: `services/graphiti/receipts/*.json`

Do not emit dump contents, raw graph data, API keys, Neo4j passwords, or rendered `.env` values into dashboard responses/logs.
