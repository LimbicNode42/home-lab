// Discord read-only connector.
//
// Read-only by construction: this connector consumes an already-connected
// Discord/Hermes gateway's sanctioned state or a bot's bounded REST *read*
// backfill (GET channels/messages). It issues NO send, reply, react, delete,
// archive, mark-read, or any other mutating Discord API call, and exposes no
// mutator methods.
//
// IMPORTANT: Ben already runs a Discord-connected Hermes gateway. This connector
// does NOT modify or restart the gateway config. It has two sanctioned modes:
//   1. `adapter` mode — a supplied read-only adapter (bot REST read or gateway
//      state export) is consumed as-is. The adapter is responsible for returning
//      bounded, already-sanctioned state.
//   2. `disabled` — no adapter configured; health reports `not_configured` honestly.
//
// Credentials are materialized by the operator from Vaultwarden folder `homelab`,
// item `unified-inbox/discord/<account-or-workspace>` (fields `bot_token`,
// `application_id`, `guild_id_allowlist`, `channel_id_allowlist`) and handed in via
// `config` at construction. Only reference/field names appear in repo and docs.
//
// Sync cursors (last read message id per channel) are sensitive runtime state,
// never committed artifacts — see cursor-state.js.

import { ReadOnlyMessageStream } from './stream.js';
import { assertConfigShape, sanitizeConfig } from './config.js';
import { resolveLimits, startRuntimeClock } from './limits.js';
import { normalizeCursor } from './cursor-state.js';
import { fallbackConversationId, makeSender, plainTextProjection, toUtcIsoTimestamp } from './normalize-helpers.js';

export const DISCORD_CONFIG = {
  bot_token: { type: 'secret' },
  application_id: { type: 'optionalNonSecret' },
  guild_id_allowlist: { type: 'allowlist' },
  channel_id_allowlist: { type: 'allowlist' }
};

// Deterministic conflict between the ADR source label `discord` and the fact that
// a gateway may map to a specific home server. Source id is stable: `discord`.
export const DISCORD_SOURCE = 'discord';

export class DiscordMessageStream extends ReadOnlyMessageStream {
  constructor({ accountRef = 'home-server-bot', config, adapter, now = () => new Date().toISOString() }) {
    super({ source: DISCORD_SOURCE, accountRef });
    assertConfigShape(DISCORD_CONFIG, config);
    this.config = config;
    this.adapter = adapter;
    this.now = now;
    this._lastSuccessAt = null;
    this._lastErrorCode = null;
  }

  async health() {
    if (!this.adapter) {
      return { state: 'not_configured', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: 'no Discord read adapter/gateway state configured' };
    }
    try {
      const info = await this.adapter.connectionInfo?.() ?? null;
      this._lastSuccessAt = this.now();
      return { state: 'ok', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: info ? `gateway connected (${info})` : 'gateway connected' };
    } catch (error) {
      this._lastErrorCode = error.code ?? 'gateway_failed';
      return { state: 'error', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: this._lastErrorCode, detail: sanitizeConfig(DISCORD_CONFIG, this.config) };
    }
  }

  async *sync(cursor, limits) {
    const { max_messages, max_runtime_ms } = resolveLimits(limits);
    const clock = startRuntimeClock(max_runtime_ms);
    if (!this.adapter) return;

    // The adapter performs read-only backfill: GET /channels/{id}/messages or a
    // sanitized gateway state export. It is responsible for honoring the cursor
    // and ordering (newest-first) and for bounded, rate-limited fetching.
    const summaries = await this.adapter.fetchNew?.({ cursor, allowlist: this.config.channel_id_allowlist, max: max_messages });
    const ingestBatchId = `discord:${this.accountRef}:${Date.now()}`;
    const rawRefs = [];
    for (const summary of summaries ?? []) {
      if (clock.expired() || rawRefs.length >= max_messages) break;
      rawRefs.push({
        message_id: summary.id ?? summary.message_id ?? null,
        channel_id: summary.channel_id ?? null,
        guild_id: summary.guild_id ?? null,
        thread_id: summary.thread_id ?? summary.channel_id ?? null,
        ingest_batch_id: ingestBatchId
      });
    }

    this._lastSuccessAt = this.now();
    this._lastErrorCode = null;

    yield {
      ingest_batch_id: ingestBatchId,
      cursor_before: normalizeCursor(cursor?.connector_cursor ?? null),
      cursor_after: normalizeCursor(rawRefs.length ? rawRefs[0].message_id : (cursor?.connector_cursor ?? null)),
      raw_refs: rawRefs
    };
  }

  async normalize(rawRef) {
    const detail = await this.adapter.fetchOne?.({ messageId: rawRef.message_id, channelId: rawRef.channel_id });
    const author = detail?.author ?? {};
    const content = detail?.content ?? detail?.text ?? null;
    const sentAt = toUtcIsoTimestamp(detail?.timestamp ?? detail?.sent_at) ?? this.now();
    const receivedAt = this.now();

    // Cursor/thread identity: Discord message id + channel id. A thread message
    // shares the channel (thread) id; we surface thread_id = channel_id for thread
    // context, but conversation_id = channel_id so all messages in a channel/thread
    // group together.
    const channelId = rawRef.channel_id ?? detail?.channel_id ?? null;
    const messageId = rawRef.message_id ?? detail?.id ?? null;
    const threadId = detail?.thread_id ?? rawRef.thread_id ?? null;

    return {
      source: DISCORD_SOURCE,
      account_ref: this.accountRef,
      conversation_id: fallbackConversationId(DISCORD_SOURCE, this.accountRef, channelId ?? 'unknown-channel'),
      conversation_title: detail?.channel_name ?? detail?.guild_name ?? null,
      thread_id: threadId ? String(threadId) : null,
      message_id: String(messageId),
      sender: makeSender({ id: author.id ?? null, display_name: author.name ?? author.global_name ?? author.username ?? null, handle: author.username ?? null }),
      sent_at: sentAt,
      received_at: receivedAt,
      body_text: plainTextProjection(content),
      attachment_refs: (detail?.attachments ?? []).map((a) => ({
        id: a.id ?? null,
        name: a.filename ?? a.name ?? null,
        content_type: a.content_type ?? null,
        size: a.size ?? null,
        upstream_url_ref: a.url ?? null
      })),
      read_state: 'unknown',
      permalink: detail?.jump_url ?? null,
      raw_ref: { message_id: messageId, channel_id: channelId, guild_id: rawRef.guild_id ?? null },
      ingest_batch_id: rawRef.ingest_batch_id ?? null
    };
  }
}