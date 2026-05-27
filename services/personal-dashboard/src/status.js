const DEFAULT_TIMEOUT_MS = 2500;

export class StatusService {
  constructor({ checks = [], ttlMs = 30_000, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    this.checks = checks;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.cache = null;
  }

  async getStatus() {
    const now = Date.now();
    if (this.cache && now - this.cache.createdAt < this.ttlMs) {
      return this.cache.payload;
    }

    const checks = await Promise.all(this.checks.map((check) => this.probe(check)));
    const payload = {
      generatedAt: new Date(now).toISOString(),
      checks
    };
    this.cache = { createdAt: now, payload };
    return payload;
  }

  async probe(check) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(check.targetUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal
      });
      return {
        id: check.id,
        label: check.label,
        status: response.ok || response.status === 204 || response.status === 301 || response.status === 302 ? 'up' : 'down',
        httpStatus: response.status,
        latencyMs: Date.now() - started,
        ...(check.displayUrl ? { displayUrl: check.displayUrl } : {})
      };
    } catch (error) {
      return {
        id: check.id,
        label: check.label,
        status: 'down',
        error: error.name === 'AbortError' ? 'timeout' : 'request_failed',
        latencyMs: Date.now() - started,
        ...(check.displayUrl ? { displayUrl: check.displayUrl } : {})
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
