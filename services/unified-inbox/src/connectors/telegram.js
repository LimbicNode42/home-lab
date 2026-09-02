// Telegram read-only connector.
//
// Read-only by construction: this connector consumes the official Telegram Bot
// API read surface only — `getUpdates` (poll) and retrieved chat/message data.
// It NEVER calls `sendMessage`, `deleteMessage`, `editMessage*`, `forwardMessage`,
// or any mutating Bot API method, and it exposes no mutator methods.
//
// Sanctioned API only: official Telegram Bot API. No MTProto/user-account
// scraping and no unofficial bridges. A bot only sees chats it has been added to;
// personal 1:1 history is not in scope.
//
// Credentials are materialized by the operator from Vaultwarden folder `homelab`,
// item `unified-inbox/telegram/<account-or-bot>` (fields `bot_token`,
// `webhook_secret_ref`). Only reference/field names appear in repo and docs.
//
// The `update_id` high-watermark cursor is sensitive runtime state (see
// cursor-state.js); it is never committed or emitted as a credential.

import { ReadOnlyMessageStream } from './stream.js';
import { assertConfigShape, sanitizeConfig } from './config.js';
import { resolveLimits, startRuntimeClock, FixedIntervalLimiter } from './limits.js';
import { normalizeCursor } from './cursor-state.js';
import { fallbackConversationId, makeSender, plainTextProjection, toUtcIsoTimestamp } from './normalize-helpers.js';

export const TELEGRAM_CONFIG = {
  bot_token: { type: 'secret' },
  webhook_secret_ref: { type: 'optionalNonSecret' },
  min_interval_ms: { type: 'optionalNonSecret' }
};

export const TELEGRAM_SOURCE = 'telegram';

export class TelegramMessageStream extends ReadOnlyMessageStream {
  constructor({ accountRef = 'home-bot', config, adapter, now = () => new Date().toISOString() }) {
    super({ source: TELEGRAM_SOURCE, accountRef });
    assertConfigShape(TELEGRAM_CONFIG, config);
    this.config = config;
    this.adapter = adapter;
    this.now = now;
    this.limiter = new FixedIntervalLimiter({ minIntervalMs: Number(config.min_interval_ms) || 1000 });
    this._lastSuccessAt = null;
    this._lastErrorCode = null;
  }

  async health() {
    if (!this.adapter) {
      return { state: 'not_configured', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: 'no Telegram Bot API adapter configured' };
    }
    try {
      const me = await this.adapter.getMe?.() ?? null;
      this._lastSuccessAt = this.now();
      return { state: 'ok', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: me?.username ? `bot @${me.username}` : 'bot reachable' };
    } catch (error) {
      this._lastErrorCode = error.code ?? 'get_me_failed';
      return { state: 'error', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: this._lastErrorCode, detail: sanitizeConfig(TELEGRAM_CONFIG, this.config) };
    }
  }

  async *sync(cursor, limits) {
    const { max_messages, max_runtime_ms } = resolveLimits(limits);
    const clock = startRuntimeClock(max_runtime_ms);
    if (!this.adapter) return;

    await this.limiter.waitUntilReady();

    // getUpdates with an offset strictly greater than the last-seen update_id.
    // The adapter is read-only and returns update summaries (no file download).
    const offset = cursor?.connector_cursor != null ? Number(cursor.connector_cursor) + 1 : undefined;
    const updates = await this.adapter.getUpdates?.({ offset, max: max_messages });

    const ingestBatchId = `telegram:${this.accountRef}:${Date.now()}`;
    const rawRefs = [];
    for (const update of updates ?? []) {
      if (clock.expired() || rawRefs.length >= max_messages) break;
      rawRefs.push({
        update_id: update.update_id ?? null,
        message_id: update.message_id ?? update.message?.message_id ?? null,
        chat_id: update.chat_id ?? update.message?.chat?.id ?? null,
        ingest_batch_id: ingestBatchId
      });
    }

    this._lastSuccessAt = this.now();
    this._lastErrorCode = null;

    yield {
      ingest_batch_id: ingestBatchId,
      cursor_before: normalizeCursor(cursor?.connector_cursor ?? null),
      cursor_after: normalizeCursor(rawRefs.length ? String(rawRefs[0].update_id) : (cursor?.connector_cursor ?? null)),
      raw_refs: rawRefs
    };
  }

  async normalize(rawRef) {
    const detail = await this.adapter.fetchOne?.({ chat_id: rawRef.chat_id, message_id: rawRef.message_id });
    const from = detail?.from ?? {};
    const chat = detail?.chat ?? {};
    const text = detail?.text ?? null;
    const sentAt = toUtcIsoTimestamp(detail?.date_seconds != null ? detail.date_seconds * 1000 : detail?.date) ?? toUtcIsoTimestamp(detail?.date) ?? this.now();
    const receivedAt = this.now();

    return {
      source: TELEGRAM_SOURCE,
      account_ref: this.accountRef,
      conversation_id: fallbackConversationId(TELEGRAM_SOURCE, this.accountRef, rawRef.chat_id ?? 'unknown-chat'),
      conversation_title: chat.title ?? from.username ?? from.first_name ?? null,
      thread_id: detail?.message_thread_id != null ? String(detail.message_thread_id) : null,
      message_id: String(rawRef.message_id),
      sender: makeSender({ id: from.id ?? null, display_name: from.first_name ?? null, handle: from.username ?? null }),
      sent_at: sentAt,
      received_at: receivedAt,
      body_text: plainTextProjection(text),
      attachment_refs: [],
      read_state: 'unknown',
      permalink: null,
      raw_ref: { update_id: rawRef.update_id, chat_id: rawRef.chat_id, message_id: rawRef.message_id },
      ingest_batch_id: rawRef.ingest_batch_id ?? null
    };
  }
}