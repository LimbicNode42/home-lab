import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IngestService } from '../src/ingest.js';
import { FileSnapshotStore } from '../src/storage.js';

function envelope(id, batchId) {
  return {
    source: 'rss', account_ref: 'default', conversation_id: 'feed', conversation_title: 'Feed', thread_id: null,
    message_id: id, sender: { id: 'feed', display_name: 'Feed', handle: null },
    sent_at: '2026-09-01T00:00:00.000Z', received_at: '2026-09-01T00:00:01.000Z',
    body_text: `item ${id}`, attachment_refs: [], read_state: 'unknown', permalink: 'https://example.test/item',
    raw_ref: { batch_id: batchId, snapshot_file: `${batchId}.raw.jsonl`, offset: 0 }, ingest_batch_id: batchId
  };
}

function connector(messages) {
  return {
    source: 'rss', accountRef: 'default',
    async health() { return { state: 'ok', checked_at: new Date(0).toISOString(), last_success_at: new Date(0).toISOString(), last_error_code: null, detail: 'fixture' }; },
    async *sync() { yield { ingest_batch_id: 'batch-a', cursor_before: null, cursor_after: { connector_cursor: 'cursor-a', high_watermark_sent_at: null, last_message_id: messages.at(-1)?.message_id ?? null }, raw_refs: messages.map((message_id) => ({ message_id })) }; },
    async normalize(raw) { return envelope(raw.message_id, 'batch-a'); }
  };
}

test('IngestService writes immutable snapshots and deduplicates by source account message_id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-inbox-store-'));
  const store = new FileSnapshotStore({ stateDir: join(dir, 'state'), closedSnapshotDir: join(dir, 'closed'), nasSnapshotDir: join(dir, 'nas', 'snapshots'), nasManifestDir: join(dir, 'nas', 'manifests') });
  const service = new IngestService({ connectors: [connector(['a', 'b', 'a'])], store, now: () => '2026-09-01T00:02:00.000Z' });

  const result = await service.runOnce({ max_messages: 10, max_runtime_ms: 1000 });

  assert.equal(result.ingested, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.batches.length, 1);
  await stat(result.batches[0].localSnapshotPath);
  await stat(result.batches[0].nasSnapshotPath);
  const lines = (await readFile(result.batches[0].nasSnapshotPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const status = await store.status();
  assert.equal(status.message_count, 2);
  assert.equal(status.snapshots.latest_batch_id, 'batch-a');
});
