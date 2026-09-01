import test from 'node:test';
import assert from 'node:assert/strict';

import { RssMessageStream, parseFeed, stableFeedItemId, RSS_CONFIG } from '../src/connectors/rss.js';

const fixtureRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.test/</link>
    <description>Fixture feed</description>
    <item>
      <guid>https://example.test/items/3</guid>
      <title>Third item</title>
      <link>https://example.test/items/3</link>
      <description>A third description</description>
      <pubDate>Wed, 01 Sep 2026 10:00:00 GMT</pubDate>
      <author>alice@example.test</author>
    </item>
    <item>
      <guid>https://example.test/items/2</guid>
      <title>Second item</title>
      <link>https://example.test/items/2</link>
      <description>Second description</description>
      <pubDate>Wed, 01 Sep 2026 09:00:00 GMT</pubDate>
    </item>
    <item>
      <title>No guid item</title>
      <link>https://example.test/items/1</link>
      <description>Fallback identity</description>
    </item>
  </channel>
</rss>`;

const fixtureAtom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <id>tag:example.test,2026:atom-1</id>
    <title>Atom entry</title>
    <link href="https://example.test/atom/1"/>
    <summary>Atom summary</summary>
    <updated>2026-09-01T08:30:00Z</updated>
  </entry>
</feed>`;

function makeFetch(body, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    text: async () => body
  });
}

test('parseFeed parses RSS 2.0 items', () => {
  const parsed = parseFeed(fixtureRss);
  assert.equal(parsed.title, 'Example Feed');
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[0].guid, 'https://example.test/items/3');
  assert.equal(parsed.items[2].guid, null);
  assert.equal(parsed.items[2].title, 'No guid item');
});

test('parseFeed parses Atom entries', () => {
  const parsed = parseFeed(fixtureAtom);
  assert.equal(parsed.title, 'Atom Feed');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, 'tag:example.test,2026:atom-1');
});

test('stableFeedItemId falls back deterministically for items without guid/link/id', () => {
  const a = stableFeedItemId({ title: 'x', link: null, published: '2026-09-01' });
  const b = stableFeedItemId({ title: 'x', link: null, published: '2026-09-01' });
  assert.equal(a, b);
  assert.notEqual(a, stableFeedItemId({ title: 'y', link: null, published: '2026-09-01' }));
});

test('RssMessageStream is read-only and bounded', async () => {
  const fetch = makeFetch(fixtureRss);
  const stream = new RssMessageStream({ accountRef: 'default', config: { feed_url: 'https://example.test/feed.xml', min_interval_ms: 0 }, fetch, now: () => '2026-09-01T12:00:00.000Z' });
  for (const m of ['send', 'reply', 'delete', 'markRead', 'archive', 'react', 'move', 'flag']) {
    assert.equal(typeof stream[m], 'undefined');
  }
  const batches = [];
  for await (const batch of stream.sync(null, { max_messages: 2, max_runtime_ms: 1000 })) batches.push(batch);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].raw_refs.length, 2);
});

test('RssMessageStream is idempotent: cursor high-watermark skips already-seen items', async () => {
  const fetch = makeFetch(fixtureRss);
  const stream = new RssMessageStream({ accountRef: 'default', config: { feed_url: 'https://example.test/feed.xml', min_interval_ms: 0 }, fetch, now: () => '2026-09-01T12:00:00.000Z' });

  const first = [];
  for await (const batch of stream.sync(null, { max_messages: 10, max_runtime_ms: 1000 })) first.push(batch);
  const cursor = first[0].cursor_after;

  // Re-sync with the cursor: nothing new since items are all older than cursor.
  const second = [];
  for await (const batch of stream.sync(cursor, { max_messages: 10, max_runtime_ms: 1000 })) second.push(batch);
  assert.equal(second.length, 1);
  assert.equal(second[0].raw_refs.length, 0);
});

test('RssMessageStream normalize maps envelope fields with plain-text projection', async () => {
  const fetch = makeFetch(fixtureRss);
  const stream = new RssMessageStream({ accountRef: 'default', config: { feed_url: 'https://example.test/feed.xml', min_interval_ms: 0 }, fetch, now: () => '2026-09-01T12:00:00.000Z' });

  const envelope = await stream.normalize({
    guid: 'https://example.test/items/3',
    title: 'Third item',
    link: 'https://example.test/items/3',
    description: 'A third description',
    published: 'Wed, 01 Sep 2026 10:00:00 GMT',
    author: 'alice@example.test',
    feed_title: 'Example Feed',
    ingest_batch_id: 'b1'
  });

  assert.equal(envelope.source, 'rss');
  assert.equal(envelope.message_id, 'https://example.test/items/3');
  assert.equal(envelope.conversation_title, 'Example Feed');
  assert.equal(envelope.body_text, 'A third description');
  assert.equal(envelope.sender.display_name, 'alice@example.test');
  assert.equal(envelope.sent_at, '2026-09-01T10:00:00.000Z');
  assert.equal(envelope.permalink, 'https://example.test/items/3');
  assert.equal(envelope.ingest_batch_id, 'b1');
});

test('RssMessageStream health surfaces rate_limited without fetching', async () => {
  let fetches = 0;
  const fetch = async () => { fetches += 1; return { ok: true, status: 200, text: async () => fixtureRss }; };
  const stream = new RssMessageStream({ accountRef: 'default', config: { feed_url: 'https://example.test/feed.xml', min_interval_ms: 60000 }, fetch, now: () => '2026-09-01T12:00:00.000Z' });
  for await (const _ of stream.sync(null, { max_messages: 1, max_runtime_ms: 1000 })) { /* consume first fetch */ }
  const health = await stream.health();
  assert.equal(health.state, 'rate_limited');
  assert.equal(health.last_error_code, 'rate_limited');
});

test('RSS config definition stores only non-secret feed_url and marks no secret values', () => {
  assert.equal(RSS_CONFIG.feed_url.type, 'nonSecret');
  assert.equal(JSON.stringify(RSS_CONFIG).includes('example.test'), false);
});