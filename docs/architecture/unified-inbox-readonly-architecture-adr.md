# Unified Inbox read-only aggregation architecture ADR

Status: proposed architecture/specification package for Kanban epic `t_cbd02d0c`.

Decision owner: Kanban architecture lane `t_1dafcf77`.

Scope lock: read-only aggregation first. This design does not send replies, mutate upstream messages, scrape personal WhatsApp or Instagram DMs, or use unsanctioned bridges. Exclusions are part of the operator-visible contract, not TODOs hiding in the cupboard.

## Goals

- Aggregate message-like events from sanctioned sources into one normalized inbox service at `services/unified-inbox/`.
- Keep connector implementations small, testable, read-only, and replaceable behind a common interface named `ReadOnlyMessageStream`.
- Store a canonical append-only message history that can survive service rebuilds and NAS outages without placing active write-ahead-log state on NFS.
- Expose enough Home Dashboard status for Ben to see connector health, freshness, message counts, links, and intentionally excluded channels.
- Keep credential material in Vaultwarden only. The repository stores reference names and field names, never secret values.

## Non-goals and explicit exclusions

- No outbound replies, reactions, typing indicators, moderation actions, or upstream state mutations.
- No unofficial WhatsApp Web bridges, Instagram DM scraping, browser session automation, or personal-account scraping.
- No storage of secret values, rendered tokens, OAuth refresh tokens, local filesystem paths, or raw debug dumps in dashboard-served docs or Kanban handoffs.
- No active SQLite WAL, DuckDB write workload, or similar mutable database state hosted directly on NAS/NFS.
- No assumption that all connectors support reliable read-state sync, edits, deletes, or attachment download in phase 1.

## Phased architecture

### Phase 0: architecture and runtime discovery

- Land this ADR/spec package.
- Confirm runtime placement, service manager, backup paths, network routes, and shared Postgres availability in the infra discovery lane.
- Decide exact local writable path and NAS snapshot destination only after discovery verifies current homelab state.

### Phase 1: backend foundation plus low-risk connectors

- Create `services/unified-inbox/` with the service boundary, envelope schema, connector interface, ingestion loop, snapshot writer, health endpoint, and query API.
- Implement Email IMAP and RSS/webhook-style connectors first because they are naturally read-only and well suited to polling.
- Add dashboard visibility plumbing before calling the phase usable.

### Phase 2: sanctioned chat/workspace connectors

- Add Discord, Telegram, Matrix, and Slack using official bot/app APIs and least-privilege scopes.
- Keep bot/app accounts separate from Ben's personal identity where the platform supports that distinction.
- Show unsupported scopes or workspace authorization gaps as connector health states instead of silently dropping them.

### Phase 3: Android client and SMS/MMS design

- Build a read-only Android client after the backend/dashboard pipeline has been verified.
- Defer SMS/MMS until Android default-SMS-handler implications are designed and reviewed. SMS/MMS requires an explicit Android-side trust decision; it is not a backend-only connector.

### Future epic: two-way actions

- Replies, triage actions, muting, archiving, and read-state writes belong in a later epic with new risk gates and platform-specific approval. The first inbox must earn read privileges before anyone hands it a keyboard.

## Service boundary

Planned path: `services/unified-inbox/`.

Suggested internal modules:

| Module | Responsibility |
| --- | --- |
| `src/connectors/` | Connector implementations that satisfy `ReadOnlyMessageStream`. |
| `src/envelope/` | Normalization, schema validation, and stable id helpers. |
| `src/ingest/` | Poll/sync orchestration, batch tracking, dedupe, and snapshot writes. |
| `src/storage/` | Append-only canonical artifact writer plus optional query projection. |
| `src/api/` | Read-only HTTP/API endpoints for inbox queries, health, freshness, and counts. |
| `src/dashboard/` | Sanitized status projection consumed by the Home Dashboard lane. |
| `docs/` | Connector setup runbooks and Vaultwarden reference names. |

The service should be deployable independently from the personal dashboard. Dashboard integration reads a sanitized API/status projection; it must not read connector secrets or raw upstream payloads directly.

## Normalized message envelope

Canonical field list, fixed by the parent epic:

| Field | Required | Type / shape | Notes |
| --- | --- | --- | --- |
| `source` | yes | string enum-ish | Connector family, e.g. `email-imap`, `discord`, `telegram`, `matrix`, `slack`, `rss`, `android-sms-mms`. |
| `account_ref` | yes | string | Non-secret reference to the configured account, matching the Vaultwarden account suffix where practical. |
| `conversation_id` | yes | string | Stable upstream conversation/channel/thread/mailbox/feed id when available; otherwise a deterministic connector-local id. |
| `conversation_title` | no | string/null | Sanitized display title: channel name, room name, email subject grouping, feed title, or contact label. |
| `thread_id` | no | string/null | Upstream thread id, email Message-ID/In-Reply-To thread key, Slack thread_ts, Discord thread/channel split, etc. |
| `message_id` | yes | string | Stable upstream message id within `source + account_ref`; never use an autoincrement id as the only identity. |
| `sender` | yes | object | Sanitized `{ id, display_name, handle }` where fields may be null if unavailable. |
| `sent_at` | yes | ISO-8601 string | Upstream event time. Preserve timezone by normalizing to UTC with offset-free `Z`. |
| `received_at` | yes | ISO-8601 string | Local ingestion time for audit/freshness. |
| `body_text` | no | string/null | Plain-text projection only. HTML/Markdown/raw bodies may be captured later behind a reviewed sanitizer, not in the baseline envelope. |
| `attachment_refs` | yes | array | Metadata references only: `{ id, name, content_type, size, upstream_url_ref }`; do not eagerly download arbitrary attachments in phase 1. |
| `read_state` | yes | string | `unknown`, `unread`, `read`, or connector-specific safe label if read-only API exposes it. Do not write it upstream. |
| `permalink` | no | string/null | Safe user-openable link if the platform provides one and it contains no embedded token. |
| `raw_ref` | yes | object/string | Pointer to immutable raw snapshot record/batch, not the full raw payload in API responses. |
| `ingest_batch_id` | yes | string | Batch id for replay, troubleshooting, and snapshot lineage. |

Envelope validation rules:

- The canonical dedupe key is `source + account_ref + message_id`; `thread_id` and `conversation_id` are query dimensions, not identity by themselves.
- Store `sent_at` and `received_at` as UTC ISO-8601 strings.
- Treat `body_text` as a safe display projection. Preserve raw content only in canonical snapshots with restricted service-local access and no dashboard exposure.
- `permalink` must be `http(s)` and must reject embedded `token`, `key`, `authorization`, or similar query parameters.
- `raw_ref` must reference a local immutable snapshot coordinate such as `{ batch_id, snapshot_file, offset }`; dashboard APIs should return either an opaque id or omit it unless an operator-only endpoint is added.

## Connector contract: `ReadOnlyMessageStream`

A connector is a read-only stream adapter. It may poll, long-poll, sync, or consume a gateway, but it presents the same contract to ingestion.

```ts
export interface ReadOnlyMessageStream {
  readonly source: string;
  readonly accountRef: string;

  health(): Promise<ConnectorHealth>;
  sync(cursor: SyncCursor | null, limits: SyncLimits): AsyncIterable<ReadOnlyMessageBatch>;
  normalize(raw: RawMessageRef): Promise<NormalizedMessageEnvelope>;
  close?(): Promise<void>;
}
```

Suggested supporting types:

```ts
export type ConnectorHealth = {
  state: 'ok' | 'degraded' | 'auth_required' | 'rate_limited' | 'unsupported' | 'disabled' | 'error';
  checked_at: string;
  last_success_at: string | null;
  last_error_code: string | null;
  detail: string;
};

export type SyncCursor = {
  connector_cursor: string | null;
  high_watermark_sent_at: string | null;
  last_message_id: string | null;
};

export type SyncLimits = {
  max_messages: number;
  max_runtime_ms: number;
};

export type ReadOnlyMessageBatch = {
  ingest_batch_id: string;
  cursor_before: SyncCursor | null;
  cursor_after: SyncCursor | null;
  raw_refs: RawMessageRef[];
};
```

Contract requirements:

- Connector code must not expose methods named `send`, `reply`, `delete`, `markRead`, `archive`, or equivalent mutators in the phase-1 interface.
- OAuth/API scope requests must be documented per connector and kept to read-only scopes where the platform has that concept.
- Rate limits and authorization failures should become structured `ConnectorHealth` states, not crash loops.
- Sync cursors are connector-owned but must be serializable and safe to store without secrets.
- Connector test fixtures should include edited/deleted/upstream-missing cases even if baseline behavior is only to preserve the original immutable event plus a later status marker.

## Connector matrix

| Connector | Sanctioned access path | Baseline mode | Read-only scope/permission notes | Cursor strategy | Attachments | Important risks/gates |
| --- | --- | --- | --- | --- | --- | --- |
| Email IMAP | IMAP over TLS using account/app password or OAuth where configured | Poll mailboxes | Use read/search/fetch only; do not set `\Seen`, move, delete, or flag messages | UIDVALIDITY + UID per mailbox, plus Message-ID thread hints | Metadata refs first; optional bodypart fetch later | App passwords/OAuth refresh tokens must live only in Vaultwarden refs. HTML bodies need sanitization before display. |
| Discord gateway/bot | Official Discord bot/gateway/API for servers/channels where bot is invited | Gateway events plus bounded REST backfill | Bot token with minimal guild/channel read permissions; no message send/manage scopes | Last message id per channel/thread | Metadata refs to Discord CDN URLs only if URLs are safe and non-secret | Personal DMs are not in scope. Gateway reconnect/rate limits must surface in health. |
| Telegram Bot API | Official Telegram Bot API | Poll `getUpdates` or webhook receiver | Bot sees chats where it is present; no sendMessage in baseline service | Update id high-watermark plus chat/message ids | Metadata refs for files; avoid downloading file contents initially | Bot cannot read arbitrary personal history before being added. Webhook public exposure requires separate infra review. |
| Matrix sync | Matrix Client-Server API using a dedicated account | `/sync` incremental read | Dedicated user token with room membership; no send/delete/redact calls | Matrix `since` token | Metadata refs from event content only; downloads later behind sanitizer | E2EE rooms require key-management decision before support. Treat unsupported encrypted events explicitly. |
| Slack app/bot | Official Slack app/bot APIs and Events API where installed | Events API or conversations.history polling | Minimal `channels:history`, `groups:history`, `im:history`, `mpim:history` only where approved; no chat:write | Slack cursor + channel latest timestamp/thread_ts | Metadata refs; file download later only with reviewed scopes | Workspace install and private channel scopes require Ben/workspace approval. Slack tokens are high-value secrets. |
| RSS/webhooks | RSS/Atom fetch and explicit inbound webhook endpoints | Poll feeds; receive signed/allowlisted webhooks | No upstream write capability | Feed item GUID/link/pubDate high-watermark; webhook event id | Usually link refs only | Webhook auth/signature scheme must be defined before public exposure. Feed HTML must be sanitized. |
| Android SMS/MMS default handler | Android app acting as default SMS handler, after explicit user approval | Android-local read/export to backend | Android permissions/default-handler role; backend remains read-only | Device-local message id + timestamp export cursor | MMS part metadata only until storage policy reviewed | Highest privacy gate. Requires default handler UX, backup, and Android security review. Detailed design and acceptance criteria: `unified-inbox-android-sms-mms-default-handler-design.md`. |

Unsupported/excluded channels must still appear in dashboard status, for example: `whatsapp-personal-dm: excluded_unsanctioned_personal_dm` and `instagram-personal-dm: excluded_unsanctioned_personal_dm`.

## Storage and data-placement ADR

Decision: use host-local or container-local writable service state for active ingestion, and copy immutable append-only JSONL/Parquet snapshots to NAS as the canonical backup/export artifact. Avoid active SQLite WAL or similar write-heavy mutable database files on NFS. The shared homelab Postgres service may be used for indexed/query projection if backed up to NAS snapshots, but it must not be the only canonical artifact.

### Rationale

- Active database files over NFS are a known reliability trap: locks, WAL files, stale handles, and atomic writer replacement can fail in entertainingly awful ways. The entertainment is not the deliverable.
- Host-local active state lets connectors maintain cursors, staging files, and retry queues without depending on NAS availability for every write.
- Append-only JSONL/Parquet snapshots are easy to copy, inspect, hash, back up, and replay into a new projection store.
- Postgres is useful for query latency, dedupe indexes, dashboard counts, and retention queries, but it should be rebuildable from immutable snapshots.

### Baseline layout

Exact host paths must be confirmed by the infra discovery lane before deployment. The shape should be:

| Class | Placement | Contents | Backup posture |
| --- | --- | --- | --- |
| Active service state | host-local/container-local writable volume | cursors, ingest queue, current batch staging, connector health cache | Back up via periodic snapshots, but do not rely on NAS for active writes. |
| Canonical immutable snapshots | host-local first, copied to NAS after batch close | append-only JSONL/Parquet normalized envelopes and raw snapshot refs | NAS copy is the durable canonical backup/export. Hash manifests recommended. |
| Query projection | optional shared Postgres or local embedded DB | dedupe index, conversation/message lookup, dashboard counts | Rebuildable from snapshots. If Postgres is used, include it in existing Postgres backup plan. |
| Dashboard status projection | sanitized API response/cache | connector health, freshness, message counts, service links, exclusions | No secrets, no raw bodies, no local paths. |

### Snapshot requirements

- Write batches to a temporary local file, fsync/close, then atomically promote locally before copying to NAS.
- Treat NAS copy as immutable by batch id. Never rewrite a closed batch; supersede it with a correction batch if necessary.
- Include a batch manifest with schema version, connector versions, record counts, min/max `sent_at`, hash, and copy status.
- Keep raw upstream payloads more restricted than normalized envelopes. Dashboard APIs should not expose raw payloads.
- Define retention separately for raw snapshots, normalized snapshots, and query projection rows.

### Postgres projection option

Postgres on the shared homelab service is acceptable for query projection when:

- credentials come from Vaultwarden refs;
- schema migrations are committed under `services/unified-inbox/`;
- all tables are rebuildable from snapshot artifacts;
- backup coverage includes the database; and
- failed Postgres writes do not destroy canonical snapshots.

If Postgres is unavailable, the service should still be able to ingest to local immutable snapshots and report degraded query health.

## Sanitized Vaultwarden reference naming

Repository/config docs may name these references only; do not commit values.

Folder: `homelab`.

Item naming convention: `unified-inbox/<connector>/<account>`.

Suggested fields by connector:

| Connector | Example item | Fields to reference | Notes |
| --- | --- | --- | --- |
| Email IMAP | `unified-inbox/email-imap/personal` | `imap_host`, `imap_port`, `imap_username`, `imap_password_or_oauth_ref`, `imap_tls_mode` | Prefer app password/OAuth where supported; field name may reference an OAuth item, not contain nested secret docs. |
| Discord | `unified-inbox/discord/home-server-bot` | `bot_token`, `application_id`, `guild_id_allowlist` | Token stays in Vaultwarden. Allowlist may be non-secret but keep it in the rendered runtime config if it reveals private server names. |
| Telegram | `unified-inbox/telegram/home-bot` | `bot_token`, `webhook_secret_ref` | `webhook_secret_ref` points to a value field/item, not a committed literal. |
| Matrix | `unified-inbox/matrix/home-account` | `homeserver_url`, `access_token`, `user_id`, `device_id` | E2EE room support deferred until key handling is designed. |
| Slack | `unified-inbox/slack/workspace-bot` | `bot_token`, `signing_secret`, `app_id`, `workspace_id` | Workspace/user ids may be sensitive in context; keep dashboard labels sanitized. |
| RSS/webhooks | `unified-inbox/rss/default` / `unified-inbox/webhook/<source>` | `feed_url_ref`, `webhook_signing_secret`, `source_allowlist_ref` | Public feed URLs can be config if approved; private feeds should be refs. |
| Android SMS/MMS | `unified-inbox/android-sms-mms/<device>` | `device_pairing_secret`, `upload_api_token`, `device_label` | Only after Android design/review. Do not create early credentials. |
| Query projection | `unified-inbox/database/projection` | `database_url` | If Postgres projection is enabled; preserve backup/rebuild requirement. |

Rendered environment variables and config files derived from these items must stay outside Git and out of dashboard-served documentation.

## Home Dashboard visibility requirements

The Home Dashboard lane should add a read-only Unified Inbox surface after the backend exposes sanitized status endpoints. Required operator-visible signals:

| Signal | Dashboard requirement |
| --- | --- |
| Connector health | Per-connector state: `ok`, `degraded`, `auth_required`, `rate_limited`, `unsupported`, `disabled`, `error`, or `excluded`. Include a short safe detail. |
| Last-fetch freshness | Per connector/account `last_success_at`, `last_attempt_at`, and age bucket. Stale state should be visible without opening logs. |
| Message counts | Per connector/account counts for latest batch and retained query projection; include total visible messages and count by `read_state` when available. |
| Backend web/API link | Link to the authenticated backend UI/API route once deployed. Link must be sanitized and must not include tokens or local-only operator paths. |
| Excluded channels | Explicit rows/cards for personal WhatsApp DMs and Instagram DMs with status `excluded` and reason `unsanctioned personal DM access is out of scope`. |
| Snapshot/backup freshness | Show latest closed snapshot batch id/time and NAS copy status if the backend publishes it safely. |

Suggested backend endpoints for the dashboard lane:

- `GET /healthz` returns minimal unauthenticated service health.
- `GET /api/unified-inbox/status` returns authenticated sanitized service, connector, freshness, snapshot, and exclusion status.
- `GET /api/unified-inbox/messages` returns authenticated paginated normalized envelopes or a safe subset thereof.
- `GET /api/unified-inbox/conversations` returns authenticated conversation summaries and counts.

No dashboard endpoint should return credential refs beyond non-secret `account_ref`, local host paths, raw payloads, secret-shaped values, or stack traces.

## Risk gates

| Gate | Required before |
| --- | --- |
| Credential rendering review | Any connector runtime starts with real tokens/passwords. |
| Storage path confirmation | First deployment writes service state or snapshots. |
| Dashboard sanitizer review | Message bodies or sender/display names appear in browser UI. |
| Platform scope review | Discord, Slack, Matrix, or Telegram connectors request workspace/server/room permissions. |
| Public webhook exposure review | Telegram/webhook connectors expose inbound endpoints through Traefik/Cloudflare. |
| Android default SMS handler review | SMS/MMS connector implementation begins. |
| Two-way action review | Any reply, mark-read, archive, delete, reaction, or moderation capability is designed. |

## Implementation acceptance criteria for downstream lanes

- The backend defines and tests `ReadOnlyMessageStream` without mutator methods.
- The backend validates the normalized envelope fields listed in this ADR.
- The backend can ingest fixture batches into immutable snapshots and rebuild a query projection from those snapshots.
- Connector implementations document the Vaultwarden item/field refs they need without values.
- Dashboard integration shows health, freshness, counts, backend link, and explicit excluded-channel statuses.
- Secret scans over changed docs/config/code return no credential-shaped literals.
- No live deploy, connector authorization, or dashboard mutation occurs without the relevant downstream task and approval gate.
