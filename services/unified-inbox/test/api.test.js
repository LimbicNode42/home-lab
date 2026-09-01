import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/api.js';
import { FileSnapshotStore, MemorySnapshotStore } from '../src/storage.js';

function apiEnvelope(id, batchId) {
  return {
    source: 'rss', account_ref: 'default', conversation_id: 'feed', conversation_title: 'Feed', thread_id: null,
    message_id: id, sender: { id: 'feed', display_name: 'Feed', handle: null },
    sent_at: '2026-09-01T00:00:00.000Z', received_at: '2026-09-01T00:00:01.000Z', body_text: 'hello',
    attachment_refs: [], read_state: 'unknown', permalink: null, raw_ref: { batch_id: batchId, snapshot_file: `${batchId}.raw.jsonl`, offset: 0 }, ingest_batch_id: batchId
  };
}

test('API exposes health, sanitized status, conversations, and messages read-only', async () => {
  const store = new MemorySnapshotStore();
  await store.appendBatch({ batchId: 'batch-api', envelopes: [apiEnvelope('1', 'batch-api')] });
  const app = createApp({ store, connectors: [] });

  assert.equal((await app.handle(new Request('http://service.test/healthz'))).status, 200);
  const status = await (await app.handle(new Request('http://service.test/api/unified-inbox/status'))).json();
  assert.equal(status.service.name, 'unified-inbox');
  assert.equal(status.exclusions.some((entry) => entry.source === 'whatsapp-personal-dm' && entry.state === 'excluded'), true);
  assert.equal(JSON.stringify(status).includes('hello'), false);
  assert.equal((await app.handle(new Request('http://service.test/api/unified-inbox/messages'))).status, 200);
  assert.equal((await app.handle(new Request('http://service.test/api/unified-inbox/reply', { method: 'POST' }))).status, 404);
});

test('status API summarizes file snapshots without exposing local or NAS paths', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-inbox-api-'));
  const nasRoot = join(dir, 'mnt', 'nas', 'services', 'unified-inbox');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = new FileSnapshotStore({
    stateDir: join(dir, 'state'),
    closedSnapshotDir: join(dir, 'runtime', 'closed'),
    nasSnapshotDir: join(nasRoot, 'snapshots'),
    nasManifestDir: join(nasRoot, 'manifests')
  });
  await store.appendBatch({ batchId: 'batch-file-api', envelopes: [apiEnvelope('1', 'batch-file-api')] });
  const app = createApp({ store, connectors: [] });

  const response = await app.handle(new Request('http://service.test/api/unified-inbox/status'));
  const status = await response.json();
  const serialized = JSON.stringify(status);

  assert.equal(response.status, 200);
  assert.equal(status.snapshots.batch_id, 'batch-file-api');
  assert.equal(status.snapshots.record_count, 1);
  assert.equal(status.snapshots.copy_status, 'copied_to_nas_snapshot_path');
  assert.equal(serialized.includes('/mnt/nas'), false);
  assert.equal(serialized.includes('/root'), false);
  assert.equal(serialized.includes('/app'), false);
  assert.equal(serialized.includes(dir), false);
});
