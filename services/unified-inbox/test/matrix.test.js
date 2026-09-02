import test from 'node:test';
import assert from 'node:assert/strict';

import { MatrixMessageStream, MATRIX_CONFIG, MATRIX_SOURCE } from '../src/connectors/matrix.js';

const config = {
  homeserver_url: 'https://matrix.example.test',
  access_token: 'vault-ref-only',    // secret field: reference name only, never a value
  user_id: '@inbox:example.test',
  device_id: 'DEVICE',
  min_interval_ms: 0
};

function makeAdapter(events = [], since = 's_next') {
  const calls = { sync: 0, fetchOne: 0, mutating: [] };
  return {
    calls,
    async whoami() { return { user_id: '@inbox:example.test' }; },
    async sync({ since: _since, max }) { calls.sync += 1; calls.lastSince = _since; return { since, events: events.slice(0, max) }; },
    async fetchOne({ roomId, eventId }) {
      calls.fetchOne += 1;
      return events.find((e) => e.room_id === roomId && e.event_id === eventId)?.detail ?? null;
    }
    // Read-only C-S API surface; no send/redact/delete.
  };
}

test('MatrixMessageStream is read-only: no mutator methods exposed', () => {
  const stream = new MatrixMessageStream({ accountRef: 'home-account', config, adapter: makeAdapter() });
  for (const m of ['send', 'reply', 'delete', 'markRead', 'archive', 'react', 'move', 'flag']) {
    assert.equal(typeof stream[m], 'undefined', `must not expose ${m}`);
  }
  assert.equal(stream.source, MATRIX_SOURCE);
});

test('MatrixMessageStream sync passes prior since token and returns next since', async () => {
  const adapter = makeAdapter([
    { event_id: '$e1', room_id: '!r1', sender: '@a:example.test', type: 'm.room.message', origin_server_ts: 1725192000000 }
  ], 's_next_token');
  const stream = new MatrixMessageStream({ accountRef: 'home-account', config, adapter });

  const batches = [];
  for await (const batch of stream.sync({ connector_cursor: 's_prev' }, { max_messages: 10, max_runtime_ms: 1000 })) batches.push(batch);

  assert.equal(batches.length, 1);
  assert.equal(adapter.calls.lastSince, 's_prev');
  assert.equal(batches[0].raw_refs.length, 1);
  assert.equal(batches[0].raw_refs[0].event_id, '$e1');
  assert.equal(batches[0].cursor_after.connector_cursor, 's_next_token');
});

test('MatrixMessageStream normalize maps envelope and surfaces encrypted events explicitly', async () => {
  const adapter = makeAdapter([
    { event_id: '$e1', room_id: '!r1', detail: {
      type: 'm.room.message', room: { name: 'War Room' },
      sender: '@alice:example.test',
      content: { body: '  sync  clean  ' }, origin_server_ts: 1725192000000
    } },
    { event_id: '$e2', room_id: '!r2', detail: {
      type: 'm.room.encrypted', room: {}, sender: '@bob:example.test',
      content: {}, origin_server_ts: 1725192001000
    } }
  ]);
  const stream = new MatrixMessageStream({
    accountRef: 'home-account', config, adapter, now: () => '2026-09-01T12:00:00.000Z'
  });

  const plain = await stream.normalize({ event_id: '$e1', room_id: '!r1', sender: '@alice:example.test', origin_server_ts: 1725192000000, ingest_batch_id: 'b1' });
  assert.equal(plain.source, 'matrix');
  assert.equal(plain.message_id, '$e1');
  assert.equal(plain.conversation_title, 'War Room');
  assert.equal(plain.body_text, 'sync clean');
  assert.equal(plain.sender.id, '@alice:example.test');

  const encrypted = await stream.normalize({ event_id: '$e2', room_id: '!r2', sender: '@bob:example.test', origin_server_ts: 1725192001000, ingest_batch_id: 'b2' });
  assert.equal(encrypted.body_text, null);
  assert.equal(encrypted.raw_ref.encrypted, true);
});

test('MatrixMessageStream health reports session and is honest when unconfigured', async () => {
  const stream = new MatrixMessageStream({ accountRef: 'home-account', config, adapter: makeAdapter() });
  const health = await stream.health();
  assert.equal(health.state, 'ok');
  assert.equal(health.detail, 'session @inbox:example.test');

  const disabled = new MatrixMessageStream({ accountRef: 'home-account', config, adapter: null });
  assert.equal((await disabled.health()).state, 'not_configured');
});

test('MATRIX_CONFIG marks access token as secret and homeserver url non-secret, no literal value', () => {
  assert.equal(MATRIX_CONFIG.access_token.type, 'secret');
  assert.equal(MATRIX_CONFIG.homeserver_url.type, 'nonSecret');
  assert.equal(JSON.stringify(MATRIX_CONFIG).includes('vault-ref-only'), false);
});