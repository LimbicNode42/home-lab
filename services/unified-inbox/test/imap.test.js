import test from 'node:test';
import assert from 'node:assert/strict';

import { ImapMessageStream, stableMessageId, IMAP_CONFIG } from '../src/connectors/imap.js';

const config = {
  imap_host: 'imap.example.test',
  imap_port: '993',
  imap_username: 'user@example.test',
  imap_password_or_oauth_ref: 'vault-ref-only',
  imap_tls_mode: 'implicit'
};

// A fake IMAP adapter: pure in-memory, no network, no secret material.
function makeAdapter(messages = []) {
  const calls = { connect: 0, authenticate: 0, select: 0, fetchNew: 0, fetchOne: 0, mutating: [] };
  return {
    calls,
    async connect() { calls.connect += 1; },
    async authenticate({ username }) { calls.authenticate += 1; assert.equal(username, 'user@example.test'); },
    async select({ mailbox }) { calls.select += 1; return { uidValidity: '12345', mailbox }; },
    async fetchNew({ max }) { calls.fetchNew += 1; return messages.slice(0, max); },
    async fetchOne({ uid }) {
      calls.fetchOne += 1;
      const m = messages.find((msg) => msg.uid === uid);
      return m?.detail ?? { from: { address: 'someone@example.test', name: 'Someone' }, date: '2026-09-01T10:00:00Z', text: 'body' };
    },
    // Explicitly NO mutator surface — the adapter simply has no STORE/EXPUNGE etc.
    capability: async () => 'IMAP4rev1'
  };
}

test('ImapMessageStream is read-only: registry validates it with no mutator methods', async () => {
  const stream = new ImapMessageStream({ accountRef: 'personal', config, adapter: makeAdapter() });
  for (const m of ['send', 'reply', 'delete', 'markRead', 'archive', 'react', 'move', 'flag']) {
    assert.equal(typeof stream[m], 'undefined', `must not expose ${m}`);
  }
  assert.equal(stream.source, 'email-imap');
});

test('ImapMessageStream sync yields bounded raw refs and never issues mutating calls', async () => {
  const messages = [
    { uid: 10, messageId: '<m10@example.test>', flags: ['\\Seen'] },
    { uid: 9, messageId: null, flags: [] },
    { uid: 8, messageId: '<m8@example.test>', flags: ['\\Seen'] }
  ];
  const adapter = makeAdapter(messages);
  const stream = new ImapMessageStream({ accountRef: 'personal', config, adapter });

  const batches = [];
  for await (const batch of stream.sync(null, { max_messages: 2, max_runtime_ms: 1000 })) batches.push(batch);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].raw_refs.length, 2);
  assert.equal(batches[0].raw_refs[0].message_id, '<m10@example.test>');
  assert.equal(batches[0].raw_refs[1].message_id, 'INBOX__12345__9'); // fallback message id
  assert.equal(adapter.calls.connect, 1);
  assert.equal(adapter.calls.fetchNew, 1);
  assert.equal(batches[0].ingest_batch_id.startsWith('email-imap:personal:'), true);
});

test('ImapMessageStream normalize maps envelope fields and derives read_state from flags', async () => {
  const messages = [{ uid: 10, messageId: '<m10@example.test>', flags: ['\\Seen'], detail: {
    from: { address: 'sender@example.test', name: 'Sender Name' },
    subject: 'Meeting notes',
    date: '2026-09-01T09:00:00.000Z',
    inReplyTo: '<parent@example.test>',
    text: '  Hello   world  ',
    attachments: [{ id: 'a1', name: 'report.pdf', contentType: 'application/pdf', size: 1234 }]
  } }];
  const adapter = makeAdapter(messages);
  const stream = new ImapMessageStream({ accountRef: 'personal', config, adapter, now: () => '2026-09-01T12:00:00.000Z' });

  const envelope = await stream.normalize({ uid: 10, mailbox: 'INBOX', uid_validity: '12345', message_id: '<m10@example.test>', flags: ['\\Seen'], ingest_batch_id: 'b1' });

  assert.equal(envelope.source, 'email-imap');
  assert.equal(envelope.account_ref, 'personal');
  assert.equal(envelope.message_id, '<m10@example.test>');
  assert.equal(envelope.sender.display_name, 'Sender Name');
  assert.equal(envelope.sender.handle, 'sender@example.test');
  assert.equal(envelope.sender.id, 'sender@example.test');
  assert.equal(envelope.thread_id, '<parent@example.test>');
  assert.equal(envelope.body_text, 'Hello world');
  assert.equal(envelope.read_state, 'read');
  assert.equal(envelope.sent_at, '2026-09-01T09:00:00.000Z');
  assert.equal(envelope.attachment_refs.length, 1);
  assert.equal(envelope.attachment_refs[0].name, 'report.pdf');
  assert.equal(envelope.ingest_batch_id, 'b1');
});

test('stableMessageId prefers Message-ID header and falls back deterministically', () => {
  assert.equal(stableMessageId({ messageId: '<x@y>', uid: 5, mailbox: 'INBOX', uidValidity: 'v' }), '<x@y>');
  assert.equal(stableMessageId({ messageId: '', uid: 5, mailbox: 'INBOX', uidValidity: 'v' }), 'INBOX__v__5');
});

test('IMAP config definition names only field refs (no values) and marks password as secret', () => {
  assert.equal(IMAP_CONFIG.imap_password_or_oauth_ref.type, 'secret');
  assert.equal(IMAP_CONFIG.imap_host.type, 'nonSecret');
  // No literal credential value lives in the definition.
  assert.equal(JSON.stringify(IMAP_CONFIG).includes('vault-ref-only'), false);
});