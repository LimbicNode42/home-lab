# Unified Inbox Android SMS/MMS default-handler design

Status: proposed design and implementation contract for Kanban task `t_c39e675e`.

Decision owner: Kanban documentation lane `t_c39e675e`.

Downstream implementation card: `t_c478cbe9`.

Scope lock:

- Android-only SMS/MMS ingestion.
- Sanctioned path only: an on-device Android app that the user explicitly makes the default SMS handler.
- Read-only aggregation for this epic. No reply/send UI, no backend reply endpoint, no mark-read/delete/archive actions, and no Personal WhatsApp/Instagram DM workarounds.
- iOS is out of scope because third-party SMS/MMS inbox access is not exposed in the same way.
- Emulator success is not approval to install on Ben's device or change Ben's default SMS handler.

## Source-grounded Android facts

Android's documented SMS app model drives the shape of this design:

- Android says the user-selected default SMS app is the app allowed to write to the SMS provider and the app that receives `SMS_DELIVER_ACTION` for SMS and `WAP_PUSH_DELIVER_ACTION` for MMS.
- An app that behaves as the default SMS app must handle the SMS deliver receiver, MMS WAP push deliver receiver, `ACTION_SENDTO` activity schemes for `sms:`, `smsto:`, `mms:`, and `mmsto:`, and a respond-via-message service.
- The SMS deliver receiver must require `android.permission.BROADCAST_SMS`; the MMS WAP push receiver must require `android.permission.BROADCAST_WAP_PUSH`; the respond-via-message service must require `android.permission.SEND_RESPOND_VIA_MESSAGE`.
- Android's default-handler guidance says apps should ask to become the default handler before requesting handler-associated permissions such as `READ_SMS`.
- `Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT` exists for requesting default-SMS-app changes, but the API reference notes that since Android Q the sanctioned path is `RoleManager.createRequestRoleIntent(RoleManager.ROLE_SMS)`.

References:

- Android default-handler guidance: https://developer.android.com/guide/topics/permissions/default-handlers
- Android `Telephony` SMS app requirements: https://developer.android.com/reference/android/provider/Telephony
- Android SMS intents / `ACTION_CHANGE_DEFAULT` note: https://developer.android.com/reference/android/provider/Telephony.Sms.Intents
- Android `RoleManager.ROLE_SMS`: https://developer.android.com/reference/android/app/role/RoleManager

## High-level architecture

```text
Android device
  Unified Inbox mobile app
    - default SMS role gate
    - SMS deliver receiver
    - MMS WAP push receiver
    - local encrypted staging store
    - sync worker / cursor manager
        |
        | HTTPS/LAN API upload with device-scoped credential
        v
services/unified-inbox backend
  android-sms-mms ingest endpoint
    - authn/authz for paired device
    - schema validation
    - dedupe: source + account_ref + message_id
    - immutable snapshot append
    - query projection rebuildable from snapshots
        |
        v
read-only APIs + Home Dashboard status
```

The Android app is the source connector for `source = "android-sms-mms"`. It should reuse the existing normalized envelope shape rather than inventing a second mobile-only schema. The backend remains the system of record for aggregated query APIs and dashboard status; the device owns only local capture, local minimization, local encryption, and bounded upload.

## Android app responsibilities

The later implementation should add a native Android integration layer under the existing Flutter app, not a separate scrape/automation service.

Required Android-side components:

| Component | Purpose | Read-only constraint |
| --- | --- | --- |
| Default-role gate | Detect whether `RoleManager.ROLE_SMS` is available and held; request the role only after explicit user action. | No background or first-launch default-handler prompt. No prompt loop. |
| Permission gate | Request SMS/MMS-related permissions only after the default-handler flow is started/accepted where Android requires that ordering. | Do not request broad permissions before explaining the privacy cost. |
| SMS deliver receiver | Receive incoming SMS while the app is default handler. | Persist minimal normalized/staged data; do not send or mutate upstream state. |
| MMS WAP push receiver | Receive incoming MMS notifications/payload references while default handler. | Store MMS part metadata first; do not eagerly upload binary parts until retention/storage policy is reviewed. |
| Provider importer | Optional bounded read of existing SMS/MMS provider rows after explicit consent. | Disabled by default; import window must be user-selected and documented. |
| Local staging store | Queue normalized records and cursors before sync. | Encrypted at rest; bounded retention; no raw debug dumps. |
| Sync worker | Upload batches to backend with device-scoped auth and retry safely. | Upload only normalized/read-only envelope batches and attachment metadata refs in this epic. |
| Status surface | Show default-role state, permission state, last sync time, queued count, and backend health. | Must make disabled/not-default state obvious. |

## Permissions and manifest implications

Implementation must document and test the exact manifest before merge. Expected baseline declarations:

- `android.permission.READ_SMS` for reading provider rows when default handler and/or explicit import is enabled.
- `android.permission.RECEIVE_SMS` for SMS receive behavior where required by Android version/device behavior.
- `android.permission.RECEIVE_MMS` for MMS receive behavior where available/required.
- A broadcast receiver for `android.provider.Telephony.SMS_DELIVER` protected with `android.permission.BROADCAST_SMS`.
- A broadcast receiver for `android.provider.Telephony.WAP_PUSH_DELIVER` with MIME type `application/vnd.wap.mms-message`, protected with `android.permission.BROADCAST_WAP_PUSH`.
- An activity handling `android.intent.action.SENDTO` for `sms:`, `smsto:`, `mms:`, and `mmsto:` schemes if required for default-SMS eligibility.
- A service handling `android.intent.action.RESPOND_VIA_MESSAGE` for the same schemes, protected with `android.permission.SEND_RESPOND_VIA_MESSAGE` if required for default-SMS eligibility.

The uncomfortable bit: Android may require the app to appear capable of SMS sending/responding to qualify as a default SMS handler. That does not grant product approval to build sending. The implementation must satisfy platform eligibility with safe stubs or disabled surfaces while preserving this epic's read-only contract:

- No Flutter compose UI.
- No backend send/reply endpoint.
- No app code path that sends SMS/MMS.
- Any required `SENDTO`/respond-via-message handler must show a disabled/read-only explanation or safely decline. If Android/Play policy requires actual send functionality for default-handler eligibility, stop and block for a new product/security decision instead of sneaking in a sender. Trapdoors are still doors.

## User consent flow

The app must make the privacy trade explicit and must not surprise-change the device's messaging role.

Required flow:

1. Status screen shows `SMS/MMS ingestion: disabled` with a short explanation: Android requires the app to become the default SMS handler before sanctioned local SMS/MMS ingestion.
2. User taps an explicit enable action. The button text should mention "default SMS app"; no vague "connect" wording.
3. App shows a local preflight screen covering:
   - SMS/MMS content and sender/recipient metadata will be read locally.
   - Records will sync to Ben's unified inbox backend using a device-scoped credential.
   - Sending/replying is not part of this epic.
   - Ben can revoke by changing the default SMS app back in Android settings.
   - Emulator verification is not personal-device approval.
4. App requests `RoleManager.ROLE_SMS` using `RoleManager.createRequestRoleIntent(...)` on Android Q+; legacy `ACTION_CHANGE_DEFAULT` is allowed only where required for older API support.
5. Only after role acceptance should the app request/read SMS/MMS permissions and begin ingestion.
6. The app records role state transitions locally and reports sanitized connector health to the backend/dashboard: `disabled`, `role_required`, `permission_required`, `sync_pending`, `ok`, `degraded`, or `error`.
7. Disable/revoke path must stop receivers/workers, flush or delete local queue according to the retention setting, and report `disabled` without deleting already-snapshotted backend records.

Approval gates are listed later in this document and are mandatory.

## Data minimization and local storage

Minimum viable SMS envelope data:

- provider row id / telephony URI coordinate for local dedupe only;
- normalized sender/recipient values needed for display;
- `sent_at` from the message timestamp;
- local `received_at` ingestion timestamp;
- plain text body for SMS;
- MMS part metadata only at first: part id, content type, optional filename, byte size if available, local opaque ref;
- SIM/subscription/device labels only if they are useful and non-secret.

Do not collect in this epic:

- contact book dumps;
- full address book enrichment;
- binary MMS uploads by default;
- call log data;
- location metadata outside what MMS content itself contains;
- raw provider dumps in logs, fixtures, dashboard JSON, or Kanban handoffs;
- analytics events containing message bodies, phone numbers, or local file paths.

Local storage requirements:

- Use encrypted-at-rest storage for the staging queue and cursor state. Android Keystore-backed key material is preferred; do not commit keys or test secrets.
- Keep a bounded queue with explicit retention, e.g. delete staged records after successful backend snapshot acknowledgment plus a short retry window.
- Keep raw MMS binary data local unless/until a later reviewed storage policy approves upload.
- Redact message body and phone numbers from logs by default. Debug builds may show synthetic fixture data only.
- Device pairing/upload credentials must be stored via platform secure storage and represented in Git only as Vaultwarden refs.

Suggested Vaultwarden reference shape, values not committed:

| Purpose | Folder | Item | Field |
| --- | --- | --- | --- |
| Device upload auth | `homelab` | `unified-inbox/android-sms-mms/<device>` | `upload_api_token` |
| Pairing secret | `homelab` | `unified-inbox/android-sms-mms/<device>` | `device_pairing_secret` |
| Non-secret device label | `homelab` or rendered config | `unified-inbox/android-sms-mms/<device>` | `device_label` |

## Backend API contract

Add a backend ingestion endpoint only for this device connector. It must be authenticated, schema-validated, and separate from the existing read-only query API.

Proposed endpoint:

```http
POST /api/unified-inbox/connectors/android-sms-mms/batches
Authorization: Bearer <device upload token>
Content-Type: application/json
```

Request shape:

```json
{
  "schema_version": "android-sms-mms.v1",
  "account_ref": "android-sms-mms/<device-label>",
  "device_ref": "<stable non-secret device id or configured label>",
  "cursor_before": {
    "sms_high_watermark": "<opaque local cursor>",
    "mms_high_watermark": "<opaque local cursor>",
    "last_message_id": "<last normalized id>"
  },
  "cursor_after": {
    "sms_high_watermark": "<opaque local cursor>",
    "mms_high_watermark": "<opaque local cursor>",
    "last_message_id": "<last normalized id>"
  },
  "messages": [
    {
      "source": "android-sms-mms",
      "account_ref": "android-sms-mms/<device-label>",
      "conversation_id": "android-sms-mms:<device-label>:<conversation-key>",
      "conversation_title": "<redacted contact label or phone tail>",
      "thread_id": "<telephony thread id or null>",
      "message_id": "sms:<provider-row-id>:<date-ms>:<address-hash>",
      "sender": {
        "id": "<address hash or self>",
        "display_name": "<safe display label or null>",
        "handle": "<phone number redacted or null>"
      },
      "sent_at": "2026-09-03T00:00:00.000Z",
      "received_at": "2026-09-03T00:00:03.000Z",
      "body_text": "plain SMS text, or MMS text part projection",
      "attachment_refs": [],
      "read_state": "unknown",
      "permalink": null,
      "raw_ref": {
        "device_ref": "<device-label>",
        "local_provider": "sms",
        "local_ref": "<opaque local row/part ref>"
      },
      "ingest_batch_id": "android-sms-mms-<device-label>-<timestamp-or-uuid>"
    }
  ]
}
```

Response shape:

```json
{
  "ok": true,
  "accepted_count": 10,
  "deduped_count": 2,
  "latest_batch_id": "android-sms-mms-device-20260903T000003Z",
  "cursor_commit": {
    "sms_high_watermark": "<server-accepted cursor>",
    "mms_high_watermark": "<server-accepted cursor>",
    "last_message_id": "<last accepted normalized id>"
  }
}
```

Backend requirements:

- Authenticate every upload with a device-scoped token; no unauthenticated LAN trust.
- Reject missing/invalid `schema_version`, `source`, `account_ref`, `message_id`, timestamps, and cursor fields.
- Reuse canonical dedupe key: `source + account_ref + message_id`.
- Append accepted envelopes to immutable snapshots before projection, matching the existing storage ADR.
- Never return raw SMS/MMS bodies in status/dashboard endpoints. Query APIs may return normalized messages only through the authenticated inbox UI/API.
- Redact or hash sender phone numbers in logs and health details.
- Cursor acceptance must be transactional with accepted message persistence; do not advance the cursor past rejected records.

## Envelope mapping

| Normalized field | SMS mapping | MMS mapping |
| --- | --- | --- |
| `source` | `android-sms-mms` | `android-sms-mms` |
| `account_ref` | `android-sms-mms/<device-label>` | same |
| `conversation_id` | deterministic hash from device label + normalized address set or Telephony thread id | same, using MMS thread/address data where available |
| `conversation_title` | contact label only if user approved local contact lookup; otherwise redacted phone tail/unknown | same |
| `thread_id` | Telephony thread id as string, if available | Telephony MMS thread id as string, if available |
| `message_id` | stable deterministic id from provider row id + date + type + address hash; avoid autoincrement alone if exports may be restored | stable id from MMS provider id + date + address hash |
| `sender` | inbound address hash/display; outbound/self messages only if historical import is approved | MMS sender/address hash/display |
| `sent_at` | provider message timestamp normalized to UTC ISO-8601 | MMS timestamp normalized to UTC ISO-8601 |
| `received_at` | app ingestion/upload staging time | app ingestion/upload staging time |
| `body_text` | SMS body | text/plain MMS part projection only; null if binary-only |
| `attachment_refs` | usually empty | metadata refs for MMS parts: local opaque id, content type, filename if safe, size if known |
| `read_state` | `unknown` unless provider read flag is safely read; never write read state | same |
| `permalink` | null | null |
| `raw_ref` | opaque local provider coordinate, not raw payload | opaque local MMS/part coordinate, not binary payload |
| `ingest_batch_id` | app-generated batch id | app-generated batch id |

Phone-number handling decision: store the minimum display value needed for Ben's UI. Prefer deterministic hashes for identity and redacted display handles unless Ben explicitly approves full-number display/storage. If full numbers are required for usefulness, that is a separate privacy decision gate before personal-device deployment.

## Conversation IDs

The conversation id must be stable enough for query grouping but must not leak unnecessary phone numbers.

Recommended algorithm:

1. Normalize the participant set for the message:
   - inbound one-to-one: `{self_device_ref, sender_address}`;
   - outbound imported historical message: `{self_device_ref, recipient_address}`;
   - group MMS: sorted set of participant addresses where available.
2. Hash normalized addresses with a backend/device-local salt that is not committed.
3. Format as `android-sms-mms:<device-label>:<hash>`.
4. Keep Telephony `thread_id` separately in normalized `thread_id` for debugging/cursor use; do not rely on it alone across backup/restore/device migration.

## Dedupe and sync cursors

Dedupe:

- Backend canonical key remains `source + account_ref + message_id`.
- App should maintain a local sent/accepted id cache to avoid repeated uploads after retries.
- Backend must still dedupe because clients lie accidentally, especially when tired and full of SQLite.

Cursor strategy:

- Maintain separate SMS and MMS high-watermarks because provider tables and delivery paths differ.
- Cursor fields should be opaque strings from the app's perspective and non-secret from Git's perspective, but runtime cursor values must not be committed or logged.
- A cursor advances only after the backend acknowledges accepted records and returns `cursor_commit`.
- On partial batch rejection, retry rejected records without advancing past them.
- On app reinstall/device restore, perform a bounded reconciliation import only after explicit user approval and with max lookback/max records.

## Attachment handling

MMS attachments are privacy- and storage-sensitive. Baseline implementation must be metadata-only:

- `attachment_refs[].id`: opaque local part id or hashed part coordinate;
- `name`: safe filename if present, otherwise null/generated label;
- `content_type`: MIME type from provider if available;
- `size`: byte size if available;
- `upstream_url_ref`: null for local device parts.

Do not upload binary MMS parts in the first implementation. A later card must define binary retention, encryption, malware scanning expectations, dashboard display rules, and NAS backup implications before enabling binary upload.

## What can and cannot be verified in the headless emulator

Can verify in emulator/headless CI:

- Manifest contains the expected receivers/services/activities and no accidental broad non-SMS permissions.
- Flutter UI has no compose/reply/send/delete/archive/mark-read controls.
- Default-role gate code handles `available`, `held`, `not held`, denied, and unavailable states via fakes/mocks.
- Envelope mapping for synthetic SMS/MMS provider rows.
- Dedupe behavior and cursor advancement/retry logic.
- Backend rejects unauthenticated uploads and invalid schemas.
- Backend persists accepted synthetic batches to snapshots and exposes sanitized status.
- Logs/tests/fixtures contain no real phone numbers, message bodies, tokens, local paths, or raw provider dumps.
- Debug APK builds.

Cannot fully verify in headless emulator alone:

- Ben's carrier/OEM behavior for SMS/MMS delivery.
- Real default-SMS role switching UX on Ben's personal device.
- MMS carrier download behavior and group MMS edge cases.
- Battery/background execution behavior on Ben's device.
- Whether Android/Play policy will accept a default SMS handler whose send affordances are disabled for a private/homelab read-only app.
- Human acceptability of storing full phone numbers/message bodies in the homelab backend.

Anything in the second list requires explicit human/device approval or a separate physical-device test plan. Do not launder it through an emulator screenshot and call it done.

## Approval gates

| Gate | Required before | Approval owner/action |
| --- | --- | --- |
| Design review | Any SMS/MMS implementation card starts | This document reviewed/accepted by downstream reviewer. |
| Manifest/permission review | Merge of implementation that declares SMS/MMS/default-handler components | Reviewer verifies permissions, role flow, and no send path. |
| Backend upload-token provisioning | Any non-fixture Android upload to backend | Ben/operator creates Vaultwarden item/fields and runtime secret, not Git. |
| Physical-device install | Installing APK on Ben's personal device | Ben explicitly approves device install for this app/build. |
| Default SMS handler switch | Launching role request on Ben's device or asking him to accept it | Ben explicitly approves the default-handler change after reading the consent screen. |
| Historical provider import | Reading existing SMS/MMS history beyond new incoming messages | Ben chooses import window and confirms privacy/storage cost. |
| Full phone-number storage/display | Persisting unredacted numbers beyond local device staging | Ben explicitly approves. Default is hash/redact. |
| MMS binary upload | Uploading MMS attachments/content bytes to backend/NAS | Separate storage/security design accepted. |
| Any sending/reply capability | Adding compose/send/respond-via-message behavior | New two-way messaging epic; out of scope here. |

## Implementation acceptance criteria for `t_c478cbe9`

A later implementation card is acceptable only if all relevant criteria are met:

1. Android implementation uses `RoleManager.ROLE_SMS` / sanctioned legacy fallback for default-handler request and does not prompt automatically on first launch.
2. Permission requests are gated behind explicit local consent and default-handler flow ordering.
3. Manifest declarations are documented and tested, including SMS deliver receiver, MMS WAP push receiver, required `SENDTO`/respond-via-message eligibility components, and protected receiver/service permissions.
4. Existing read-only client UI remains read-only: no compose/reply/send/delete/archive/mark-read controls.
5. Any required SMS-send-looking Android component safely declines or displays a disabled read-only explanation; it does not send messages.
6. SMS/MMS synthetic fixtures map to the canonical normalized envelope with `source = "android-sms-mms"`.
7. Conversation id generation is deterministic and does not require storing raw phone numbers by default.
8. Backend upload endpoint is authenticated, schema-validated, and dedupes with `source + account_ref + message_id`.
9. Sync cursors advance only after backend acknowledgment; retry and partial rejection cases are tested.
10. MMS binary content is not uploaded; only attachment metadata refs are produced.
11. Local staging/cursor state is encrypted at rest or the implementation blocks with a clear reason if platform storage cannot satisfy this yet.
12. Backend status/dashboard surfaces Android SMS/MMS connector states without message bodies, phone numbers, local paths, or secrets.
13. Tests cover default-role states, permission-denied path, envelope mapping, dedupe, cursor retry, unauthenticated upload rejection, and absence of mutating UI/API paths.
14. Verification includes Flutter analyze/test/build, backend tests if touched, `git diff --check`, and a secret/PII fixture scan.
15. Handoff clearly separates emulator-verified behavior from physical-device/manual approval items.

## Dashboard/status expectation

Completion visibility is applicable. The implementation must expose operator-visible status, preferably through the existing Home Dashboard Unified Inbox surface once backend support exists:

- `android-sms-mms` connector state: `disabled`, `role_required`, `permission_required`, `sync_pending`, `ok`, `degraded`, or `error`;
- last successful device sync time;
- queued local count if safely reportable;
- accepted/deduped count for latest backend batch;
- explicit text that personal WhatsApp/Instagram DMs remain excluded;
- no message bodies, phone numbers, local provider URIs, local paths, or secret refs in dashboard JSON.

## Open questions deliberately deferred

- Whether Ben wants unredacted phone numbers in the backend UI or only redacted labels/hashes.
- Whether historical import should be enabled at all, and if so what lookback window is acceptable.
- Whether MMS binary upload is worth the storage/security burden.
- Whether this app will remain private sideload/homelab-only or ever need Play policy compliance. If Play distribution becomes a goal, default SMS handler policy review becomes a separate gate.
