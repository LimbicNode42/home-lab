import test from 'node:test';
import assert from 'node:assert/strict';

import { WebhookMessageStream, verifyWebhookSignature, signatureFor, WEBHOOK_CONFIG } from '../src/connectors/webhook.js';
import { createApp } from '../src/api.js';
import { MemorySnapshotStore } from '../src/storage.js';

const secret = 'test-signing-secret-not-a-real-credential';

function makeStream(overrides = {}) {
  return new WebhookMessageStream({
    accountRef: 'github',
    source: 'webhook-github',
    config: { source_label: 'GitHub events', webhook_signing_secret: secret, require_signature: true },
    now: () => '2026-09-01T12:00:00.000Z',
    ...overrides
  });
}

test('WebhookMessageStream is read-only (receive-only, no mutators)', () => {
  const stream = makeStream();
  for (const m of ['send', 'reply', 'delete', 'markRead', 'archive', 'react', 'move', 'flag']) {
    assert.equal(typeof stream[m], 'undefined');
  }
  assert.equal(stream.source, 'webhook-github');
});

test('verifyWebhookSignature accepts valid sha256 signature and rejects tampered body', () => {
  const body = JSON.stringify({ id: 'evt-1', text: 'hello' });
  const sig = signatureFor(secret, body);
  assert.equal(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: `sha256=${sig}` }), true);
  assert.equal(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: sig }), true);
  assert.equal(verifyWebhookSignature({ secret, rawBody: body + 'x', signatureHeader: sig }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: 'sha256=deadbeef' }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: null }), false);
});

test('WebhookMessageStream receive normalizes to envelope and rejects bad signature', async () => {
  const stream = makeStream();
  const body = JSON.stringify({ id: 'evt-1', type: 'push', timestamp: '2026-09-01T10:00:00Z', sender: 'alice', text: '  deploy shipped  ', attachments: [{ id: 'a1', name: 'x.txt', content_type: 'text/plain', size: 10, url: 'https://example.test/x.txt' }] });
  const sig = signatureFor(secret, body);

  const envelope = await stream.receive({ rawBody: body, headers: { 'x-webhook-signature': `sha256=${sig}` } });
  assert.equal(envelope.message_id, 'evt-1');
  assert.equal(envelope.body_text, 'deploy shipped');
  assert.equal(envelope.sender.display_name, 'alice');
  assert.equal(envelope.attachment_refs.length, 1);
  assert.equal(envelope.read_state, 'unread');

  await assert.rejects(
    () => stream.receive({ rawBody: body, headers: { 'x-webhook-signature': 'sha256=bad' } }),
    /signature verification failed/
  );
});

test('WebhookMessageStream rejects non-JSON payloads', async () => {
  const stream = makeStream({ config: { source_label: 'x', webhook_signing_secret: secret, require_signature: false } });
  await assert.rejects(() => stream.receive({ rawBody: 'not json', headers: {} }), /not valid JSON/);
});

test('webhook endpoint is opt-in: absent webhookIngest leaves POST as 404', async () => {
  const store = new MemorySnapshotStore();
  const app = createApp({ store, connectors: [] });
  const req = new Request('http://service.test/api/unified-inbox/webhook/github', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal((await app.handle(req)).status, 404);
});

test('webhook endpoint accepts valid signed payload and stores it', async () => {
  const store = new MemorySnapshotStore();
  const stream = makeStream();
  const webhookIngest = { enabled: true, streams: new Map([['github', stream]]) };
  const app = createApp({ store, connectors: [], webhookIngest });

  const body = JSON.stringify({ id: 'evt-2', timestamp: '2026-09-01T10:00:00Z', text: 'another event' });
  const sig = signatureFor(secret, body);
  const req = new Request('http://service.test/api/unified-inbox/webhook/github', {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-webhook-signature': `sha256=${sig}` }
  });
  const res = await app.handle(req);
  assert.equal(res.status, 202);
  const parsed = await res.json();
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record_count, 1);
});

test('webhook endpoint returns 401 for invalid signature without storing', async () => {
  const store = new MemorySnapshotStore();
  const stream = makeStream();
  const webhookIngest = { enabled: true, streams: new Map([['github', stream]]) };
  const app = createApp({ store, connectors: [], webhookIngest });

  const req = new Request('http://service.test/api/unified-inbox/webhook/github', {
    method: 'POST', body: '{"id":"evt-3","text":"x"}', headers: { 'content-type': 'application/json', 'x-webhook-signature': 'sha256=bad' }
  });
  const res = await app.handle(req);
  assert.equal(res.status, 401);
  const status = await store.status();
  assert.equal(status.message_count, 0);
});

test('WEBHOOK_CONFIG marks signing secret as secret and source_label non-secret', () => {
  assert.equal(WEBHOOK_CONFIG.webhook_signing_secret.type, 'secret');
  assert.equal(WEBHOOK_CONFIG.source_label.type, 'nonSecret');
});