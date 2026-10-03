import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { promisify } from 'node:util';

const DEFAULT_TIMEOUT_MS = 2500;
const CHECK_RESULT_STATUSES = new Set(['up', 'healthy', 'down', 'degraded', 'stale', 'unknown', 'not_deployed', 'not_configured']);
const GRAPHITI_DEFAULT_HEALTH_PATH = '/health';
const GRAPHITI_DEFAULT_READY_PATH = '/ready';
const DEFAULT_GRAPHITI_STATUS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEM0_DOCS_PATH = '/docs';
const DEFAULT_MEM0_OPENAPI_PATH = '/openapi.json';
const DEFAULT_MEM0_SEARCH_PATH = '/search';
const DEFAULT_MEM0_LOG_SINCE_SECONDS = 180;
const DEFAULT_MEM0_LOG_TAIL = 200;
const DEFAULT_MEM0_ERROR_PATTERN = '(datastore|pgvector|connection\\s+(?:closed|refused)|(?:closed|refused)\\s+connection|database\\s+(?:unavailable|error|failed|failure)|psycopg.*(?:error|closed)|5(?:02|03))';
const DEFAULT_MEM0_STATUS_STALE_AFTER_MS = 10 * 60 * 1000;
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


function safeIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
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
  constructor({ checks = [], ttlMs = 30_000, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, execFileImpl = execFile, tcpConnectImpl = netConnect, readFileImpl = readFile, env = process.env } = {}) {
    this.checks = checks;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.execFileImpl = execFileImpl;
    this.tcpConnectImpl = tcpConnectImpl;
    this.readFileImpl = readFileImpl;
    this.env = env;
    this.cache = null;
  }

  async getStatus() {
    const now = Date.now();
    if (this.cache && now - this.cache.createdAt < this.ttlMs) {
      return this.cache.payload;
    }

    const checkedAt = new Date(now).toISOString();
    const probedChecks = await Promise.all(this.checks.map((check) => this.probe(check, checkedAt)));
    const checks = probedChecks.flat();
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
    if (check.type === 'graphitiNeo4jHealth') {
      return this.probeGraphitiNeo4jHealth(check, checkedAt);
    }
    return this.probeHttp(check, checkedAt);
  }

  async probeGraphitiNeo4jHealth(check, checkedAt = new Date().toISOString()) {
    const receiptStatus = check.statusFile ? await this.readGraphitiStatusSnapshot(check, checkedAt) : null;
    const [graphiti, neo4j] = receiptStatus?.cards
      ? receiptStatus.cards
      : await Promise.all([
        this.probeGraphitiComponent(check, checkedAt),
        this.probeNeo4jComponent(check, checkedAt)
      ]);
    // The parent check carries a single human-readable status narrative that should
    // surface on both component cards (e.g. "blocked on Vaultwarden/OpenRouter
    // preflight"). It is non-secret prose, so safe to expose. componentIdentity has
    // already attached any per-component browser link.
    const detailText = check.statusDetail;
    const followUpText = check.unresolvedFollowUp;
    return [graphiti, neo4j].map((card) => ({
      ...card,
      ...(detailText ? { detail: detailText } : {}),
      ...(followUpText ? { unresolvedFollowUp: followUpText } : {})
    }));
  }

  async readGraphitiStatusSnapshot(check, checkedAt = new Date().toISOString()) {
    const started = Date.now();
    const graphitiIdentity = this.componentIdentity(check, 'graphiti', 'Graphiti operational/provenance graph');
    const neo4jIdentity = this.componentIdentity(check, 'neo4j', 'Neo4j graph database');
    let parsed;
    try {
      parsed = JSON.parse(await this.readFileImpl(check.statusFile, 'utf8'));
    } catch (error) {
      const message = error?.code === 'ENOENT'
        ? 'Graphiti/Neo4j status snapshot has not been published yet'
        : 'Graphiti/Neo4j status snapshot could not be read';
      const status = error?.code === 'ENOENT' ? 'not_configured' : 'stale';
      return {
        cards: [
          this.graphStatus(graphitiIdentity, status, started, message, 'graphiti_status_snapshot_unavailable', checkedAt),
          this.graphStatus(neo4jIdentity, status, started, message, 'graphiti_status_snapshot_unavailable', checkedAt)
        ]
      };
    }

    const receipt = this.summarizeGraphitiStatusSnapshot(parsed, check, checkedAt);
    const stale = receipt.isStale;
    const graphitiPassed = receipt.healthcheckPassed && receipt.ingestPassed && receipt.queryPassed;
    const neo4jPassed = receipt.neo4jReadinessPassed && receipt.backupPassed && receipt.restoreTestPassed;
    const graphitiStatus = graphitiPassed ? (stale ? 'stale' : 'healthy') : 'degraded';
    const neo4jStatus = neo4jPassed ? (stale ? 'stale' : 'healthy') : 'degraded';
    const graphitiMessage = graphitiPassed
      ? `Last Graphiti health/ingest/query smoke passed ${receipt.ingestAgeLabel}`
      : 'Graphiti health/ingest/query smoke is missing or failed in the latest snapshot';
    const neo4jMessage = neo4jPassed
      ? `Last Neo4j readiness/backup/restore check passed ${receipt.backupAgeLabel}`
      : 'Neo4j readiness/backup/restore evidence is missing or failed in the latest snapshot';
    return {
      cards: [
        {
          ...this.graphStatus(graphitiIdentity, graphitiStatus, started, graphitiMessage, graphitiStatus === 'healthy' ? null : (stale ? 'graphiti_status_stale' : 'graphiti_smoke_failed'), checkedAt),
          evidence: receipt.graphitiEvidence
        },
        {
          ...this.graphStatus(neo4jIdentity, neo4jStatus, started, neo4jMessage, neo4jStatus === 'healthy' ? null : (stale ? 'neo4j_status_stale' : 'neo4j_backup_or_readiness_failed'), checkedAt),
          evidence: receipt.neo4jEvidence
        }
      ]
    };
  }

  summarizeGraphitiStatusSnapshot(snapshot, check, checkedAt) {
    const createdAt = safeIsoTimestamp(snapshot.created_at_utc) ?? safeIsoTimestamp(snapshot.createdAt) ?? null;
    const ingest = snapshot.curated_ingest_and_query_smoke ?? {};
    const backup = snapshot.backup_and_restore ?? {};
    const live = snapshot.live_state_after_checks ?? {};
    const ingestAt = safeIsoTimestamp(ingest.timestamp_utc) ?? createdAt;
    const backupAt = safeIsoTimestamp(backup.timestamp_utc) ?? createdAt;
    const staleAfterMs = Number(check.statusFileStaleAfterMs ?? DEFAULT_GRAPHITI_STATUS_STALE_AFTER_MS);
    const newestSignalMs = Math.max(
      Date.parse(createdAt ?? '') || 0,
      Date.parse(ingestAt ?? '') || 0,
      Date.parse(backupAt ?? '') || 0
    );
    const ageMs = newestSignalMs ? Date.parse(checkedAt) - newestSignalMs : Number.POSITIVE_INFINITY;
    const isStale = !Number.isFinite(staleAfterMs) || staleAfterMs <= 0 ? false : ageMs > staleAfterMs;
    const ingestPassed = ingest.passed === true && ingest.ingest_actual?.status === 201;
    const queryPassed = ingest.passed === true && (ingest.query_actual?.status === 200) && Number(ingest.query_actual?.result_count ?? 0) > 0;
    const healthcheckPassed = live.healthcheck?.passed === true;
    const neo4jReadinessPassed = live.neo4j_readiness?.passed === true;
    const backupPassed = backup.passed === true && typeof backup.backup_size_bytes === 'number' && backup.backup_size_bytes > 0;
    const restoreTestPassed = backup.restore_test?.passed === true;
    return {
      healthcheckPassed,
      ingestPassed,
      queryPassed,
      neo4jReadinessPassed,
      backupPassed,
      restoreTestPassed,
      isStale,
      ingestAgeLabel: ingestAt ? `at ${ingestAt}` : 'in the latest snapshot',
      backupAgeLabel: backupAt ? `at ${backupAt}` : 'in the latest snapshot',
      graphitiEvidence: {
        service: 'Graphiti shared operational/provenance graph; mem0 remains separate personal/preference memory',
        snapshotCreatedAt: createdAt,
        lastIngestSmokeAt: ingestAt,
        lastQuerySmokeAt: ingestAt,
        healthcheckPassed,
        ingestPassed,
        queryPassed,
        sourceRef: typeof ingest.source_ref === 'string' ? ingest.source_ref : undefined,
        resultCount: Number.isFinite(Number(ingest.query_actual?.result_count)) ? Number(ingest.query_actual.result_count) : undefined,
        stale: isStale
      },
      neo4jEvidence: {
        service: 'Neo4j backing store for Graphiti operational/provenance graph',
        snapshotCreatedAt: createdAt,
        lastBackupAt: backupAt,
        readinessPassed: neo4jReadinessPassed,
        backupPassed,
        restoreTestPassed,
        backupSizeBytes: typeof backup.backup_size_bytes === 'number' ? backup.backup_size_bytes : undefined,
        liveDataStorage: backup.live_data_storage?.fstype ? `${backup.live_data_storage.fstype} local disk` : undefined,
        stale: isStale
      }
    };
  }

  componentIdentity(check, key, fallbackLabel) {
    const component = check[key] ?? {};
    return {
      id: component.id ?? `${check.id}-${key}`,
      label: component.label ?? fallbackLabel,
      component: key,
      ...(component.browserUrl ? { displayUrl: component.browserUrl } : {})
    };
  }

  async probeGraphitiComponent(check, checkedAt = new Date().toISOString()) {
    const started = Date.now();
    const graphiti = check.graphiti ?? {};
    const identity = this.componentIdentity(check, 'graphiti', 'Graphiti knowledge graph');
    if (graphiti.deployed === false) return this.graphStatus(identity, 'not_deployed', started, 'Graphiti is not deployed on this dashboard instance', null, checkedAt);
    const healthUrl = graphiti.healthUrl ?? (graphiti.baseUrl ? joinUrl(graphiti.baseUrl, graphiti.healthPath ?? GRAPHITI_DEFAULT_HEALTH_PATH) : null);
    const readinessUrl = graphiti.readinessUrl ?? (graphiti.baseUrl ? joinUrl(graphiti.baseUrl, graphiti.readinessPath ?? GRAPHITI_DEFAULT_READY_PATH) : null);
    const probes = [healthUrl ? ['health', healthUrl] : null, readinessUrl ? ['readiness', readinessUrl] : null].filter(Boolean);
    if (probes.length === 0) return this.graphStatus(identity, 'not_configured', started, 'Graphiti probe is not configured', null, checkedAt);
    const results = [];
    for (const [name, url] of probes) results.push({ name, ...(await this.probeGraphHttp(url)) });
    const okCount = results.filter((result) => result.ok).length;
    if (okCount === results.length) return this.graphStatus(identity, 'healthy', started, `Graphiti ${results.map((result) => result.name).join(' and ')} reachable`, null, checkedAt);
    if (okCount > 0) return this.graphStatus(identity, 'degraded', started, 'Graphiti partially reachable', 'graphiti_partial', checkedAt);
    return this.graphStatus(identity, 'down', started, 'Graphiti is not reachable', results.find((result) => result.error)?.error ?? 'graphiti_unreachable', checkedAt);
  }

  async probeNeo4jComponent(check, checkedAt = new Date().toISOString()) {
    const started = Date.now();
    const neo4j = check.neo4j ?? {};
    const identity = this.componentIdentity(check, 'neo4j', 'Neo4j graph database');
    if (neo4j.deployed === false) return this.graphStatus(identity, 'not_deployed', started, 'Neo4j is not deployed on this dashboard instance', null, checkedAt);
    const probes = [];
    if (neo4j.httpUrl) probes.push({ name: 'browser HTTP', run: () => this.probeGraphHttp(neo4j.httpUrl) });
    if (neo4j.boltHost && neo4j.boltPort) probes.push({ name: 'Bolt TCP', run: () => this.probeTcp(neo4j.boltHost, neo4j.boltPort) });
    if (probes.length === 0) return this.graphStatus(identity, 'not_configured', started, 'Neo4j probe is not configured', null, checkedAt);
    const results = [];
    for (const probe of probes) results.push({ name: probe.name, ...(await probe.run()) });
    const okCount = results.filter((result) => result.ok).length;
    if (okCount === results.length) return this.graphStatus(identity, 'healthy', started, `Neo4j ${results.map((result) => result.name).join(' and ')} reachable`, null, checkedAt);
    if (okCount > 0) return this.graphStatus(identity, 'degraded', started, 'Neo4j partially reachable', 'neo4j_partial', checkedAt);
    return this.graphStatus(identity, 'down', started, 'Neo4j is not reachable', results.find((result) => result.error)?.error ?? 'neo4j_unreachable', checkedAt);
  }

  graphStatus(identity, status, started, message, error, checkedAt = new Date().toISOString()) {
    return { ...identity, status, freshness: 'fresh', message, ...(error ? { error } : {}), latencyMs: Date.now() - started, checkedAt };
  }

  async probeGraphHttp(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
      const ok = response.ok || response.status === 204 || response.status === 301 || response.status === 302 || response.status === 401;
      return { ok, error: ok ? null : 'http_unreachable' };
    } catch (error) {
      return { ok: false, error: safeErrorCode(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async probeTcp(host, port) {
    return new Promise((resolve) => {
      let settled = false;
      let socket;
      let timeout;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket?.destroy?.();
        resolve(result);
      };
      try {
        socket = this.tcpConnectImpl({ host, port: Number(port) });
        timeout = setTimeout(() => done({ ok: false, error: 'timeout' }), this.timeoutMs);
        socket.once?.('connect', () => done({ ok: true, error: null }));
        socket.once?.('error', () => done({ ok: false, error: 'tcp_unreachable' }));
      } catch {
        done({ ok: false, error: 'tcp_unreachable' });
      }
    });
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
    if (check.statusFile) {
      return this.probeMem0StatusSnapshot(check, checkedAt);
    }

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

  async probeMem0StatusSnapshot(check, checkedAt = new Date().toISOString()) {
    const started = Date.now();
    let parsed;
    try {
      parsed = JSON.parse(await this.readFileImpl(check.statusFile, 'utf8'));
    } catch (error) {
      return {
        ...checkIdentity(check),
        status: error?.code === 'ENOENT' ? 'not_configured' : 'down',
        error: error?.code === 'ENOENT' ? 'mem0_status_snapshot_missing' : 'mem0_status_snapshot_unreadable',
        message: error?.code === 'ENOENT'
          ? 'Mem0 status snapshot has not been published yet'
          : 'Mem0 status snapshot could not be read',
        latencyMs: Date.now() - started,
        checkedAt,
        freshness: { checkedAt, cacheTtlMs: this.ttlMs },
        ...publicCheckMetadata(check)
      };
    }

    const receipt = this.summarizeMem0StatusSnapshot(parsed, check, checkedAt);
    const status = receipt.passed ? (receipt.isStale ? 'stale' : safeStatus(check.statusWhenHealthy, 'healthy')) : 'down';
    const message = receipt.passed
      ? `Latest mem0 publisher snapshot passed at ${receipt.createdAt ?? 'unknown time'}; ${receipt.summary}`
      : `Latest mem0 publisher snapshot failed or is incomplete at ${receipt.createdAt ?? 'unknown time'}; ${receipt.summary}`;
    return {
      ...checkIdentity(check),
      status,
      ...(status === 'healthy' ? {} : { error: receipt.isStale && receipt.passed ? 'mem0_status_stale' : 'mem0_status_failed' }),
      message,
      latencyMs: Date.now() - started,
      checkedAt,
      freshness: {
        checkedAt,
        cacheTtlMs: this.ttlMs,
        snapshotCreatedAt: receipt.createdAt,
        stale: receipt.isStale,
        staleAfterMs: receipt.staleAfterMs
      },
      evidence: receipt.evidence,
      ...publicCheckMetadata(check)
    };
  }

  summarizeMem0StatusSnapshot(snapshot, check, checkedAt) {
    const createdAt = safeIsoTimestamp(snapshot.generated_at_utc) ?? safeIsoTimestamp(snapshot.generatedAt) ?? null;
    const staleAfterMs = Number(check.statusFileStaleAfterMs ?? DEFAULT_MEM0_STATUS_STALE_AFTER_MS);
    const ageMs = createdAt ? Date.parse(checkedAt) - Date.parse(createdAt) : Number.POSITIVE_INFINITY;
    const isStale = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? ageMs > staleAfterMs : false;
    const checks = snapshot.checks ?? {};
    const docsPassed = checks.docs?.passed === true;
    const openapiPassed = checks.openapi?.passed === true;
    const containersPassed = checks.containers?.passed === true;
    const logsPassed = checks.logs?.passed === true;
    const profilesPassed = checks.hermes_profiles?.passed !== false;
    const passed = docsPassed && openapiPassed && containersPassed && logsPassed && profilesPassed;
    const containerText = Number.isFinite(Number(checks.containers?.healthy)) && Number.isFinite(Number(checks.containers?.total))
      ? `${Number(checks.containers.healthy)}/${Number(checks.containers.total)} containers healthy`
      : 'container health recorded';
    const logText = Number.isFinite(Number(checks.logs?.error_count))
      ? `${Number(checks.logs.error_count)} recent datastore/log error signals`
      : 'recent datastore/log scan recorded';
    return {
      createdAt,
      staleAfterMs,
      isStale,
      passed,
      summary: `docs ${docsPassed ? 'reachable' : 'failed'}, openapi ${openapiPassed ? 'reachable' : 'failed'}, ${containerText}, ${logText}`,
      evidence: {
        source: 'sanitized mem0 status publisher snapshot; memory contents and secrets are not exposed',
        snapshotCreatedAt: createdAt,
        docsPassed,
        openapiPassed,
        containersPassed,
        logsPassed,
        profilesPassed,
        stale: isStale
      }
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
