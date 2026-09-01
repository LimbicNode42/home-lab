const SECRET_KEY_RE = /(?:authorization|bearer|token|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|database(?:_url)?)/i;
const SECRET_VALUE_RE = /(Authorization:\s*Bearer\s+[A-Za-z0-9._~+\/-]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,}|postgres(?:ql)?:\/\/[^\s"']+|[?&](?:token|api[_-]?key|key|authorization|access_token|refresh_token)=([^&\s]+)|\/root\/[^\s"']*|\/mnt\/nas\/[^\s"']*|\/app\/[^\s"']*)/i;

function redactString(value) {
  return value
    .replace(/Authorization:\s*Bearer\s+[^\s"']+/ig, 'Authorization: [REDACTED]')
    .replace(/Bearer\s+[^\s"']+/ig, 'Bearer [REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/ig, '[REDACTED_DATABASE_URL]')
    .replace(/([?&])(?:token|api[_-]?key|key|authorization|access_token|refresh_token)=[^&\s]+/ig, '$1redacted=[REDACTED]')
    .replace(/\/root\/[^\s"']*/g, '[REDACTED_LOCAL_PATH]')
    .replace(/\/mnt\/nas\/[^\s"']*/g, '[REDACTED_LOCAL_PATH]')
    .replace(/\/app\/[^\s"']*/g, '[REDACTED_LOCAL_PATH]');
}

export function sanitizeForLog(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_KEY_RE.test(key) ? '[REDACTED]' : sanitizeForLog(entry)]));
  }
  return '[REDACTED]';
}

export function assertNoSecretLeak(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (SECRET_VALUE_RE.test(serialized)) throw new Error('Refusing to emit secret-shaped or local-path output');
}
