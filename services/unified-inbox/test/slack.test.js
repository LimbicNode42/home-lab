import test from 'node:test';
import assert from 'node:assert/strict';

import { SlackMessageStream, SLACK_CONFIG, SLACK_SOURCE } from '../src/connectors/slack.js';

const config = {
  bot_token: 'vault-ref-only',         // secret field: reference name only, never a value
  signing_secret: 'vault-ref-only',    // secret field: reference name only, never a value
  app_id: 'A0000',
  workspace_id: 'T0000',
  channel_id_allowlist: [],
  min_interval_ms: 0
};

function makeAdapter(messages = [], cursor = null) {
  const calls = { fetchHistory: 0, fetchOne: 0, mutating: [] };
  return {
    calls,
    async authTest() { return { url: 'https://example.test.slack.com' }; },
    async fetchHistory({ max }) { calls.fetchHistory += 1; return { messages: messages.slice(0, max), cursor }; },
    async fetchOne({ ts, channel }) {
      calls.fetchOne += 1;
      return messages.find((m) => m.ts === ts)?.detail ?? null;
    }
    // Read-only Web API surface; no chat.postMessage / chat.delete / reactions.add.
  };
}

test('SlackMessageStream is read-only: no mutator methods exposed', () => {
  const stream = new SlackMessageStream({ accountRef: 'workspace-bot', config, adapter: makeAdapter() });
  for (const m of ['send', 'reply', 'delete', 'markRead', 'archive', 'react', 'move', 'flag']) {
    assert.equal(typeof stream[m], 'undefined', `must not expose ${m}`);
  }
  assert.equal(stream.source, SLACK_SOURCE);
});

test('SlackMessageStream sync reverses oldest→newest to a newest-first high-watermark', async () => {
  // Slack returns oldest→newest; connector reverses so rawRefs[0] is newest.
  const adapter = makeAdapter([
    { ts: '1725192000.000100', channel: 'C1' },   // oldest
    { ts: '1725192000.000300', channel: 'C1' }    // newest
  ]);
  const stream = new SlackMessageStream({ accountRef: 'workspace-bot', config, adapter });

  const batches = [];
  for await (const batch of stream.sync(null, { max_messages: 10, max_runtime_ms: 1000 })) batches.push(batch);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].raw_refs.length, 2);
  assert.equal(batches[0].raw_refs[0].ts, '1725192000.000300'); // newest first
  assert.equal(batches[0].raw_refs[1].ts, '1725192000.000100');
});

test('SlackMessageStream normalize maps envelope, thread_ts, and attachment refs', async () => {
  const adapter = makeAdapter([
    { ts: '1725192000.000300', channel: 'C1', thread_ts: '1725192000.000300', detail: {
      ts: '1725192000.000300', thread_ts: '1725192000.000300',
      text: '  hello slack  ', user: 'U1', channel: 'C1', channel_name: 'engineering',
      files: [{ id: 'F1', name: 'doc.pdf', mimetype: 'application/pdf', size: 999, url_private_download: 'https://files.slack.com/doc.pdf' }]
    } }
  ]);
  const stream = new SlackMessageStream({
    accountRef: 'workspace-bot', config, adapter, now: () => '2026-09-01T12:00:00.000Z'
  });

  const envelope = await stream.normalize({ ts: '1725192000.000300', channel: 'C1', thread_ts: null, ingest_batch_id: 'b1' });

  assert.equal(envelope.source, 'slack');
  assert.equal(envelope.message_id, '1725192000.000300');
  assert.equal(envelope.sender.id, 'U1');
  assert.equal(envelope.conversation_title, 'engineering');
  assert.equal(envelope.body_text, 'hello slack');
  assert.equal(envelope.thread_id, '1725192000.000300');
  assert.equal(envelope.attachment_refs.length, 1);
  assert.equal(envelope.attachment_refs[0].name, 'doc.pdf');
  assert.equal(envelope.ingest_batch_id, 'b1');
});

test('SlackMessageStream health reports workspace and is honest when unconfigured', async () => {
  const stream = new SlackMessageStream({ accountRef: 'workspace-bot', config, adapter: makeAdapter() });
  const health = await stream.health();
  assert.equal(health.state, 'ok');
  assert.equal(health.detail, 'workspace https://example.test.slack.com');

  const disabled = new SlackMessageStream({ accountRef: 'workspace-bot', config, adapter: null });
  assert.equal((await disabled.health()).state, 'not_configured');
});

test('SLACK_CONFIG marks bot token and signing secret as secret, no literal value', () => {
  assert.equal(SLACK_CONFIG.bot_token.type, 'secret');
  assert.equal(SLACK_CONFIG.signing_secret.type, 'secret');
  assert.equal(SLACK_CONFIG.channel_id_allowlist.type, 'allowlist');
  assert.equal(JSON.stringify(SLACK_CONFIG).includes('vault-ref-only'), false);
});