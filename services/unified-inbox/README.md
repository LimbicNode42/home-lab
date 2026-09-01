# Unified Inbox

Read-only backend foundation for the unified message aggregation inbox.

This service is intentionally narrow:

- read-only message aggregation only;
- no reply/send/delete/archive/mark-read upstream mutation paths;
- sanctioned APIs only;
- personal WhatsApp DMs and Instagram DMs are explicitly excluded;
- credential values stay in Vaultwarden, not in Git, logs, dashboard JSON, or Kanban handoffs;
- active writable service state stays host-local; immutable snapshot artifacts can be copied to NAS.

## Local development

```sh
cd services/unified-inbox
npm test
HOST=127.0.0.1 PORT=8766 npm start
```

Useful endpoints:

- `GET /healthz` — minimal unauthenticated liveness, no counts or paths.
- `GET /api/unified-inbox/status` — sanitized read-only status, connector health, snapshot metadata, and exclusions.
- `GET /api/unified-inbox/messages` — paginated normalized envelope projection.
- `GET /api/unified-inbox/conversations` — conversation summaries and counts.
- `GET /` — minimal local inspection page linking to the status API.

There are no write/action endpoints. A `POST` to reply-like paths returns `404`; the service is not being handed a keyboard in phase 1.

## Storage model

The `FileSnapshotStore` writes a batch to a local temporary file, atomically promotes it to the local closed snapshot directory, then copies the closed immutable artifact to the configured NAS snapshot directory and writes a manifest. Defaults for local development are relative paths under `./state`; production should render explicit host-local and NAS paths:

- host-local active state: `/var/lib/unified-inbox/state`;
- host-local closed snapshots: `/var/lib/unified-inbox/snapshots/closed`;
- NAS normalized snapshots: `/mnt/nas/services/unified-inbox/snapshots/normalized`;
- NAS manifests: `/mnt/nas/services/unified-inbox/manifests`.

Do not place active SQLite/DuckDB/write-ahead-log state on NFS. If Postgres projection is added later, it must be rebuildable from immutable snapshots.

## Connector contract

Connectors implement `ReadOnlyMessageStream` from `src/connectors/stream.js`:

- `source` and `accountRef` identify the stream;
- `health()` reports structured connector state;
- `sync(cursor, limits)` yields read-only raw refs grouped by ingest batch;
- `normalize(rawRef)` returns the locked normalized envelope shape.

The registry rejects mutator-shaped connectors with methods such as `send`, `reply`, `delete`, `markRead`, `archive`, `react`, `move`, or `flag`.

## Envelope fields

The normalized envelope fields are fixed by the parent ADR:

`source`, `account_ref`, `conversation_id`, `conversation_title`, `thread_id`, `message_id`, `sender`, `sent_at`, `received_at`, `body_text`, `attachment_refs`, `read_state`, `permalink`, `raw_ref`, `ingest_batch_id`.

The canonical dedupe key is `source + account_ref + message_id`.

## Explicit exclusions

Status responses always include:

- `whatsapp-personal-dm`: excluded because unsanctioned personal DM access is out of scope.
- `instagram-personal-dm`: excluded because unsanctioned personal DM access is out of scope.

Do not add browser automation or personal-account scraping as a workaround. That is not a connector, it is a trap wearing shoes.
