import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/api.js';
import { MemorySnapshotStore } from '../src/storage.js';

function androidEnvelope(id, batchId = 'android-batch-1') {
  return {
    source: 'android-sms-mms',
    account_ref: 'android-sms-mms/pixel-emulator',
    conversation_id: 'android-sms-mms:pixel-emulator:abc123',
    conversation_title: 'redacted:0123',
    thread_id: '7',
    message_id: id,
    sender: { id: 'addrhash-abc', display_name: null, handle: 'redacted:0123' },
    sent_at: '2026-09-03T00:00:00.000Z',
    received_at: '2026-09-03T00:00:03.000Z',
    body_text: 'Synthetic emulator SMS only.',
    attachment_refs: [],
    read_state: 'unknown',
    permalink: null,
    raw_ref: { device_ref: 'pixel-emulator', local_provider: 'sms', local_ref: 'sms:42' },
    ingest_batch_id: batchId
  };
}

function appWithToken(store) {
  return createApp({
    store,
    connectors: [],
    androidSmsMmsIngest: { enabled: true, uploadToken: 'fixture-token' }
  });
}

test('android SMS/MMS batch endpoint requires bearer auth', async () => {
  const app = appWithToken(new MemorySnapshotStore());

  const response = await app.handle(new Request('http://service.test/api/unified-inbox/connectors/android-sms-mms/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  }));

  assert.equal(response.status, 401);
});

test('android SMS/MMS batch endpoint validates schema and source', async () => {
  const app = appWithToken(new MemorySnapshotStore());

  const response = await app.handle(new Request('http://service.test/api/unified-inbox/connectors/android-sms-mms/batches', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 'wrong.v1',
      account_ref: 'android-sms-mms/pixel-emulator',
      device_ref: 'pixel-emulator',
      cursor_before: {},
      cursor_after: {},
      messages: [{ ...androidEnvelope('sms:1'), source: 'email-imap' }]
    })
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'bad_request' });
});

test('android SMS/MMS batch endpoint persists accepted records, dedupes, and commits cursor', async () => {
  const store = new MemorySnapshotStore();
  const app = appWithToken(store);
  const message = androidEnvelope('sms:42:1788393600000:abc');

  const response = await app.handle(new Request('http://service.test/api/unified-inbox/connectors/android-sms-mms/batches', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 'android-sms-mms.v1',
      account_ref: 'android-sms-mms/pixel-emulator',
      device_ref: 'pixel-emulator',
      cursor_before: { sms_high_watermark: 'sms:41', mms_high_watermark: null, last_message_id: 'sms:41' },
      cursor_after: { sms_high_watermark: 'sms:42', mms_high_watermark: 'mms:9', last_message_id: message.message_id },
      messages: [message, message]
    })
  }));

  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.ok, true);
  assert.equal(body.accepted_count, 1);
  assert.equal(body.deduped_count, 1);
  assert.equal(body.cursor_commit.last_message_id, message.message_id);

  const status = await (await app.handle(new Request('http://service.test/api/unified-inbox/status'))).json();
  assert.equal(status.connectors.some((entry) => entry.source === 'android-sms-mms' && entry.state === 'sync_pending'), true);
  assert.equal(JSON.stringify(status).includes('Synthetic emulator SMS only.'), false);
  assert.equal(JSON.stringify(status).includes('5555'), false);
});

test('android SMS/MMS endpoint remains the only non-GET inbox write path', async () => {
  const app = appWithToken(new MemorySnapshotStore());
  const replyResponse = await app.handle(new Request('http://service.test/api/unified-inbox/reply', { method: 'POST' }));
  const sendResponse = await app.handle(new Request('http://service.test/api/unified-inbox/connectors/android-sms-mms/send', { method: 'POST' }));

  assert.equal(replyResponse.status, 404);
  assert.equal(sendResponse.status, 404);
});
