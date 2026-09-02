// Slack read-only connector.
//
// Read-only by construction: this connector consumes the official Slack Web API /
// Events API read surface only — `conversations.history` / `conversations.list`
// reads. It NEVER calls `chat.postMessage`, `chat.delete`, `reactions.add`,
// `conversations.archive`, or any other mutating Slack API method, and it exposes
// no mutator methods.
//
// Sanctioned API only: official Slack app/bot API. Read-only scopes only
// (`channels:history`, `groups:history`, `im:history`, `mpim:history`) where
// approved; explicitly NO `chat:write`. No token scraping or unofficial bridges.
//
// Credentials are materialized by the operator from Vaultwarden folder `homelab`,
// item `unified-inbox/slack/<workspace>` (fields `bot_token`, `signing_secret`,
// `app_id`, `workspace_id`). Only reference/field names appear in repo and docs.
//
// Slack per-conversation cursors and thread_ts are sensitive runtime state
// (see cursor-state.js); they are never committed or emitted as a credential.

import { ReadOnlyMessageStream } from './stream.js';
import { assertConfigShape, sanitizeConfig } from './config.js';
import { resolveLimits, startRuntimeClock, FixedIntervalLimiter } from './limits.js';
import { normalizeCursor } from './cursor-state.js';
import { fallbackConversationId, makeSender, plainTextProjection, toUtcIsoTimestamp } from './normalize-helpers.js';

export const SLACK_CONFIG = {
  bot_token: { type: 'secret' },
  signing_secret: { type: 'secret' },
  app_id: { type: 'optionalNonSecret' },
  workspace_id: { type: 'optionalNonSecret' },
  channel_id_allowlist: { type: 'allowlist' },
  min_interval_ms: { type: 'optionalNonSecret' }
};

export const SLACK_SOURCE = 'slack';

// Slack conversation types that represent a direct/group message channel versus a
// public channel. Both are in scope only with the corresponding approved read scope.
const DM_CONVERSATION_TYPES = new Set(['im', 'mpim']);
const GROUP_CONVERSATION_TYPE = 'group';

export class SlackMessageStream extends ReadOnlyMessageStream {
  constructor({ accountRef = 'workspace-bot', config, adapter, now = () => new Date().toISOString() }) {
    super({ source: SLACK_SOURCE, accountRef });
    assertConfigShape(SLACK_CONFIG, config);
    this.config = config;
    this.adapter = adapter;
    this.now = now;
    this.limiter = new FixedIntervalLimiter({ minIntervalMs: Number(config.min_interval_ms) || 1000 });
    this._lastSuccessAt = null;
    this._lastErrorCode = null;
  }

  async health() {
    if (!this.adapter) {
      return { state: 'not_configured', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: 'no Slack Web API adapter configured' };
    }
    try {
      const info = await this.adapter.authTest?.() ?? null;
      this._lastSuccessAt = this.now();
      return { state: 'ok', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: info?.url ? `workspace ${info.url}` : 'workspace reachable' };
    } catch (error) {
      this._lastErrorCode = error.code ?? 'auth_test_failed';
      return { state: 'error', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: this._lastErrorCode, detail: sanitizeConfig(SLACK_CONFIG, this.config) };
    }
  }

  async *sync(cursor, limits) {
    const { max_messages, max_runtime_ms } = resolveLimits(limits);
    const clock = startRuntimeClock(max_runtime_ms);
    if (!this.adapter) return;

    await this.limiter.waitUntilReady();

    // conversations.history read: pass the prior per-conversation cursor; the
    // adapter returns a bounded list of messages in the conversation (oldest→newest
    // upstream; we store newest-first for a consistent high-watermark), newest-first.
    const result = await this.adapter.fetchHistory?.({ cursor, allowlist: this.config.channel_id_allowlist, max: max_messages }) ?? {};
    const messages = result.messages ?? [];
    const nextCursor = result.cursor ?? null;

    const ingestBatchId = `slack:${this.accountRef}:${Date.now()}`;
    const rawRefs = [];
    // Slack returns oldest→newest; reverse so rawRefs[0] is the newest (high-watermark).
    const ordered = [...messages].reverse();
    for (const message of ordered) {
      if (clock.expired() || rawRefs.length >= max_messages) break;
      rawRefs.push({
        ts: message.ts ?? null,
        thread_ts: message.thread_ts ?? null,
        channel: message.channel ?? null,
        ingest_batch_id: ingestBatchId
      });
    }

    this._lastSuccessAt = this.now();
    this._lastErrorCode = null;

    yield {
      ingest_batch_id: ingestBatchId,
      cursor_before: normalizeCursor(cursor?.connector_cursor ?? null),
      cursor_after: normalizeCursor(nextCursor ?? (rawRefs.length ? rawRefs[0].ts : (cursor?.connector_cursor ?? null))),
      raw_refs: rawRefs
    };
  }

  async normalize(rawRef) {
    const detail = await this.adapter.fetchOne?.({ channel: rawRef.channel, ts: rawRef.ts });
    const text = detail?.text ?? null;
    const user = detail?.user ?? null;
    const channel = detail?.channel ?? rawRef.channel ?? null;
    const channelName = detail?.channel_name ?? null;
    const sentAt = toUtcIsoTimestamp(rawRef.ts ?? detail?.ts) ?? this.now();
    const receivedAt = this.now();

    // Thread grouping: thread_ts when present identifies a thread; otherwise the
    // top-level message ts. conversation_id = channel; thread_id = thread_ts.
    const threadTs = rawRef.thread_ts ?? detail?.thread_ts ?? null;

    return {
      source: SLACK_SOURCE,
      account_ref: this.accountRef,
      conversation_id: fallbackConversationId(SLACK_SOURCE, this.accountRef, channel ?? 'unknown-channel'),
      conversation_title: channelName ?? null,
      thread_id: threadTs ? String(threadTs) : null,
      message_id: String(rawRef.ts ?? detail?.ts),
      sender: makeSender({ id: user ?? null, display_name: null, handle: null }),
      sent_at: sentAt,
      received_at: receivedAt,
      body_text: plainTextProjection(text),
      attachment_refs: (detail?.files ?? []).map((f) => ({
        id: f.id ?? null,
        name: f.name ?? null,
        content_type: f.mimetype ?? null,
        size: f.size ?? null,
        upstream_url_ref: f.url_private_download ?? null
      })),
      read_state: 'unknown',
      permalink: detail?.permalink ?? null,
      raw_ref: { ts: rawRef.ts, thread_ts: threadTs, channel, conversation_type: detail?.conversation_type ?? null },
      ingest_batch_id: rawRef.ingest_batch_id ?? null
    };
  }
}

// Exported for tests/docs to verify the read-only scope mapping.
export { DM_CONVERSATION_TYPES, GROUP_CONVERSATION_TYPE };