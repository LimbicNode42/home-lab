import { ConnectorRegistry } from './connectors/registry.js';
import { dedupeKey, validateEnvelope } from './envelope.js';
import { sanitizeForLog } from './redaction.js';

export class BackoffPolicy {
  constructor({ baseMs = 1000, maxMs = 60000 } = {}) { this.baseMs = baseMs; this.maxMs = maxMs; }
  delayForAttempt(attempt) { return Math.min(this.maxMs, this.baseMs * 2 ** Math.max(0, attempt - 1)); }
}

export class IngestService {
  constructor({ connectors = [], registry = null, store, now = () => new Date().toISOString(), backoff = new BackoffPolicy() }) {
    this.registry = registry ?? new ConnectorRegistry(connectors);
    this.store = store;
    this.now = now;
    this.backoff = backoff;
  }

  async runOnce(limits = { max_messages: 100, max_runtime_ms: 30000 }) {
    const result = { checked_at: this.now(), ingested: 0, duplicates: 0, errors: [], batches: [] };
    for (const connector of this.registry.values()) {
      try {
        for await (const batch of connector.sync(null, limits)) {
          const envelopes = [];
          const seen = new Set();
          for (const rawRef of batch.raw_refs ?? []) {
            const normalized = validateEnvelope(await connector.normalize(rawRef));
            const key = dedupeKey(normalized);
            if (seen.has(key) || await this.store.hasEnvelope(normalized)) {
              result.duplicates += 1;
              continue;
            }
            seen.add(key);
            envelopes.push(normalized);
          }
          const manifest = await this.store.appendBatch({ batchId: batch.ingest_batch_id, envelopes });
          result.ingested += manifest.record_count;
          result.batches.push(manifest);
        }
      } catch (error) {
        result.errors.push(sanitizeForLog({ source: connector.source, accountRef: connector.accountRef, error: error.message, next_retry_ms: this.backoff.delayForAttempt(1) }));
      }
    }
    return result;
  }
}
