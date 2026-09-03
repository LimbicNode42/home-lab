import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCursor, placeholderCursorKey, stableCursorFileSlug } from '../src/connectors/cursor-state.js';

test('normalizeCursor returns empty shape for null/empty input', () => {
  assert.deepEqual(normalizeCursor(null), { connector_cursor: null, high_watermark_sent_at: null, last_message_id: null });
  assert.deepEqual(normalizeCursor(''), { connector_cursor: null, high_watermark_sent_at: null, last_message_id: null });
  assert.equal(normalizeCursor('   ')?.connector_cursor, null);
});

test('normalizeCursor preserves a sane sync token', () => {
  assert.equal(normalizeCursor('s_next_token').connector_cursor, 's_next_token');
  assert.equal(normalizeCursor('1725192000.000300').connector_cursor, '1725192000.000300');
});

test('normalizeCursor rejects credential-shaped values', () => {
  assert.throws(() => normalizeCursor('bearer abcdefghijklmnopqrstuvwxyz0123456789'), /credential-shaped/);
  assert.throws(() => normalizeCursor('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signedpayload'), /credential-shaped/);
  // A numeric Telegram update_id is fine.
  assert.equal(normalizeCursor('123456789').connector_cursor, '123456789');
});

test('placeholderCursorKey is deterministic and length-bounded', () => {
  assert.equal(placeholderCursorKey('telegram', 'home-bot'), 'telegram__home-bot__cursor');
});

test('stableCursorFileSlug is deterministic', () => {
  assert.equal(stableCursorFileSlug('matrix/home-account'), stableCursorFileSlug('matrix/home-account'));
  assert.notEqual(stableCursorFileSlug('matrix/a'), stableCursorFileSlug('matrix/b'));
});