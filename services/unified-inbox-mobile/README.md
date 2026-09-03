# Unified Inbox — Android client (read-only)

> This directory lives under the `services/` convention because it is client code for
> the `services/unified-inbox/` backend, but it is a **Flutter app, not a deployed
> service**. It builds to a local APK for the headless Android emulator workflow; it is
> not deployed to Ben's personal device.

Android-first Flutter client for the read-only unified inbox backend
(`services/unified-inbox/`). It surfaces aggregated messages across the backend's
connectors with zero write capability.

## Read-only guarantees

- Only `GET` requests are issued: `/api/unified-inbox/status`,
  `/api/unified-inbox/messages`, and `/api/unified-inbox/conversations`.
- There are **no** reply/send/delete/archive/mark-read controls anywhere in the UI.
  The backend has no such endpoints (non-GET returns `404`), and the client never
  constructs them.
- SMS/MMS and two-way messaging are explicitly out of scope for this task.

## Screens

| View | What it shows |
| --- | --- |
| Messages | Paginated normalized envelope list: source badge, sender label, body preview, relative timestamp, read/unread dot. Tap for detail. |
| Detail | Full envelope: source, account, sender/handle, sent/received, read state, permalink, body, attachment reference links. |
| Conversations | Conversation summaries: title, source/account, message count, latest activity. |
| Status | Service mode (must be `read_only`), message count, connector health broken into healthy / error / pending-credentials groups, and explicit exclusions (personal WhatsApp/Instagram DMs). |

## Build & run

```sh
flutter pub get
flutter analyze
flutter test

# Point at a real backend (default http://192.168.0.50:8766):
flutter run --dart-define=UNIFIED_INBOX_BASE_URL=http://192.168.0.50:8766
```

## Backend contract

The client models mirror the canonical envelope from `services/unified-inbox`:

`source`, `account_ref`, `conversation_id`, `conversation_title`, `thread_id`,
`message_id`, `sender`, `sent_at`, `received_at`, `body_text`, `attachment_refs`,
`read_state`, `permalink`, `raw_ref`, `ingest_batch_id`.

Connector health states the client surfaces: `ok`, `error`, `disabled`,
`not_configured`, `pending_credentials`, `rate_limited`.

## Notes

- LAN HTTP requires Android cleartext traffic (enabled in the manifest) because the
  backend is reached over `http://` on the homelab LAN. This is a development client.
- No secrets, DB URLs, local paths, or tokens are stored or logged by the client.