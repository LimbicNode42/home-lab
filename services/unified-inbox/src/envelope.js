const CANONICAL_FIELDS = [
  'source', 'account_ref', 'conversation_id', 'conversation_title', 'thread_id', 'message_id', 'sender',
  'sent_at', 'received_at', 'body_text', 'attachment_refs', 'read_state', 'permalink', 'raw_ref', 'ingest_batch_id'
];

const READ_STATES = new Set(['unknown', 'unread', 'read']);
const SECRET_QUERY_KEYS = /(?:^|[?&])(token|api[_-]?key|key|authorization|auth|access_token|refresh_token|signature|sig)=/i;

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Envelope field ${field} must be a non-empty string`);
  return value;
}

export function isUtcIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().startsWith(value.replace('.000Z', ''));
}

export function validatePermalink(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Envelope field permalink must be a string or null');
  let url;
  try { url = new URL(value); } catch { throw new Error('Envelope field permalink must be a valid http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Envelope field permalink must be http(s)');
  if (SECRET_QUERY_KEYS.test(url.search)) throw new Error('Envelope field permalink contains a secret-shaped query parameter');
  return url.toString();
}

export function dedupeKey(envelope) {
  return `${envelope.source}\u0000${envelope.account_ref}\u0000${envelope.message_id}`;
}

export function validateEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Envelope must be an object');
  for (const field of CANONICAL_FIELDS) {
    if (!(field in input) || input[field] === undefined) throw new Error(`Envelope missing canonical field ${field}`);
  }
  const output = {};
  output.source = requireString(input.source, 'source');
  output.account_ref = requireString(input.account_ref, 'account_ref');
  output.conversation_id = requireString(input.conversation_id, 'conversation_id');
  output.conversation_title = input.conversation_title == null ? null : String(input.conversation_title);
  output.thread_id = input.thread_id == null ? null : String(input.thread_id);
  output.message_id = requireString(input.message_id, 'message_id');
  if (!input.sender || typeof input.sender !== 'object' || Array.isArray(input.sender)) throw new Error('Envelope field sender must be an object');
  output.sender = {
    id: input.sender.id == null ? null : String(input.sender.id),
    display_name: input.sender.display_name == null ? null : String(input.sender.display_name),
    handle: input.sender.handle == null ? null : String(input.sender.handle)
  };
  if (!isUtcIsoTimestamp(input.sent_at)) throw new Error('Envelope field sent_at must be UTC ISO-8601 ending in Z');
  if (!isUtcIsoTimestamp(input.received_at)) throw new Error('Envelope field received_at must be UTC ISO-8601 ending in Z');
  output.sent_at = input.sent_at;
  output.received_at = input.received_at;
  output.body_text = input.body_text == null ? null : String(input.body_text);
  if (!Array.isArray(input.attachment_refs)) throw new Error('Envelope field attachment_refs must be an array');
  output.attachment_refs = input.attachment_refs.map((ref) => ({ ...ref }));
  if (typeof input.read_state !== 'string' || input.read_state.trim() === '') throw new Error('Envelope field read_state must be a string');
  if (!READ_STATES.has(input.read_state)) throw new Error('Envelope field read_state must be one of unknown, unread, read');
  output.read_state = input.read_state;
  output.permalink = validatePermalink(input.permalink);
  if (input.raw_ref == null || (typeof input.raw_ref !== 'object' && typeof input.raw_ref !== 'string')) throw new Error('Envelope field raw_ref must be an object or string reference');
  output.raw_ref = typeof input.raw_ref === 'object' ? { ...input.raw_ref } : input.raw_ref;
  output.ingest_batch_id = requireString(input.ingest_batch_id, 'ingest_batch_id');
  return output;
}

export { CANONICAL_FIELDS };
