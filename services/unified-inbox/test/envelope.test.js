import test from 'node:test';
import assert from 'node:assert/strict';

import { validateEnvelope } from '../src/envelope.js';

const baseEnvelope = {
  source: 'email-imap',
  account_ref: 'personal',
  conversation_id: 'inbox',
  conversation_title: 'Inbox',
  thread_id: null,
  message_id: 'msg-1',
  sender: { id: 'sender-1', display_name: 'Sender', handle: 'sender@example.test' },
  sent_at: '2026-09-01T00:00:00.000Z',
  received_at: '2026-09-01T00:01:00.000Z',
  body_text: 'plain text only',
  attachment_refs: [],
  read_state: 'unknown',
  permalink: 'https://mail.example.test/message/msg-1',
  raw_ref: { batch_id: 'batch-1', snapshot_file: 'raw/batch-1.jsonl', offset: 0 },
  ingest_batch_id: 'batch-1'
};

test('validateEnvelope accepts the locked normalized envelope shape', () => {
  const envelope = validateEnvelope(baseEnvelope);
  assert.deepEqual(Object.keys(envelope), Object.keys(baseEnvelope));
  assert.equal(envelope.source, 'email-imap');
});

test('validateEnvelope rejects missing canonical fields and unsafe permalinks', () => {
  assert.throws(() => validateEnvelope({ ...baseEnvelope, ingest_batch_id: undefined }), /ingest_batch_id/i);
  assert.throws(() => validateEnvelope({ ...baseEnvelope, permalink: 'https://example.test/message?token=abc' }), /permalink/i);
  assert.throws(() => validateEnvelope({ ...baseEnvelope, sent_at: '2026-09-01 00:00:00' }), /sent_at/i);
});
