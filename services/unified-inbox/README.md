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
- `POST /api/unified-inbox/connectors/android-sms-mms/batches` — authenticated
  device upload for the Android default-SMS-handler connector. Requires
  `Authorization: Bearer <UNIFIED_INBOX_ANDROID_SMS_MMS_UPLOAD_TOKEN>`, schema
  `android-sms-mms.v1`, synthetic/normalized envelopes only, and dedupes on
  `source + account_ref + message_id`. This is an ingestion path, not a
  reply/send/delete/mark-read action surface.
- `GET /` — minimal local inspection page linking to the status API.

There are no reply/action endpoints. A `POST` to reply-like paths returns `404`; the service is not being handed a keyboard in phase 1.

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

## Connectors (phase 1 implemented)

Phase 1 ships three read-only connectors behind `ReadOnlyMessageStream`:

| Connector | Source id | Ingestion mode | Read-only guarantees | Vaultwarden item | Secret/non-secret fields |
| --- | --- | --- | --- | --- | --- |
| Email IMAP | `email-imap` | Poll (bounded) | LOGIN/SELECT/SEARCH/FETCH only; no `\Seen` write, move, delete, expunge, send, reply | `unified-inbox/email-imap/<account>` | non-secret: `imap_host`, `imap_port`, `imap_username`, `imap_tls_mode`; secret: `imap_password_or_oauth_ref` |
| RSS/Atom | `rss` | Poll (bounded, rate-limited) | Fetch/parse only; no upstream write | `unified-inbox/rss/<feed-or-source>` | non-secret: `feed_url`; optional: `min_interval_ms` |
| Webhook | `webhook` | Push (receive) | Signature-verified inbound only; no upstream mutation | `unified-inbox/webhook/<source>` | non-secret: `source_label`; secret: `webhook_signing_secret` |

## Connectors (phase 2 implemented)

Phase 2 adds four sanctioned chat/workspace connectors, all read-only behind `ReadOnlyMessageStream`:

| Connector | Source id | Ingestion mode | Read-only guarantees | Vaultwarden item | Secret/non-secret fields |
| --- | --- | --- | --- | --- | --- |
| Discord | `discord` | Gateway state / bounded REST read-back | Consumes an already-connected Hermes gateway state export or a read-only bot backfill; NO send/reply/react/delete/archive/mark-read; does NOT modify or restart gateway config | `unified-inbox/discord/<account-or-workspace>` | non-secret: `application_id`, `guild_id_allowlist`, `channel_id_allowlist`; secret: `bot_token` |
| Telegram | `telegram` | Poll `getUpdates` (bounded, rate-limited) | `getUpdates`/read only; NO `sendMessage`/`deleteMessage`/`editMessage*`/`forwardMessage` | `unified-inbox/telegram/<account-or-bot>` | non-secret: `min_interval_ms`, `webhook_secret_ref`; secret: `bot_token` |
| Matrix | `matrix` | `GET /sync` incremental (bounded, rate-limited) | Read `/sync` only; NO send/redact/delete/join; encrypted events surfaced explicitly, not decrypted | `unified-inbox/matrix/<account>` | non-secret: `homeserver_url`, `user_id`, `device_id`, `min_interval_ms`; secret: `access_token` |
| Slack | `slack` | `conversations.history` read (bounded, rate-limited) | Read history only; NO `chat.postMessage`/`chat.delete`/`reactions.add`/archive; read scopes only, no `chat:write` | `unified-inbox/slack/<workspace>` | non-secret: `app_id`, `workspace_id`, `channel_id_allowlist`, `min_interval_ms`; secret: `bot_token`, `signing_secret` |

| Android SMS/MMS | `android-sms-mms` | Device push batch from default SMS handler app | Android default SMS role + explicit local consent required; authenticated upload only; no send/reply/delete/archive/mark-read; MMS binary upload excluded, metadata refs only | `unified-inbox/android-sms-mms/<device>` | non-secret: `device_label`; secret: `upload_api_token`, `device_pairing_secret` |

Notes:

- Email `read_state` is derived from the observed `\Seen` flag and reported, never written back upstream.
- RSS item identity (idempotency key) is GUID/link/id with a deterministic fallback; cursor stops re-ingest of already-seen items.
- Webhook ingestion is **opt-in and off by default**. `createApp` requires an explicit `webhookIngest` router; without it, `POST /api/unified-inbox/webhook/*` returns `404`. Signatures are HMAC (sha256 or sha1) with constant-time comparison.
- All connectors bound their work via `max_messages` and a runtime clock, and report structured health (including `rate_limited`) instead of crash-looping.
- Phase 2 connector sync cursors (Discord last-message id, Telegram `update_id`, Matrix `since` token, Slack per-channel cursor/thread_ts) are sensitive runtime state: serializable, never committed to Git or written into fixtures/docs/logs. Cursor handling is centralized in `src/connectors/cursor-state.js`, which also rejects credential-shaped tokens.

Credentials are materialized by the operator from Vaultwarden and passed to connectors at construction. Only field/reference names live in the repo; no values.

## Envelope fields

The normalized envelope fields are fixed by the parent ADR:

`source`, `account_ref`, `conversation_id`, `conversation_title`, `thread_id`, `message_id`, `sender`, `sent_at`, `received_at`, `body_text`, `attachment_refs`, `read_state`, `permalink`, `raw_ref`, `ingest_batch_id`.

The canonical dedupe key is `source + account_ref + message_id`.

## Explicit exclusions

Status responses always include:

- `whatsapp-personal-dm`: excluded because unsanctioned personal DM access is out of scope.
- `instagram-personal-dm`: excluded because unsanctioned personal DM access is out of scope.

Do not add browser automation or personal-account scraping as a workaround. That is not a connector, it is a trap wearing shoes.
