// Shared normalize helpers for connectors. These produce candidate envelopes
// in the locked canonical shape; final validation happens in envelope.js
// (validateEnvelope). Connectors must not store secret material here.

const CONVERSATION_ID_FALLBACK_SEP = '__';

// Deterministic connector-local conversation id when the upstream has none.
export function fallbackConversationId(source, accountRef, value) {
  return `${source}${CONVERSATION_ID_FALLBACK_SEP}${accountRef}${CONVERSATION_ID_FALLBACK_SEP}${hashSlug(value)}`;
}

// Non-cryptographic stable slug used only to keep fallback ids deterministic
// and length-bounded (not for integrity or identity of message records).
export function hashSlug(value) {
  const s = String(value ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// Build a sender object, sanitized. No assumptions about upstream shape.
export function makeSender({ id = null, display_name = null, handle = null } = {}) {
  const sender = {
    id: id == null ? null : String(id),
    display_name: display_name == null ? null : String(display_name),
    handle: handle == null ? null : String(handle)
  };
  // Emails are addresses; do not let a handle carry a query token.
  if (sender.handle != null && /[?&](token|api[_-]?key|key|authorization|access_token|refresh_token)=/i.test(sender.handle)) {
    sender.handle = null;
  }
  return sender;
}

// Strip a raw body to a plain-text projection. Phase-1 baseline keeps this
// intentionally conservative: collapse whitespace, drop control characters.
export function plainTextProjection(value) {
  if (value == null) return null;
  const s = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s === '' ? null : s;
}

// Normalize an ISO-ish upstream timestamp to UTC ISO-8601 ending in 'Z'.
// Returns null when the input cannot be parsed to a valid date.
export function toUtcIsoTimestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString();
}