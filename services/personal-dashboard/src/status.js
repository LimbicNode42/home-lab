import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_BACKUP_MANIFEST = 'MANIFEST.txt';

function hoursBetween(now, then) {
  return Math.round(((now - then) / 3_600_000) * 10) / 10;
}

function formatAgeHours(ageHours) {
  if (!Number.isFinite(ageHours)) return 'unknown age';
  if (ageHours < 1) return `${Math.round(ageHours * 60)} minutes ago`;
  return `${ageHours} hours ago`;
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

    const checks = await Promise.all(this.checks.map((check) => this.probe(check)));
    const payload = {
      generatedAt: new Date(now).toISOString(),
      checks
    };
    this.cache = { createdAt: now, payload };
    return payload;
  }

  async probe(check) {
    if (check.type === 'backupFreshness') {
      return this.probeBackupFreshness(check);
    }
    return this.probeHttp(check);
  }

  async probeBackupFreshness(check) {
    const started = Date.now();
    const manifestName = check.manifestFile ?? DEFAULT_BACKUP_MANIFEST;
    try {
      const entries = await readdir(check.backupDir, { withFileTypes: true });
      let newest = null;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const info = await stat(join(check.backupDir, entry.name, manifestName));
          if (!info.isFile()) continue;
          if (!newest || info.mtimeMs > newest.mtimeMs) {
            newest = { name: entry.name, mtimeMs: info.mtimeMs, mtime: info.mtime };
          }
        } catch {
          // Ignore incomplete backup directories; a manifest marks a finished run.
        }
      }

      if (!newest) {
        return {
          id: check.id,
          label: check.label,
          status: 'down',
          error: 'backup_not_found',
          message: 'No completed backup manifest found',
          latencyMs: Date.now() - started,
          ...(check.displayUrl ? { displayUrl: check.displayUrl } : {})
        };
      }

      const ageHours = hoursBetween(Date.now(), newest.mtimeMs);
      const maxAgeHours = Number(check.maxAgeHours ?? 36);
      const fresh = Number.isFinite(ageHours) && ageHours <= maxAgeHours;
      return {
        id: check.id,
        label: check.label,
        status: fresh ? 'up' : 'down',
        latencyMs: Date.now() - started,
        updatedAt: newest.mtime.toISOString(),
        ageHours,
        message: `latest backup manifest ${formatAgeHours(ageHours)}`,
        ...(fresh ? {} : { error: 'backup_stale' }),
        ...(check.displayUrl ? { displayUrl: check.displayUrl } : {})
      };
    } catch {
      return {
        id: check.id,
        label: check.label,
        status: 'down',
        error: 'backup_unavailable',
        message: 'Backup directory is unavailable',
        latencyMs: Date.now() - started,
        ...(check.displayUrl ? { displayUrl: check.displayUrl } : {})
      };
    }
  }

  async probeHttp(check) {
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
