# Unified Inbox — Android client (read-only)

> This directory lives under the `services/` convention because it is client code for
> the `services/unified-inbox/` backend, but it is a **Flutter app, not a deployed
> service**. It builds to a local APK for the headless Android emulator workflow; it is
> not deployed to Ben's personal device.

Android-first Flutter client for the read-only unified inbox backend
(`services/unified-inbox/`). It surfaces aggregated messages across the backend's
connectors with zero write capability.

## Read-only guarantees

- Only `GET` requests are issued by the inbox UI: `/api/unified-inbox/status`,
  `/api/unified-inbox/messages`, and `/api/unified-inbox/conversations`.
- There are **no** reply/send/delete/archive/mark-read controls anywhere in the UI.
  The backend has no such endpoints (non-GET returns `404`), and the client never
  constructs them.
- The Android SMS/MMS default-handler ingestion layer is **read-only capture**.
  Its only write is an authenticated `POST` to the backend's
  `/api/unified-inbox/connectors/android-sms-mms/batches` ingestion endpoint; it
  never sends, replies, deletes, archives, or marks anything read upstream.

## Android SMS/MMS default-handler ingestion

The app carries a native Android layer (Kotlin) that implements the sanctioned
default-SMS-handler capture path. It is explicitly consent-gated and does not
auto-promote the default role or request permissions on first launch:

- Role flow: `RoleManager.ROLE_SMS` via `RoleManager.createRequestRoleIntent(...)`
  on Android Q+ (legacy `ACTION_CHANGE_DEFAULT` fallback for older APIs), invoked
  only after a user taps an explicit "default SMS app" action.
- Permissions (`READ_SMS`, `RECEIVE_SMS`, `RECEIVE_MMS`) are requested only after
  the default SMS role is held.
- Receivers: `SMS_DELIVER` and `WAP_PUSH_DELIVER` are declared and protected with
  `BROADCAST_SMS` / `BROADCAST_WAP_PUSH`, matching Android's default-handler rules.
- Eligibility stubs: a `SENDTO` activity and a `RESPOND_VIA_MESSAGE` service exist
  for default-SMS eligibility and **safely decline** with a read-only notice.
  There is no `SEND_SMS` permission and no send code path.
- Capture is mapped to the canonical envelope with `source = "android-sms-mms"`,
  phone numbers redacted to a tail (`redacted:0123`), addresses hashed for identity,
  and MMS captured metadata-only (no binary upload).
- Local staging is encrypted at rest via Android Keystore-backed
  `EncryptedSharedPreferences` (AndroidX Security Crypto), bounded and drained on
  sync. Upload credentials live in Vaultwarden, referenced but never committed.

Emulator verification covers manifest shape, role-gate logic, envelope mapping,
dedupe, and authenticated upload. Real default-role switching UX, carrier MMS
delivery, and personal-device install are **physical-device gates** that require
Ben's explicit approval; an emulator run is not personal-device approval.

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