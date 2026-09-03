// RSS/Atom read-only connector.
//
// Polls a feed URL, parses RSS 2.0 / Atom / RDF feeds, and normalizes items
// into the locked envelope. Idempotent via stable item identity (GUID/link/id
// with a deterministic fallback), bounded by max_messages and a runtime clock,
// and rate-limited by a fixed minimum interval between fetches.
//
// Feed URLs are non-secret for public feeds and may be materialized directly;
// private feed URLs should be referenced via Vaultwarden (folder `homelab`,
// item `unified-inbox/rss/<feed-or-source>`, field `feed_url_ref`). No token,
// key, or signature value is ever stored or emitted.

import { ReadOnlyMessageStream } from './stream.js';
import { assertConfigShape } from './config.js';
import { resolveLimits, startRuntimeClock, FixedIntervalLimiter } from './limits.js';
import { fallbackConversationId, makeSender, plainTextProjection, toUtcIsoTimestamp, hashSlug } from './normalize-helpers.js';

export const RSS_CONFIG = {
  feed_url: { type: 'nonSecret' },
  min_interval_ms: { type: 'optionalNonSecret' }
};

// Stable identity for a feed item. Order of preference matches the ADR:
// GUID/link/id, then a deterministic slug of title+link+published.
export function stableFeedItemId(item) {
  const candidates = [item.guid, item.id, item.link];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  const seed = `${item.title ?? ''}|${item.link ?? ''}|${item.published ?? item.updated ?? ''}`;
  return hashSlug(seed) ? `fallback-${hashSlug(seed)}` : `fallback-${Date.now()}`;
}

// Minimal RSS 2.0 / Atom / RDF parser. Returns an array of item-ish objects.
// Deliberately dependency-free; real feed HTML is not parsed here (body_text is
// a plain-text projection only).
export function parseFeed(xmlText) {
  if (typeof xmlText !== 'string' || xmlText.trim() === '') return { title: null, items: [] };
  const strip = (s) => String(s ?? '').replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  const first = (re) => {
    const m = xmlText.match(re);
    return m ? strip(m[1]) : null;
  };

  const title = first(/<title[^>]*>(.*?)<\/title>/is);
  const itemBlocks = xmlText.match(/<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi) ?? [];

  const items = itemBlocks.map((block) => {
    const field = (names) => {
      for (const n of names) {
        const re = new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i');
        const m = block.match(re);
        if (m) return strip(m[1]);
      }
      return null;
    };
    const link = field(['link']);
    const author = field(['author', 'dc:creator', 'name']);
    const categories = [...block.matchAll(/<category[^>]*>(.*?)<\/category>/gi)].map((m) => strip(m[1])).filter(Boolean);
    return {
      guid: field(['guid', 'id']),
      id: field(['id']),
      title: field(['title']),
      link,
      description: field(['description', 'summary', 'content', 'summary']),
      published: field(['pubDate', 'published', 'updated', 'dc:date', 'date']),
      updated: field(['updated', 'published']),
      author,
      categories
    };
  });

  return { title, items };
}

export class RssMessageStream extends ReadOnlyMessageStream {
  constructor({ accountRef = 'default', config, fetch, parse = parseFeed, now = () => new Date().toISOString() }) {
    super({ source: 'rss', accountRef });
    assertConfigShape(RSS_CONFIG, config);
    this.config = config;
    this.fetch = fetch;
    this.parse = parse;
    this.now = now;
    this.limiter = new FixedIntervalLimiter({ minIntervalMs: Number(config.min_interval_ms) || 1000 });
    this._lastSuccessAt = null;
    this._lastErrorCode = null;
    this._lastFeedTitle = null;
  }

  async health() {
    if (!this.fetch) {
      return { state: 'disabled', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: 'no fetch function configured' };
    }
    try {
      const delay = this.limiter.delayUntilReadyMs();
      if (delay > 0) {
        this._lastErrorCode = 'rate_limited';
        return { state: 'rate_limited', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: 'rate_limited', detail: `next fetch in ${delay}ms` };
      }
      const response = await this.fetch(this.config.feed_url);
      this.limiter.recordAttempt();
      if (!response || response.ok === false) throw new Error(`feed fetch failed (${response?.status ?? 'network'})`);
      const text = await (typeof response.text === 'function' ? response.text() : String(response));
      this.parse(text); // validate parseability
      this._lastSuccessAt = this.now();
      this._lastErrorCode = null;
      return { state: 'ok', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: null, detail: `feed fetchable${this._lastFeedTitle ? ` (${this._lastFeedTitle})` : ''}` };
    } catch (error) {
      this._lastErrorCode = error.code ?? 'fetch_failed';
      return { state: 'error', checked_at: this.now(), last_success_at: this._lastSuccessAt, last_error_code: this._lastErrorCode, detail: error.message };
    }
  }

  async *sync(cursor, limits) {
    const { max_messages, max_runtime_ms } = resolveLimits(limits);
    const clock = startRuntimeClock(max_runtime_ms);
    if (!this.fetch) return;

    await this.limiter.waitUntilReady();
    let response;
    try {
      response = await this.fetch(this.config.feed_url);
    } catch (error) {
      this._lastErrorCode = error.code ?? 'fetch_failed';
      throw error;
    }
    const text = await (typeof response.text === 'function' ? response.text() : String(response));
    const feed = this.parse(text);
    this._lastFeedTitle = feed.title;

    const cursorId = cursor?.connector_cursor ?? null;
    let items = feed.items ?? [];
    if (cursorId) {
      // Stop after we re-encounter the high-watermark item id (newest-first).
      const idx = items.findIndex((item) => stableFeedItemId(item) === cursorId);
      if (idx >= 0) items = items.slice(0, idx);
    }
    items = items.slice(0, max_messages);

    const ingestBatchId = `rss:${this.accountRef}:${Date.now()}`;
    const rawRefs = [];
    for (const item of items) {
      if (clock.expired() || rawRefs.length >= max_messages) break;
      rawRefs.push({ ...item, feed_title: feed.title, ingest_batch_id: ingestBatchId, feed_url_ref: null });
    }

    this._lastSuccessAt = this.now();
    this._lastErrorCode = null;

    yield {
      ingest_batch_id: ingestBatchId,
      cursor_before: cursor,
      cursor_after: {
        connector_cursor: rawRefs.length ? stableFeedItemId(rawRefs[0]) : cursorId,
        high_watermark_sent_at: rawRefs.length ? (toUtcIsoTimestamp(rawRefs[0].published ?? rawRefs[0].updated) ?? null) : null,
        last_message_id: rawRefs.length ? stableFeedItemId(rawRefs[0]) : null
      },
      raw_refs: rawRefs
    };
  }

  async normalize(rawRef) {
    const itemId = stableFeedItemId(rawRef);
    const feedTitle = rawRef.feed_title ?? null;
    const published = toUtcIsoTimestamp(rawRef.published ?? rawRef.updated ?? rawRef.date);
    const receivedAt = this.now();

    return {
      source: 'rss',
      account_ref: this.accountRef,
      conversation_id: fallbackConversationId('rss', this.accountRef, rawRef.feed_title ?? 'feed'),
      conversation_title: rawRef.feed_title ?? null,
      thread_id: null,
      message_id: itemId,
      sender: makeSender({ id: null, display_name: rawRef.author ?? rawRef.feed_title ?? null, handle: null }),
      sent_at: published ?? receivedAt,
      received_at: receivedAt,
      body_text: plainTextProjection(rawRef.description ?? rawRef.title),
      attachment_refs: [],
      read_state: 'unknown',
      permalink: rawRef.link ?? null,
      raw_ref: { guid: rawRef.guid ?? null, link: rawRef.link ?? null, feed_title: rawRef.feed_title ?? null, item_id: itemId },
      ingest_batch_id: rawRef.ingest_batch_id ?? null
    };
  }
}