// Email IMAP read-only connector.
//
// Read-only by construction: this connector issues LOGIN, SELECT, SEARCH, and
// FETCH only. It never sends STORE +FLAGS, EXPUNGE, DELETE, COPY, MOVE, APPEND,
// or any mutating command, and it exposes no mutator methods. Read-state is
// derived from the upstream `\\Seen` flag and reported, never written back.
//
// Credentials are materialized by the operator (from Vaultwarden folder
// `homelab`, item `unified-inbox/email-imap/<account>`) and handed to this
// connector via `config` at construction. They are never logged, emitted, or
// persisted. Only reference/field names appear in repo and docs.

import { ReadOnlyMessageStream } from './stream.js';
import { assertConfigShape, sanitizeConfig } from './config.js';
import { resolveLimits, startRuntimeClock } from './limits.js';
import { fallbackConversationId, makeSender, plainTextProjection, toUtcIsoTimestamp } from './normalize-helpers.js';

export const IMAP_CONFIG = {
  imap_host: { type: 'nonSecret' },
  imap_port: { type: 'nonSecret' },
  imap_username: { type: 'nonSecret' },
  imap_password_or_oauth_ref: { type: 'secret' },
  imap_tls_mode: { type: 'optionalNonSecret' },
  mailbox: { type: 'optionalNonSecret' }
};

const DEFAULT_MAILBOX = 'INBOX';

// Maps upstream flags (read-only observation) to the envelope read_state enum.
function readStateFromFlags(flags) {
  const set = new Set((flags ?? []).map((f) => String(f).toLowerCase()));
  return set.has('\\seen') || set.has('seen') ? 'read' : 'unread';
}

export function stableMessageId({ messageId, uid, mailbox, uidValidity }) {
  if (messageId && String(messageId).trim() !== '') return String(messageId).trim();
  // Message-ID header absent: fall back to a deterministic mailbox+UID identity.
  return `${mailbox}__${uidValidity ?? ''}__${uid}`;
}

export class ImapMessageStream extends ReadOnlyMessageStream {
  constructor({ accountRef, config, adapter, now = () => new Date().toISOString() }) {
    super({ source: 'email-imap', accountRef });
    assertConfigShape(IMAP_CONFIG, config);
    this.config = config;
    this.adapter = adapter;
    this.now = now;
    this.mailbox = config.mailbox || DEFAULT_MAILBOX;
    this._lastSuccessAt = null;
    this._lastErrorCode = null;
  }

  async health() {
    if (!this.adapter) {
      return { state: 'disabled', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: 'no IMAP adapter configured' };
    }
    try {
      const info = await this.adapter.capability?.() ?? null;
      this._lastSuccessAt = this.now();
      return { state: 'ok', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: info ? `connected (${info})` : 'connected' };
    } catch (error) {
      this._lastErrorCode = error.code ?? 'health_failed';
      return { state: 'error', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: this._lastErrorCode, detail: sanitizeConfig(IMAP_CONFIG, this.config) };
    }
  }

  async *sync(cursor, limits) {
    const { max_messages, max_runtime_ms } = resolveLimits(limits);
    const clock = startRuntimeClock(max_runtime_ms);
    if (!this.adapter) return;

    const mailbox = this.mailbox;
    await this.adapter.connect?.();
    try {
      await this.adapter.authenticate?.({ username: this.config.imap_username });
      const selected = await this.adapter.select?.({ mailbox });
      const uidValidity = selected?.uidValidity ?? null;
      const ingestBatchId = `email-imap:${this.accountRef}:${uidValidity ?? 'novalidity'}:${Date.now()}`;

      // Fetch a bounded list of message summaries. The adapter is responsible
      // for ordering (newest-first) and honoring cursor (by UID or high-water).
      const summaries = await this.adapter.fetchNew?.({ mailbox, cursor, max: max_messages });
      const rawRefs = [];
      for (const summary of summaries ?? []) {
        if (clock.expired() || rawRefs.length >= max_messages) break;
        const messageId = stableMessageId({ messageId: summary.messageId, uid: summary.uid, mailbox, uidValidity });
        rawRefs.push({
          uid: summary.uid,
          mailbox,
          uid_validity: uidValidity,
          message_id: messageId,
          flags: summary.flags ?? [],
          ingest_batch_id: ingestBatchId
        });
      }

      this._lastSuccessAt = this.now();
      this._lastErrorCode = null;
      yield {
        ingest_batch_id: ingestBatchId,
        cursor_before: cursor,
        cursor_after: {
          connector_cursor: rawRefs.length ? String(rawRefs[0].uid) : (cursor?.connector_cursor ?? null),
          high_watermark_sent_at: null,
          last_message_id: rawRefs.length ? rawRefs[0].message_id : null
        },
        raw_refs: rawRefs
      };
    } finally {
      await this.adapter.close?.();
    }
  }

  async normalize(rawRef) {
    // Fetch full message (body) using the raw_ref coordinate. No mutation.
    const detail = await this.adapter.fetchOne?.({ uid: rawRef.uid, mailbox: rawRef.mailbox ?? this.mailbox });
    const from = detail?.from ?? {};
    const conversationTitle = detail?.subject != null ? String(detail.subject) : null;
    const sentAt = toUtcIsoTimestamp(detail?.date) ?? toUtcIsoTimestamp(detail?.receivedDate) ?? this.now();
    const receivedAt = this.now();

    return {
      source: 'email-imap',
      account_ref: this.accountRef,
      conversation_id: fallbackConversationId('email-imap', this.accountRef, rawRef.mailbox ?? this.mailbox),
      conversation_title: conversationTitle,
      thread_id: detail?.inReplyTo ? String(detail.inReplyTo) : (rawRef.in_reply_to ?? null),
      message_id: rawRef.message_id,
      sender: makeSender({ id: from.address ?? null, display_name: from.name ?? null, handle: from.address ?? null }),
      sent_at: sentAt,
      received_at: receivedAt,
      body_text: plainTextProjection(detail?.text),
      attachment_refs: (detail?.attachments ?? []).map((a) => ({
        id: a.id ?? null,
        name: a.name ?? null,
        content_type: a.contentType ?? null,
        size: a.size ?? null,
        upstream_url_ref: a.upstreamUrlRef ?? null
      })),
      read_state: readStateFromFlags(rawRef.flags ?? detail?.flags),
      permalink: null,
      raw_ref: { uid: rawRef.uid, mailbox: rawRef.mailbox ?? this.mailbox, uid_validity: rawRef.uid_validity ?? null, message_id: rawRef.message_id },
      ingest_batch_id: rawRef.ingest_batch_id ?? null
    };
  }
}