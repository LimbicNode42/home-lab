import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/api.js';
import { MemorySnapshotStore } from '../src/storage.js';

test('API exposes health, sanitized status, conversations, and messages read-only', async () => {
  const store = new MemorySnapshotStore();
  await store.appendBatch({ batchId: 'batch-api', envelopes: [{
    source: 'rss', account_ref: 'default', conversation_id: 'feed', conversation_title: 'Feed', thread_id: null,
    message_id: '1', sender: { id: 'feed', display_name: 'Feed', handle: null }, sent_at: '2026-09-01T00:00:00.000Z', received_at: '2026-09-01T00:00:01.000Z', body_text: 'hello', attachment_refs: [], read_state: 'unknown', permalink: null, raw_ref: { batch_id: 'batch-api', snapshot_file: 'batch-api.raw.jsonl', offset: 0 }, ingest_batch_id: 'batch-api'
  }] });
  const app = createApp({ store, connectors: [] });

  assert.equal((await app.handle(new Request('http://service.test/healthz'))).status, 200);
  const status = await (await app.handle(new Request('http://service.test/api/unified-inbox/status'))).json();
  assert.equal(status.service.name, 'unified-inbox');
  assert.equal(status.exclusions.some((entry) => entry.source === 'whatsapp-personal-dm' && entry.state === 'excluded'), true);
  assert.equal(JSON.stringify(status).includes('hello'), false);
  assert.equal((await app.handle(new Request('http://service.test/api/unified-inbox/messages'))).status, 200);
  assert.equal((await app.handle(new Request('http://service.test/api/unified-inbox/reply', { method: 'POST' }))).status, 404);
});
