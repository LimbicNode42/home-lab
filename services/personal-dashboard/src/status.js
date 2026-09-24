import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_TIMEOUT_MS = 2500;
const CHECK_RESULT_STATUSES = new Set(['up', 'healthy', 'down', 'degraded', 'stale', 'unknown']);
const DEFAULT_MEM0_DOCS_PATH = '/docs';
const DEFAULT_MEM0_OPENAPI_PATH = '/openapi.json';
const DEFAULT_MEM0_SEARCH_PATH = '/search';
const DEFAULT_MEM0_LOG_SINCE_SECONDS = 900;
const DEFAULT_MEM0_LOG_TAIL = 200;
const DEFAULT_MEM0_ERROR_PATTERN = 'datastore|database|postgres|pgvector|connection.*closed|closed.*connection|502';
const execFile = promisify(execFileCallback);

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
    status: Boolean(state.Running) && (!health || health === 'healthy') ? 'healthy' : 'down'
  };
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(DEFAULT_MEM0_ERROR_PATTERN, 'i');
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function safeRemoteName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:@%/+,-]+$/.test(value);
}

function sshDestination(check) {
  if (!check.sshHost) return null;
  const user = check.sshUser ? `${check.sshUser}@` : '';
  return `${user}${check.sshHost}`;
}

function sshArgs(check, remoteCommand, timeoutMs) {
  const destination = sshDestination(check);
  if (!destination || !safeRemoteName(destination)) {
    throw Object.assign(new Error('invalid SSH destination'), { code: 'EINVAL' });
  }
  const port = String(check.sshPort ?? 22);
  if (!/^[0-9]{1,5}$/.test(port)) {
    throw Object.assign(new Error('invalid SSH port'), { code: 'EINVAL' });
  }
  const connectTimeout = Math.max(1, Math.ceil(Number(check.sshConnectTimeoutSeconds ?? timeoutMs / 1000)));
  return [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeout}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-p', port,
    destination,
    remoteCommand
  ];
}

function httpOkFromStatusCode(stdout) {
  const statusCode = Number(String(stdout || '').trim().slice(-3));
  return {
    ok: statusCode >= 200 && statusCode < 400,
    status: Number.isFinite(statusCode) ? statusCode : undefined,
    error: statusCode >= 200 && statusCode < 400 ? null : 'api_unreachable'
  };
}

export class StatusService {
  constructor({ checks = [], ttlMs = 30_000, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, execFileImpl = execFile, env = process.env } = {}) {
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
    if (check.type === 'mem0Health') {
      return this.probeMem0Health(check, checkedAt);
    }
    return this.probeHttp(check, checkedAt);
  }

  async probeHttp(check, checkedAt = new Date().toISOString()) {
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

  async probeMem0Health(check, checkedAt = new Date().toISOString()) {
    const started = Date.now();
    const baseUrl = check.baseUrl;
    const details = [];
    let status = safeStatus(check.statusWhenHealthy, 'healthy');
    let error;

    const docs = await this.probeMem0Get(check, joinUrl(baseUrl, check.docsPath ?? DEFAULT_MEM0_DOCS_PATH));
    if (docs.ok) {
      details.push('docs reachable');
    } else {
      status = 'down';
      error = docs.error;
      details.push('docs unreachable');
    }

    const openapi = await this.probeMem0Get(check, joinUrl(baseUrl, check.openapiPath ?? DEFAULT_MEM0_OPENAPI_PATH));
    if (openapi.ok) {
      details.push('openapi reachable');
    } else {
      status = 'down';
      error ??= openapi.error;
      details.push('openapi unreachable');
    }

    const apiKey = check.apiKeyEnv ? this.env?.[check.apiKeyEnv] : null;
    if (check.sshHost && check.apiKeyEnv) {
      if (status === 'healthy') status = 'stale';
      error ??= 'read_smoke_not_configured';
      details.push('read/search smoke skipped for SSH transport');
    } else if (check.apiKeyEnv && !apiKey) {
      if (status === 'healthy') status = 'stale';
      error ??= 'read_smoke_not_configured';
      details.push('read/search auth not configured');
    } else if (apiKey) {
      const search = await this.probeMem0Search(joinUrl(baseUrl, check.searchPath ?? DEFAULT_MEM0_SEARCH_PATH), apiKey, check.searchUserId);
      if (search.ok) {
        details.push('read/search reachable');
      } else {
        status = 'down';
        error = search.error;
        details.push('read/search failed');
      }
    } else {
      details.push('read/search skipped');
    }

    const containerResult = await this.probeDockerContainers(check, check.dockerContainers ?? []);
    if (containerResult.error === 'container_unhealthy' || containerResult.error === 'container_missing') {
      status = 'down';
      error = containerResult.error;
    }
    if (containerResult.message) details.push(containerResult.message);

    const logs = await this.probeRecentMem0Errors(check);
    if (logs.errorCount > 0) {
      if (status === 'healthy') status = 'degraded';
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
      checkedAt,
      freshness: { checkedAt, cacheTtlMs: this.ttlMs },
      ...publicCheckMetadata(check)
    };
  }

  async probeMem0Get(check, url) {
    if (check.sshHost) return this.fetchRemoteMem0Get(check, url);
    return this.fetchMem0Get(url);
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

  async fetchRemoteMem0Get(check, url) {
    try {
      const seconds = Math.max(1, Math.ceil(this.timeoutMs / 1000));
      const command = `curl -fsS -o /dev/null -w '%{http_code}' --max-time ${seconds} ${shellQuote(url)}`;
      const { stdout } = await this.execFileImpl('ssh', sshArgs(check, command, this.timeoutMs), { timeout: this.timeoutMs + 1000 });
      return httpOkFromStatusCode(stdout);
    } catch (error) {
      return { ok: false, error: safeErrorCode(error) };
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

  async runDockerCommand(check, dockerArgs) {
    if (!check.sshHost) {
      return this.execFileImpl('docker', dockerArgs, { timeout: this.timeoutMs });
    }
    const command = ['docker', ...dockerArgs.map(shellQuote)].join(' ');
    return this.execFileImpl('ssh', sshArgs(check, command, this.timeoutMs), { timeout: this.timeoutMs + 1000 });
  }

  async probeDockerContainers(check, containers) {
    if (!Array.isArray(containers) || containers.length === 0) return {};
    const states = [];
    for (const name of containers) {
      try {
        const { stdout } = await this.runDockerCommand(check, ['inspect', '--format', '{{json .State}}', name]);
        states.push(containerStateFromDockerInspect(stdout));
      } catch (error) {
        if (error?.code === 'ENOENT') return { message: 'container health unavailable' };
        return { error: 'container_missing', message: 'container health failed' };
      }
    }
    if (states.some((state) => state.status !== 'healthy')) {
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
        const { stdout = '', stderr = '' } = await this.runDockerCommand(check, ['logs', '--since', since, '--tail', tail, name]);
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
