// Shared helpers for connector sync cursors/tokens as sensitive runtime state.
//
// Connector cursors (Telegram update_id, Matrix `since` token, Slack per-channel
// cursor, Discord last-message id) are durable sync state but are NOT secrets in
// the credential sense — however they must still be treated as sensitive runtime
// state: serializable, never committed to Git, never written into repo fixtures,
// docs, logs, or dashboard output. This module centralizes that discipline.

import { createHash } from 'node:crypto';

// Deterministic, length-bounded placeholder key for tests/fixtures. This is a
// *reference label*, not a real sync token: it never contains an upstream value.
export function placeholderCursorKey(source, accountRef) {
  return `${source}__${accountRef}__cursor`;
}

// Normalize an upstream cursor value into the locked SyncCursor shape. Rejects
// values that look like credentials (long bearer-ish tokens) rather than letting
// them slip into cursor state or error output.
export function normalizeCursor(value) {
  if (value == null) return { connector_cursor: null, high_watermark_sent_at: null, last_message_id: null };
  const cursor = String(value).trim();
  if (cursor === '') return { connector_cursor: null, high_watermark_sent_at: null, last_message_id: null };
  // Defensive: a cursor must not carry a credential-shaped value. A sync token is
  // typically short (a numeric update_id, a base64 `since` token, a channel id).
  // If it resembles a long secret, refuse rather than store/emit it.
  if (/^(bearer\s+|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})/i.test(cursor)) {
    throw new Error('Refusing to treat a credential-shaped value as a sync cursor');
  }
  return { connector_cursor: cursor, high_watermark_sent_at: null, last_message_id: null };
}

// Non-cryptographic length-bounded slug used only to keep runtime cursor file
// names deterministic; never for message identity.
export function stableCursorFileSlug(value) {
  const s = String(value ?? '');
  return createHash('sha256').update(s).digest('hex').slice(0, 24);
}