import test from 'node:test';
import assert from 'node:assert/strict';

import { TelegramMessageStream, TELEGRAM_CONFIG, TELEGRAM_SOURCE } from '../src/connectors/telegram.js';

const config = {
  bot_token: 'vault-ref-only',   // secret field: reference name only, never a value
  webhook_secret_ref: null,
  min_interval_ms: 0
};

function makeAdapter(updates = []) {
  const calls = { getUpdates: 0, fetchOne: 0, mutating: [] };
  return {
    calls,
    async getMe() { return { username: 'home_inbox_bot' }; },
    async getUpdates({ offset }) { calls.getUpdates += 1; calls.lastOffset = offset; return updates; },
    async fetchOne({ chat_id, message_id }) {
      calls.fetchOne += 1;
      return updates.flatMap((u) => u.messages ?? [u]).find((m) => m.chat_id === chat_id && m.message_id === message_id)?.detail ?? null;
    }
    // Read-only surface only; no sendMessage/deleteMessage/editMessage.
  };
}

test('TelegramMessageStream is read-only: no mutator methods exposed', () => {
  const stream = new TelegramMessageStream({ accountRef: 'home-bot', config, adapter: makeAdapter() });
  for (const m of ['send', 'reply', 'delete', 'markRead', 'archive', 'react', 'move', 'flag']) {
    assert.equal(typeof stream[m], 'undefined', `must not expose ${m}`);
  }
  assert.equal(stream.source, TELEGRAM_SOURCE);
});

test('TelegramMessageStream sync uses offset = last update_id + 1 and yields bounded refs', async () => {
  const adapter = makeAdapter([
    { update_id: 10, message_id: 100, chat_id: 'c1' },
    { update_id: 9, message_id: 99, chat_id: 'c1' }
  ]);
  const stream = new TelegramMessageStream({ accountRef: 'home-bot', config, adapter });

  const batches = [];
  for await (const batch of stream.sync({ connector_cursor: '7' }, { max_messages: 1, max_runtime_ms: 1000 })) batches.push(batch);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].raw_refs.length, 1);
  assert.equal(batches[0].raw_refs[0].update_id, 10);
  assert.equal(adapter.calls.lastOffset, 8); // 7 + 1
  assert.equal(batches[0].cursor_after.connector_cursor, '10');
});

test('TelegramMessageStream normalize maps envelope fields and derives sender/chat identity', async () => {
  const adapter = makeAdapter([
    { update_id: 10, message_id: 100, chat_id: 'c1', detail: {
      message_id: 100, from: { id: 123, username: 'carol', first_name: 'Carol' },
      chat: { id: 'c1', title: null },
      text: '  deploy   ok  ',
      date_seconds: 1725192000   // 2024-09-01T12:00:00Z
    } }
  ]);
  const stream = new TelegramMessageStream({
    accountRef: 'home-bot', config, adapter, now: () => '2026-09-01T12:00:00.000Z'
  });

  const envelope = await stream.normalize({ update_id: 10, message_id: 100, chat_id: 'c1', ingest_batch_id: 'b1' });

  assert.equal(envelope.source, 'telegram');
  assert.equal(envelope.message_id, '100');
  assert.equal(envelope.sender.id, '123');
  assert.equal(envelope.sender.display_name, 'Carol');
  assert.equal(envelope.sender.handle, 'carol');
  assert.equal(envelope.body_text, 'deploy ok');
  assert.equal(envelope.ingest_batch_id, 'b1');
});

test('TelegramMessageStream health reports bot username and is honest when unconfigured', async () => {
  const stream = new TelegramMessageStream({ accountRef: 'home-bot', config, adapter: makeAdapter() });
  const health = await stream.health();
  assert.equal(health.state, 'ok');
  assert.equal(health.detail, 'bot @home_inbox_bot');

  const disabled = new TelegramMessageStream({ accountRef: 'home-bot', config, adapter: null });
  assert.equal((await disabled.health()).state, 'not_configured');
});

test('TELEGRAM_CONFIG marks bot token as secret and stores no literal value', () => {
  assert.equal(TELEGRAM_CONFIG.bot_token.type, 'secret');
  assert.equal(JSON.stringify(TELEGRAM_CONFIG).includes('vault-ref-only'), false);
});