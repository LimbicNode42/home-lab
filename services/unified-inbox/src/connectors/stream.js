export class ReadOnlyMessageStream {
  constructor({ source, accountRef }) {
    this.source = source;
    this.accountRef = accountRef;
  }

  async health() { throw new Error('health() must be implemented by connector'); }
  async *sync(_cursor, _limits) { throw new Error('sync() must be implemented by connector'); }
  async normalize(_rawRef) { throw new Error('normalize() must be implemented by connector'); }
}

export const MUTATOR_METHOD_NAMES = ['send', 'reply', 'delete', 'markRead', 'archive', 'react', 'move', 'flag'];

export function validateReadOnlyMessageStream(connector) {
  if (!connector || typeof connector !== 'object') throw new Error('Connector must be an object');
  if (typeof connector.source !== 'string' || connector.source.trim() === '') throw new Error('Connector source is required');
  if (typeof connector.accountRef !== 'string' || connector.accountRef.trim() === '') throw new Error('Connector accountRef is required');
  for (const method of ['health', 'sync', 'normalize']) {
    if (typeof connector[method] !== 'function') throw new Error(`Connector must implement ${method}()`);
  }
  for (const method of MUTATOR_METHOD_NAMES) {
    if (typeof connector[method] === 'function') throw new Error(`Connector must be read-only; mutator method ${method} is not allowed`);
  }
  return connector;
}
