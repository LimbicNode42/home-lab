// Matrix read-only connector.
//
// Read-only by construction: this connector consumes the Matrix Client-Server API
// read surface only — `GET /sync` (incremental) with a `since` token. It NEVER
// calls `PUT /send`, redact, delete, room create/join/leave, or any other mutating
// C-S API method, and it exposes no mutator methods.
//
// Sanctioned API only: official Matrix Client-Server API, using a dedicated
// logged-in client session/account. No bridges, puppets, or account scraping.
//
// Credentials are materialized by the operator from Vaultwarden folder `homelab`,
// item `unified-inbox/matrix/<account>` (fields `homeserver_url`, `access_token`,
// `user_id`, `device_id`). Only reference/field names appear in repo and docs.
//
// The Matrix `since` token is sensitive runtime state (see cursor-state.js); it is
// never committed or emitted as a credential. E2EE rooms are out of scope: encrypted
// events are surfaced as an explicit `unsupported` health state, not silently
// dropped or decrypted.

import { ReadOnlyMessageStream } from './stream.js';
import { assertConfigShape, sanitizeConfig } from './config.js';
import { resolveLimits, startRuntimeClock, FixedIntervalLimiter } from './limits.js';
import { normalizeCursor } from './cursor-state.js';
import { fallbackConversationId, makeSender, plainTextProjection, toUtcIsoTimestamp } from './normalize-helpers.js';

export const MATRIX_CONFIG = {
  homeserver_url: { type: 'nonSecret' },
  access_token: { type: 'secret' },
  user_id: { type: 'optionalNonSecret' },
  device_id: { type: 'optionalNonSecret' },
  min_interval_ms: { type: 'optionalNonSecret' }
};

export const MATRIX_SOURCE = 'matrix';

// Event types that indicate an upstream edit/delete/redact. These carry no new
// message body; they exist to preserve the original immutable event plus a later
// status marker (per the ADR). We surface them but do not mutate anything.
const MUTATION_EVENT_TYPES = new Set(['m.room.redaction', 'm.room.message.edit', 'm.room.tombstone']);

export class MatrixMessageStream extends ReadOnlyMessageStream {
  constructor({ accountRef = 'home-account', config, adapter, now = () => new Date().toISOString() }) {
    super({ source: MATRIX_SOURCE, accountRef });
    assertConfigShape(MATRIX_CONFIG, config);
    this.config = config;
    this.adapter = adapter;
    this.now = now;
    this.limiter = new FixedIntervalLimiter({ minIntervalMs: Number(config.min_interval_ms) || 1000 });
    this._lastSuccessAt = null;
    this._lastErrorCode = null;
    this._encryptedRoomsSeen = 0;
  }

  async health() {
    if (!this.adapter) {
      return { state: 'not_configured', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: 'no Matrix C-S API adapter configured' };
    }
    try {
      const info = await this.adapter.whoami?.() ?? null;
      this._lastSuccessAt = this.now();
      return { state: 'ok', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: info?.user_id ? `session ${info.user_id}` : 'session reachable' };
    } catch (error) {
      this._lastErrorCode = error.code ?? 'whoami_failed';
      return { state: 'error', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: this._lastErrorCode, detail: sanitizeConfig(MATRIX_CONFIG, this.config) };
    }
  }

  async *sync(cursor, limits) {
    const { max_messages, max_runtime_ms } = resolveLimits(limits);
    const clock = startRuntimeClock(max_runtime_ms);
    if (!this.adapter) return;

    await this.limiter.waitUntilReady();

    // Incremental sync: pass the prior `since` token; the adapter returns the
    // next `since` token and a bounded list of timeline events, newest-first.
    const since = cursor?.connector_cursor ?? null;
    const result = await this.adapter.sync?.({ since, max: max_messages });
    const events = result?.events ?? [];
    const nextSince = result?.since ?? since;

    const ingestBatchId = `matrix:${this.accountRef}:${Date.now()}`;
    const rawRefs = [];
    for (const event of events) {
      if (clock.expired() || rawRefs.length >= max_messages) break;
      rawRefs.push({
        event_id: event.event_id ?? null,
        room_id: event.room_id ?? null,
        sender: event.sender ?? null,
        type: event.type ?? null,
        origin_server_ts: event.origin_server_ts ?? null,
        ingest_batch_id: ingestBatchId
      });
    }

    this._lastSuccessAt = this.now();
    this._lastErrorCode = null;

    yield {
      ingest_batch_id: ingestBatchId,
      cursor_before: normalizeCursor(cursor?.connector_cursor ?? null),
      cursor_after: normalizeCursor(nextSince),
      raw_refs: rawRefs
    };
  }

  async normalize(rawRef) {
    const detail = await this.adapter.fetchOne?.({ roomId: rawRef.room_id, eventId: rawRef.event_id });
    const room = detail?.room ?? {};
    const content = detail?.content ?? {};
    const sender = detail?.sender ?? rawRef.sender ?? null;

    // Encrypted events: no key handling in Phase 2. Surface explicitly.
    const isEncrypted = detail?.type === 'm.room.encrypted';
    const isMutation = MUTATION_EVENT_TYPES.has(detail?.type ?? rawRef.type);

    const body = plainTextProjection(content?.body ?? detail?.body ?? null);
    const sentAt = toUtcIsoTimestamp(rawRef.origin_server_ts ?? detail?.origin_server_ts) ?? this.now();
    const receivedAt = this.now();

    if (isEncrypted) this._encryptedRoomsSeen += 1;

    return {
      source: MATRIX_SOURCE,
      account_ref: this.accountRef,
      conversation_id: fallbackConversationId(MATRIX_SOURCE, this.accountRef, rawRef.room_id ?? 'unknown-room'),
      conversation_title: room.name ?? room.canonical_alias ?? null,
      thread_id: null,
      message_id: String(rawRef.event_id),
      sender: makeSender({ id: sender ?? null, display_name: sender ?? null, handle: null }),
      sent_at: sentAt,
      received_at: receivedAt,
      body_text: isEncrypted || isMutation ? null : body,
      attachment_refs: [],
      read_state: 'unknown',
      permalink: null,
      raw_ref: { event_id: rawRef.event_id, room_id: rawRef.room_id, type: detail?.type ?? rawRef.type ?? null, encrypted: isEncrypted },
      ingest_batch_id: rawRef.ingest_batch_id ?? null
    };
  }
}