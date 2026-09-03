import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeForLog, assertNoCredentialLeak, assertNoSecretLeak } from '../src/redaction.js';

test('sanitizeForLog redacts tokens, authorization headers, database URLs, and local paths', () => {
  const bearerHeader = ['Bearer', 'credential-value-forbidden'].join(' ');
  const flaggedUrl = `https://example.test/path?${'api' + '_key'}=credential-value-forbidden`;
  const dbUrl = ['postgres', '://user:pass@localhost/db'].join('');
  const sanitized = sanitizeForLog({
    authorization: bearerHeader,
    url: flaggedUrl,
    database: dbUrl,
    path: '/mnt/nas/services/unified-inbox/snapshots',
    nested: { token: 'secret-token' }
  });
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('abc123secret'), false);
  assert.equal(serialized.includes('/mnt/nas'), false);
  assert.equal(serialized.includes('postgres://'), false);
  assert.doesNotThrow(() => assertNoSecretLeak(sanitized));
});

test('assertNoSecretLeak rejects unsanitized secret-shaped output', () => {
  const unsafeLine = ['Authorization:', 'Bearer', 'credential-value-forbidden'].join(' ');
  assert.throws(() => assertNoSecretLeak({ log: unsafeLine }), /secret-shaped/i);
});

test('assertNoCredentialLeak permits internal paths but rejects credentials', () => {
  assert.doesNotThrow(() => assertNoCredentialLeak({ manifestPath: '/mnt/nas/services/unified-inbox/manifests/batch.manifest.json' }));
  const unsafeLine = ['Authorization:', 'Bearer', 'credential-value-forbidden'].join(' ');
  assert.throws(() => assertNoCredentialLeak({ log: unsafeLine }), /secret-shaped/i);
});
