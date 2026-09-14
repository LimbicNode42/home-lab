const DEFAULT_TIMEOUT_MS = 2500;
const CHECK_RESULT_STATUSES = new Set(['up', 'down', 'degraded', 'unknown']);

function safeStatus(value, fallback = 'unknown') {
  return CHECK_RESULT_STATUSES.has(value) ? value : fallback;
}

function publicCheckMetadata(check) {
  const metadata = {};
  if (check.displayUrl) metadata.displayUrl = check.displayUrl;
  if (check.statusDetail) metadata.detail = check.statusDetail;
  if (check.unresolvedFollowUp) metadata.unresolvedFollowUp = check.unresolvedFollowUp;
  return metadata;
}

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

    const checkedAt = new Date(now).toISOString();
    const checks = await Promise.all(this.checks.map((check) => this.probe(check, checkedAt)));
    const payload = {
      generatedAt: checkedAt,
      freshness: { checkedAt, cacheTtlMs: this.ttlMs, cacheState: 'fresh' },
      checks
    };
    this.cache = { createdAt: now, payload };
    return payload;
  }

  async probe(check, checkedAt = new Date().toISOString()) {
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(Number(check.timeoutMs)) ? Number(check.timeoutMs) : this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const acceptableStatuses = new Set(check.acceptableStatuses ?? [200, 204, 301, 302]);

    try {
      const response = await this.fetchImpl(check.targetUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal
      });
      const probeUp = response.ok || acceptableStatuses.has(response.status);
      const status = probeUp ? safeStatus(check.statusWhenUp, 'up') : 'down';
      return {
        id: check.id,
        label: check.label,
        status,
        httpStatus: response.status,
        latencyMs: Date.now() - started,
        checkedAt,
        freshness: { checkedAt, cacheTtlMs: this.ttlMs },
        ...publicCheckMetadata(check)
      };
    } catch (error) {
      return {
        id: check.id,
        label: check.label,
        status: 'down',
        error: error.name === 'AbortError' ? 'timeout' : 'request_failed',
        latencyMs: Date.now() - started,
        checkedAt,
        freshness: { checkedAt, cacheTtlMs: this.ttlMs },
        ...publicCheckMetadata(check)
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
