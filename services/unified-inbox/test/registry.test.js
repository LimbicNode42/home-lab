import test from 'node:test';
import assert from 'node:assert/strict';

import { ConnectorRegistry } from '../src/connectors/registry.js';

function makeConnector(overrides = {}) {
  return {
    source: 'rss',
    accountRef: 'default',
    async health() { return { state: 'disabled', checked_at: new Date(0).toISOString(), last_success_at: null, last_error_code: null, detail: 'not configured' }; },
    async *sync() {},
    async normalize() {},
    ...overrides
  };
}

test('ConnectorRegistry registers ReadOnlyMessageStream implementations by source/accountRef', () => {
  const registry = new ConnectorRegistry();
  const connector = makeConnector();
  registry.register(connector);
  assert.equal(registry.get('rss', 'default'), connector);
  assert.deepEqual(registry.list().map((entry) => entry.id), ['rss/default']);
});

test('ConnectorRegistry rejects mutator-shaped connectors', () => {
  const registry = new ConnectorRegistry();
  assert.throws(() => registry.register(makeConnector({ send: async () => {} })), /read-only.*send/i);
  assert.throws(() => registry.register(makeConnector({ markRead: async () => {} })), /read-only.*markRead/i);
});
