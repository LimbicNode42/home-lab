import { execFile as execFileCallback } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_BACKUP_MANIFEST = 'MANIFEST.txt';
const DEFAULT_MEM0_DOCS_PATH = '/docs';
const DEFAULT_MEM0_OPENAPI_PATH = '/openapi.json';
const DEFAULT_MEM0_SEARCH_PATH = '/search';
const DEFAULT_MEM0_LOG_SINCE_SECONDS = 900;
const DEFAULT_MEM0_LOG_TAIL = 200;
const DEFAULT_MEM0_ERROR_PATTERN = 'datastore|database|postgres|pgvector|connection.*closed|closed.*connection|502';
const execFile = promisify(execFileCallback);

function hoursBetween(now, then) {
  return Math.round(((now - then) / 3_600_000) * 10) / 10;
}

function formatAgeHours(ageHours) {
  if (!Number.isFinite(ageHours)) return 'unknown age';
  if (ageHours < 1) return `${Math.round(ageHours * 60)} minutes ago`;
  return `${ageHours} hours ago`;
}

function checkIdentity(check) {
  return {
    id: check.id,
    label: check.label,
    ...(check.displayUrl ? { displayUrl: check.displayUrl } : {})
  };
}

function joinUrl(baseUrl, path) {
  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function safeErrorCode(error) {
  if (error?.name === 'AbortError') return 'timeout';
  if (error?.code === 'ENOENT') return 'command_unavailable';
  return 'request_failed';
}

function containerStateFromDockerInspect(stdout) {
  const state = JSON.parse(String(stdout || '{}'));
  const health = state.Health?.Status ?? null;
  return {
    running: Boolean(state.Running),
    health,
    status: Boolean(state.Running) && (!health || health === 'healthy') ? 'up' : 'down'
  };
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(DEFAULT_MEM0_ERROR_PATTERN, 'i');
  }
}

export class StatusService {
  constructor({
    checks = [],
    ttlMs = 30_000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    execFileImpl = execFile,
    env = process.env
  } = {}) {
    this.checks = checks;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.execFileImpl = execFileImpl;
    this.env = env;
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
    if (check.type === 'mem0Health') {
      return this.probeMem0Health(check);
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
          ...checkIdentity(check),
          status: 'down',
          error: 'backup_not_found',
          message: 'No completed backup manifest found',
          latencyMs: Date.now() - started,
          checkedAt: new Date().toISOString()
        };
      }

      const ageHours = hoursBetween(Date.now(), newest.mtimeMs);
      const maxAgeHours = Number(check.maxAgeHours ?? 36);
      const fresh = Number.isFinite(ageHours) && ageHours <= maxAgeHours;
      return {
        ...checkIdentity(check),
        status: fresh ? 'up' : 'stale',
        latencyMs: Date.now() - started,
        updatedAt: newest.mtime.toISOString(),
        checkedAt: new Date().toISOString(),
        ageHours,
        message: `latest backup manifest ${formatAgeHours(ageHours)}`,
        ...(fresh ? {} : { error: 'backup_stale' })
      };
    } catch {
      return {
        ...checkIdentity(check),
        status: 'down',
        error: 'backup_unavailable',
        message: 'Backup directory is unavailable',
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString()
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
        ...checkIdentity(check),
        status: response.ok || response.status === 204 || response.status === 301 || response.status === 302 ? 'up' : 'down',
        httpStatus: response.status,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        ...checkIdentity(check),
        status: 'down',
        error: safeErrorCode(error),
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString()
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async probeMem0Health(check) {
    const started = Date.now();
    const baseUrl = check.baseUrl;
    const details = [];
    let status = 'up';
    let error;

    const docs = await this.fetchMem0Get(joinUrl(baseUrl, check.docsPath ?? DEFAULT_MEM0_DOCS_PATH));
    if (docs.ok) {
      details.push('docs reachable');
    } else {
      status = 'down';
      error = docs.error;
      details.push('docs unreachable');
    }

    const openapi = await this.fetchMem0Get(joinUrl(baseUrl, check.openapiPath ?? DEFAULT_MEM0_OPENAPI_PATH));
    if (openapi.ok) {
      details.push('openapi reachable');
    } else {
      status = 'down';
      error ??= openapi.error;
      details.push('openapi unreachable');
    }

    const apiKey = check.apiKeyEnv ? this.env?.[check.apiKeyEnv] : null;
    if (check.apiKeyEnv && !apiKey) {
      if (status === 'up') status = 'stale';
      error ??= 'auth_not_configured';
      details.push('memory search auth not configured');
    } else if (apiKey) {
      const search = await this.probeMem0Search(joinUrl(baseUrl, check.searchPath ?? DEFAULT_MEM0_SEARCH_PATH), apiKey, check.searchUserId);
      if (search.ok) {
        details.push('memory search reachable');
      } else {
        status = 'down';
        error = search.error;
        details.push('memory search failed');
      }
    } else {
      details.push('memory search skipped');
    }

    const containerResult = await this.probeDockerContainers(check.dockerContainers ?? []);
    if (containerResult.error === 'container_unhealthy' || containerResult.error === 'container_missing') {
      status = 'down';
      error = containerResult.error;
    }
    if (containerResult.message) details.push(containerResult.message);

    const logs = await this.probeRecentMem0Errors(check);
    if (logs.errorCount > 0) {
      if (status === 'up') status = 'stale';
      error ??= 'recent_datastore_errors';
      details.push(`${logs.errorCount} recent datastore/log error signal${logs.errorCount === 1 ? '' : 's'}`);
    } else if (logs.checked) {
      details.push('no recent datastore error signals');
    } else if (logs.message) {
      details.push(logs.message);
    }

    return {
      ...checkIdentity(check),
      status,
      ...(error ? { error } : {}),
      message: details.join('; '),
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString()
    };
  }

  async fetchMem0Get(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
      return { ok: response.ok || response.status === 301 || response.status === 302, status: response.status, error: response.ok ? null : 'api_unreachable' };
    } catch (error) {
      return { ok: false, error: safeErrorCode(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async probeMem0Search(url, apiKey, userId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({
          query: 'dashboard readiness smoke',
          user_id: userId ?? 'dashboard-smoke',
          top_k: 1
        })
      });
      if (response.ok) return { ok: true, status: response.status };
      if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, error: 'auth_failed' };
      if (response.status === 500 || response.status === 502 || response.status === 503) return { ok: false, status: response.status, error: 'datastore_unavailable' };
      return { ok: false, status: response.status, error: 'search_failed' };
    } catch (error) {
      return { ok: false, error: safeErrorCode(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async probeDockerContainers(containers) {
    if (!Array.isArray(containers) || containers.length === 0) return {};
    const states = [];
    for (const name of containers) {
      try {
        const { stdout } = await this.execFileImpl('docker', ['inspect', '--format', '{{json .State}}', name], { timeout: this.timeoutMs });
        states.push(containerStateFromDockerInspect(stdout));
      } catch (error) {
        if (error?.code === 'ENOENT') return { message: 'container health unavailable' };
        return { error: 'container_missing', message: 'container health failed' };
      }
    }
    if (states.some((state) => state.status !== 'up')) {
      return { error: 'container_unhealthy', message: 'one or more containers unhealthy' };
    }
    return { message: `${states.length} container${states.length === 1 ? '' : 's'} healthy` };
  }

  async probeRecentMem0Errors(check) {
    const containers = check.logContainers ?? check.dockerContainers ?? [];
    if (!Array.isArray(containers) || containers.length === 0) return {};
    const pattern = safeRegex(check.logErrorPattern ?? DEFAULT_MEM0_ERROR_PATTERN);
    let errorCount = 0;
    let checked = false;
    for (const name of containers) {
      try {
        const since = `${Number(check.logSinceSeconds ?? DEFAULT_MEM0_LOG_SINCE_SECONDS)}s`;
        const tail = String(Number(check.logTail ?? DEFAULT_MEM0_LOG_TAIL));
        const { stdout = '', stderr = '' } = await this.execFileImpl('docker', ['logs', '--since', since, '--tail', tail, name], { timeout: this.timeoutMs });
        checked = true;
        const combined = `${stdout}\n${stderr}`;
        for (const line of combined.split(/\r?\n/)) {
          if (pattern.test(line)) errorCount += 1;
        }
      } catch (error) {
        if (error?.code === 'ENOENT') return { checked: false, message: 'recent log scan unavailable' };
      }
    }
    return { checked, errorCount };
  }
}
