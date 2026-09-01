import { validateReadOnlyMessageStream } from './stream.js';

export class ConnectorRegistry {
  constructor(connectors = []) {
    this.connectors = new Map();
    for (const connector of connectors) this.register(connector);
  }

  key(source, accountRef) { return `${source}/${accountRef}`; }

  register(connector) {
    validateReadOnlyMessageStream(connector);
    const id = this.key(connector.source, connector.accountRef);
    if (this.connectors.has(id)) throw new Error(`Connector ${id} is already registered`);
    this.connectors.set(id, connector);
    return connector;
  }

  get(source, accountRef) { return this.connectors.get(this.key(source, accountRef)) ?? null; }

  list() {
    return [...this.connectors.entries()].map(([id, connector]) => ({ id, source: connector.source, accountRef: connector.accountRef }));
  }

  values() { return [...this.connectors.values()]; }
}
