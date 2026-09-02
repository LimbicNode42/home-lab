import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordMessageStream, DISCORD_CONFIG, DISCORD_SOURCE } from '../src/connectors/discord.js';

const config = {
  bot_token: 'vault-ref-only',   // secret field: reference name only, never a value
  application_id: null,
  guild_id_allowlist: [],
  channel_id_allowlist: []
};

// A fake Discord read adapter: pure in-memory, no network, no secret material.
function makeAdapter(messages = []) {
  const calls = { fetchNew: 0, fetchOne: 0, mutating: [] };
  return {
    calls,
    async connectionInfo() { return 'gateway'; },
    async fetchNew({ max }) { calls.fetchNew += 1; return messages.slice(0, max); },
    async fetchOne({ messageId }) {
      calls.fetchOne += 1;
      return messages.find((m) => m.id === messageId)?.detail ?? null;
    }
    // No send/reply/react/delete surface at all — read-only by absence.
  };
}

test('DiscordMessageStream is read-only: no mutator methods exposed', () => {
  const stream = new DiscordMessageStream({ accountRef: 'home-server-bot', config, adapter: makeAdapter() });
  for (const m of ['send', 'reply', 'delete', 'markRead', 'archive', 'react', 'move', 'flag']) {
    assert.equal(typeof stream[m], 'undefined', `must not expose ${m}`);
  }
  assert.equal(stream.source, DISCORD_SOURCE);
});

test('DiscordMessageStream sync yields bounded raw refs and cursor', async () => {
  const adapter = makeAdapter([
    { id: 'd3', channel_id: 'c1' },
    { id: 'd2', channel_id: 'c1' }
  ]);
  const stream = new DiscordMessageStream({ accountRef: 'home-server-bot', config, adapter });

  const batches = [];
  for await (const batch of stream.sync(null, { max_messages: 1, max_runtime_ms: 1000 })) batches.push(batch);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].raw_refs.length, 1);
  assert.equal(batches[0].raw_refs[0].message_id, 'd3');
  assert.equal(adapter.calls.fetchNew, 1);
  assert.equal(batches[0].cursor_after.connector_cursor, 'd3');
  assert.equal(batches[0].ingest_batch_id.startsWith('discord:home-server-bot:'), true);
});

test('DiscordMessageStream normalize maps envelope fields and derives conversation/thread identity', async () => {
  const adapter = makeAdapter([
    { id: 'd3', channel_id: 'c1', detail: {
      id: 'd3', channel_id: 'c1', thread_id: null,
      author: { id: 'u1', username: 'alice', name: 'Alice' },
      content: '  hello   world  ',
      timestamp: '2026-09-01T10:00:00.000Z',
      channel_name: 'general',
      attachments: [{ id: 'a1', filename: 'pic.png', content_type: 'image/png', size: 12345, url: 'https://cdn.example.test/pic.png' }]
    } }
  ]);
  const stream = new DiscordMessageStream({
    accountRef: 'home-server-bot', config, adapter, now: () => '2026-09-01T12:00:00.000Z'
  });

  const envelope = await stream.normalize({ message_id: 'd3', channel_id: 'c1', guild_id: null, ingest_batch_id: 'b1' });

  assert.equal(envelope.source, 'discord');
  assert.equal(envelope.account_ref, 'home-server-bot');
  assert.equal(envelope.message_id, 'd3');
  assert.equal(envelope.sender.display_name, 'Alice');
  assert.equal(envelope.sender.handle, 'alice');
  assert.equal(envelope.sender.id, 'u1');
  assert.equal(envelope.conversation_title, 'general');
  assert.equal(envelope.body_text, 'hello world');
  assert.equal(envelope.sent_at, '2026-09-01T10:00:00.000Z');
  assert.equal(envelope.attachment_refs.length, 1);
  assert.equal(envelope.attachment_refs[0].name, 'pic.png');
  assert.equal(envelope.ingest_batch_id, 'b1');
});

test('DiscordMessageStream health is honest when no adapter is configured', async () => {
  const stream = new DiscordMessageStream({ accountRef: 'home-server-bot', config, adapter: null });
  const health = await stream.health();
  assert.equal(health.state, 'not_configured');
});

test('DISCORD_CONFIG marks bot token as secret and allowlists as arrays, no literal value', () => {
  assert.equal(DISCORD_CONFIG.bot_token.type, 'secret');
  assert.equal(DISCORD_CONFIG.guild_id_allowlist.type, 'allowlist');
  assert.equal(DISCORD_CONFIG.channel_id_allowlist.type, 'allowlist');
  assert.equal(JSON.stringify(DISCORD_CONFIG).includes('vault-ref-only'), false);
});