import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { StatusService } from '../src/status.js';

function dockerHealthyExec(_command, args) {
  if (args[0] === 'inspect') {
    return Promise.resolve({ stdout: JSON.stringify({ Running: true, Health: { Status: 'healthy' } }) });
  }
  if (args[0] === 'logs') {
    return Promise.resolve({ stdout: 'startup complete\n', stderr: '' });
  }
  throw new Error(`unexpected docker args: ${args.join(' ')}`);
}

function mem0Fetch({ searchStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/docs')) return new Response('<html>docs</html>', { status: 200 });
    if (String(url).endsWith('/openapi.json')) return Response.json({ openapi: '3.1.0' });
    if (String(url).endsWith('/search')) return Response.json({ results: [] }, { status: searchStatus });
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchImpl };
}

const mem0Check = {
  id: 'mem0-health',
  label: 'Mem0 memory provider',
  type: 'mem0Health',
  baseUrl: 'http://127.0.0.1:8888',
  apiKeyEnv: 'MEM0_API_KEY',
  searchUserId: 'dashboard-smoke',
  dockerContainers: ['mem0-mem0-1', 'mem0-postgres-1'],
  logContainers: ['mem0-mem0-1']
};

test('mem0Health reports API, authenticated read/search, containers, and freshness without leaking secrets', async () => {
  const { calls, fetchImpl } = mem0Fetch();
  const service = new StatusService({
    checks: [mem0Check],
    fetchImpl,
    execFileImpl: dockerHealthyExec,
    env: { MEM0_API_KEY: 'super-secret-test-key' }
  });

  const payload = await service.getStatus();
  const check = payload.checks[0];

  assert.equal(check.status, 'healthy');
  assert.match(check.message, /docs reachable/);
  assert.match(check.message, /read\/search reachable/);
  assert.match(check.message, /2 containers healthy/);
  assert.ok(check.checkedAt);
  assert.equal(check.freshness.checkedAt, check.checkedAt);
  assert.equal(JSON.stringify(check).includes('super-secret-test-key'), false);
  assert.equal(JSON.stringify(check).includes('127.0.0.1:8888'), false);
  const searchCall = calls.find((call) => String(call.url).endsWith('/search'));
  assert.equal(searchCall.options.headers['x-api-key'], 'super-secret-test-key');
  assert.equal(JSON.parse(searchCall.options.body).top_k, 1);
});

test('mem0Health can intentionally report degraded when read/search works but write/add is incident-degraded', async () => {
  const { fetchImpl } = mem0Fetch();
  const service = new StatusService({
    checks: [{ ...mem0Check, statusWhenHealthy: 'degraded', statusDetail: 'Write/add path is blocked by upstream LLM quota/access.' }],
    fetchImpl,
    execFileImpl: dockerHealthyExec,
    env: { MEM0_API_KEY: 'secret' }
  });

  const check = (await service.getStatus()).checks[0];

  assert.equal(check.status, 'degraded');
  assert.match(check.detail, /Write\/add path/);
  assert.match(check.message, /read\/search reachable/);
  assert.equal(JSON.stringify(check).includes('secret'), false);
});

test('mem0Health returns stale when read/search auth is not configured but liveness is reachable', async () => {
  const { fetchImpl } = mem0Fetch();
  const service = new StatusService({
    checks: [mem0Check],
    fetchImpl,
    execFileImpl: dockerHealthyExec,
    env: {}
  });

  const check = (await service.getStatus()).checks[0];

  assert.equal(check.status, 'stale');
  assert.equal(check.error, 'read_smoke_not_configured');
  assert.match(check.message, /auth not configured/);
});

test('mem0Health maps authenticated read/search failures to safe public errors', async () => {
  for (const [searchStatus, expectedError] of [[401, 'auth_failed'], [502, 'datastore_unavailable']]) {
    const { fetchImpl } = mem0Fetch({ searchStatus });
    const service = new StatusService({
      checks: [mem0Check],
      fetchImpl,
      execFileImpl: dockerHealthyExec,
      env: { MEM0_API_KEY: 'secret' }
    });

    const check = (await service.getStatus()).checks[0];

    assert.equal(check.status, 'down');
    assert.equal(check.error, expectedError);
    assert.equal(JSON.stringify(check).includes('secret'), false);
  }
});

test('mem0Health reports recent datastore log signals as degraded without exposing log lines', async () => {
  const { fetchImpl } = mem0Fetch();
  const execFileImpl = async (_command, args) => {
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ Running: true, Health: { Status: 'healthy' } }) };
    if (args[0] === 'logs') return { stdout: 'psycopg connection closed by datastore\nstack trace with /opt/mem0/data should not leak', stderr: '' };
    throw new Error('unexpected call');
  };
  const service = new StatusService({
    checks: [mem0Check],
    fetchImpl,
    execFileImpl,
    env: { MEM0_API_KEY: 'secret' }
  });

  const check = (await service.getStatus()).checks[0];

  assert.equal(check.status, 'degraded');
  assert.equal(check.error, 'recent_datastore_errors');
  assert.match(check.message, /1 recent datastore\/log error signal/);
  assert.equal(JSON.stringify(check).includes('/opt/mem0/data'), false);
});

test('mem0Health ignores benign PostgreSQL startup log lines', async () => {
  const { fetchImpl } = mem0Fetch();
  const execFileImpl = async (_command, args) => {
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ Running: true, Health: { Status: 'healthy' } }) };
    if (args[0] === 'logs') return { stdout: 'Connected to PostgreSQL database\nPostgreSQL startup complete\n', stderr: '' };
    throw new Error('unexpected call');
  };
  const service = new StatusService({
    checks: [mem0Check],
    fetchImpl,
    execFileImpl,
    env: { MEM0_API_KEY: 'secret' }
  });

  const check = (await service.getStatus()).checks[0];

  assert.equal(check.status, 'healthy');
  assert.equal(check.error, undefined);
  assert.match(check.message, /no recent datastore error signals/);
});


test('mem0Health ignores benign PostgreSQL startup lines while scanning recent logs', async () => {
  const { fetchImpl } = mem0Fetch();
  const execFileImpl = async (_command, args) => {
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ Running: true, Health: { Status: 'healthy' } }) };
    if (args[0] === 'logs') {
      return {
        stdout: 'PostgreSQL Database directory appears to contain a database; Skipping initialization\nPostgreSQL init process complete; ready for start up.\n',
        stderr: ''
      };
    }
    throw new Error('unexpected call');
  };
  const service = new StatusService({
    checks: [mem0Check],
    fetchImpl,
    execFileImpl,
    env: { MEM0_API_KEY: 'secret' }
  });

  const check = (await service.getStatus()).checks[0];

  assert.equal(check.status, 'healthy');
  assert.equal(check.error, undefined);
  assert.match(check.message, /no recent datastore error signals/);
});

test('mem0Health reports unhealthy containers as down when Docker is available', async () => {
  const { fetchImpl } = mem0Fetch();
  const execFileImpl = async (_command, args) => {
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ Running: true, Health: { Status: 'unhealthy' } }) };
    if (args[0] === 'logs') return { stdout: '', stderr: '' };
    throw new Error('unexpected call');
  };
  const service = new StatusService({
    checks: [mem0Check],
    fetchImpl,
    execFileImpl,
    env: { MEM0_API_KEY: 'secret' }
  });

  const check = (await service.getStatus()).checks[0];

  assert.equal(check.status, 'down');
  assert.equal(check.error, 'container_unhealthy');
});

test('mem0Health can probe localhost-only mem0 over SSH without exposing remote internals', async () => {
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push({ command, args });
    assert.equal(command, 'ssh');
    const remoteCommand = args.at(-1);
    if (remoteCommand.includes('curl')) return { stdout: '200', stderr: '' };
    if (remoteCommand.includes('inspect')) return { stdout: JSON.stringify({ Running: true, Health: { Status: 'healthy' } }) };
    if (remoteCommand.includes('logs')) return { stdout: 'startup complete\n', stderr: '' };
    throw new Error(`unexpected ssh command: ${remoteCommand}`);
  };
  const service = new StatusService({
    checks: [{ ...mem0Check, sshHost: '192.168.0.20', sshUser: 'root', sshPort: 22 }],
    fetchImpl: async () => { throw new Error('local fetch should not be used for SSH mem0'); },
    execFileImpl,
    env: { MEM0_API_KEY: 'super-secret-test-key' }
  });

  const check = (await service.getStatus()).checks[0];

  assert.equal(check.status, 'stale');
  assert.equal(check.error, 'read_smoke_not_configured');
  assert.match(check.message, /docs reachable/);
  assert.match(check.message, /openapi reachable/);
  assert.match(check.message, /read\/search smoke skipped for SSH transport/);
  assert.match(check.message, /2 containers healthy/);
  assert.equal(JSON.stringify(check).includes('192.168.0.20'), false);
  assert.equal(JSON.stringify(calls).includes('super-secret-test-key'), false);
});

test('mem0Health reports healthy from a sanitized publisher snapshot with freshness', async () => {
  const snapshot = {
    generated_at_utc: '2026-10-03T12:00:00Z',
    checks: {
      docs: { passed: true, http_status: 200 },
      openapi: { passed: true, http_status: 200 },
      containers: { passed: true, total: 2, healthy: 2 },
      logs: { passed: true, checked: true, error_count: 0 },
      hermes_profiles: { passed: true, profiles: { default: { provider: 'mem0', configured: true, enabled: true } } }
    }
  };
  const service = new StatusService({
    checks: [{ ...mem0Check, statusFile: '/app/mem0/status.json', statusFileStaleAfterMs: 600000 }],
    readFileImpl: async () => JSON.stringify(snapshot),
    fetchImpl: async () => { throw new Error('snapshot-backed mem0 should not fetch from the dashboard container'); },
    execFileImpl: async () => { throw new Error('snapshot-backed mem0 should not shell out from the dashboard container'); }
  });

  const check = await service.probe({ ...mem0Check, statusFile: '/app/mem0/status.json', statusFileStaleAfterMs: 600000 }, '2026-10-03T12:03:00Z');

  assert.equal(check.status, 'healthy');
  assert.equal(check.freshness.snapshotCreatedAt, '2026-10-03T12:00:00.000Z');
  assert.equal(check.freshness.stale, false);
  assert.equal(check.evidence.source.includes('memory contents'), true);
  assert.equal(JSON.stringify(check).includes('/app/mem0/status.json'), false);
});

test('mem0Health reports stale when the sanitized publisher snapshot is old', async () => {
  const snapshot = {
    generated_at_utc: '2026-10-03T12:00:00Z',
    checks: {
      docs: { passed: true },
      openapi: { passed: true },
      containers: { passed: true, total: 2, healthy: 2 },
      logs: { passed: true, error_count: 0 },
      hermes_profiles: { passed: true }
    }
  };
  const service = new StatusService({
    checks: [{ ...mem0Check, statusFile: '/app/mem0/status.json', statusFileStaleAfterMs: 600000 }],
    readFileImpl: async () => JSON.stringify(snapshot)
  });

  const check = await service.probe({ ...mem0Check, statusFile: '/app/mem0/status.json', statusFileStaleAfterMs: 600000 }, '2026-10-03T12:30:00Z');

  assert.equal(check.status, 'stale');
  assert.equal(check.error, 'mem0_status_stale');
  assert.equal(check.freshness.stale, true);
});


test('graphitiNeo4jHealth reports not deployed cards without exposing internal endpoints', async () => {
  const service = new StatusService({
    checks: [{
      id: 'knowledge-graph',
      label: 'Knowledge graph',
      type: 'graphitiNeo4jHealth',
      graphiti: { deployed: false },
      neo4j: { deployed: false }
    }],
    fetchImpl: async () => { throw new Error('not-deployed probes should not call fetch'); }
  });

  const payload = await service.getStatus();

  assert.equal(payload.checks.length, 2);
  assert.deepEqual(payload.checks.map((check) => check.status), ['not_deployed', 'not_deployed']);
  assert.match(payload.checks[0].message, /Graphiti is not deployed/);
  assert.match(payload.checks[1].message, /Neo4j is not deployed/);
  assert.equal(JSON.stringify(payload).includes('127.0.0.1'), false);
});

test('graphitiNeo4jHealth reports healthy Graphiti and Neo4j with safe browser link only when configured', async () => {
  const tcpCalls = [];
  const tcpConnectImpl = (options) => {
    tcpCalls.push(options);
    return {
      once(event, callback) {
        if (event === 'connect') queueMicrotask(callback);
        return this;
      },
      destroy() {}
    };
  };
  const fetchImpl = async (url) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1/);
    return new Response('', { status: 200 });
  };
  const service = new StatusService({
    checks: [{
      id: 'knowledge-graph',
      label: 'Knowledge graph',
      type: 'graphitiNeo4jHealth',
      graphiti: { baseUrl: 'http://127.0.0.1:8000' },
      neo4j: { httpUrl: 'http://127.0.0.1:7474', boltHost: '127.0.0.1', boltPort: 7687, browserUrl: 'https://neo4j-admin.example.test' }
    }],
    fetchImpl,
    tcpConnectImpl
  });

  const payload = await service.getStatus();
  const graphiti = payload.checks.find((check) => check.component === 'graphiti');
  const neo4j = payload.checks.find((check) => check.component === 'neo4j');

  assert.equal(graphiti.status, 'healthy');
  assert.equal(neo4j.status, 'healthy');
  assert.equal(neo4j.displayUrl, 'https://neo4j-admin.example.test');
  assert.equal(graphiti.displayUrl, undefined);
  assert.equal(tcpCalls[0].port, 7687);
  assert.equal(JSON.stringify(payload).includes('127.0.0.1'), false);
});

test('graphitiNeo4jHealth reports degraded when only one Neo4j probe is reachable', async () => {
  const service = new StatusService({
    checks: [{
      id: 'knowledge-graph',
      label: 'Knowledge graph',
      type: 'graphitiNeo4jHealth',
      graphiti: { deployed: false },
      neo4j: { httpUrl: 'http://127.0.0.1:7474', boltHost: '127.0.0.1', boltPort: 7687 }
    }],
    fetchImpl: async () => new Response('', { status: 200 }),
    tcpConnectImpl: () => ({
      once(event, callback) {
        if (event === 'error') queueMicrotask(callback);
        return this;
      },
      destroy() {}
    })
  });

  const neo4j = (await service.getStatus()).checks.find((check) => check.component === 'neo4j');

  assert.equal(neo4j.status, 'degraded');
  assert.equal(neo4j.error, 'neo4j_partial');
  assert.equal(neo4j.freshness, 'fresh');
});

test('graphitiNeo4jHealth reports not configured when probes are absent', async () => {
  const service = new StatusService({
    checks: [{ id: 'knowledge-graph', label: 'Knowledge graph', type: 'graphitiNeo4jHealth', graphiti: {}, neo4j: {} }]
  });

  const payload = await service.getStatus();

  assert.deepEqual(payload.checks.map((check) => check.status), ['not_configured', 'not_configured']);
  assert.ok(payload.checks.every((check) => check.checkedAt && check.freshness === 'fresh'));
});

test('graphitiNeo4jHealth surfaces blocked/degraded narrative on both component cards without leaking internals', async () => {
  const statusDetail = 'Graphiti/Neo4j not deployed: blocked on Vaultwarden/OpenRouter preflight. Config, deploy, backup, and restore-test automation are committed but not run live.';
  const unresolvedFollowUp = 'Unlock Vaultwarden (Homelab graphiti/openrouter) and rerun deploy-tori-local.sh --preflight-only.';
  const service = new StatusService({
    checks: [{
      id: 'knowledge-graph',
      label: 'Knowledge graph',
      type: 'graphitiNeo4jHealth',
      graphiti: { deployed: false },
      neo4j: { deployed: false },
      statusDetail,
      unresolvedFollowUp
    }],
    fetchImpl: async () => { throw new Error('not-deployed probes should not call fetch'); }
  });

  const payload = await service.getStatus();

  assert.equal(payload.checks.length, 2);
  for (const check of payload.checks) {
    assert.equal(check.status, 'not_deployed');
    assert.equal(check.detail, statusDetail);
    assert.equal(check.unresolvedFollowUp, unresolvedFollowUp);
    assert.equal(JSON.stringify(check).includes('127.0.0.1'), false);
    assert.equal(JSON.stringify(check).includes('password'), false);
    assert.equal(JSON.stringify(check).includes('api_key'), false);
  }
});


test('graphitiNeo4jHealth summarizes smoke and backup snapshot without leaking artifact paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graphiti-status-'));
  try {
    const statusFile = join(dir, 'latest-smoke-backup.json');
    await writeFile(statusFile, JSON.stringify({
      created_at_utc: '2026-10-02T10:56:00Z',
      live_state_after_checks: {
        healthcheck: { passed: true },
        neo4j_readiness: { passed: true }
      },
      curated_ingest_and_query_smoke: {
        timestamp_utc: '2026-10-02T10:23:56Z',
        source_ref: 'kanban:t_8a57f068:20261002T102356Z',
        ingest_actual: { status: 201, body: { success: true } },
        query_actual: { status: 200, result_count: 1 },
        passed: true
      },
      backup_and_restore: {
        timestamp_utc: '2026-10-02T10:36:58Z',
        backup_artifact_location: '/mnt/pve/NAS/services/graphiti/backups/neo4j-dumps/artifact.dump',
        backup_sha256: 'not-public',
        backup_size_bytes: 74127,
        restore_test: { passed: true },
        live_data_storage: { path: '/var/lib/graphiti/neo4j/data', fstype: 'ext4', source: '/dev/sda2' },
        passed: true
      }
    }));
    const service = new StatusService({
      checks: [{
        id: 'knowledge-graph',
        label: 'Knowledge graph',
        type: 'graphitiNeo4jHealth',
        statusFile,
        statusFileStaleAfterMs: 24 * 60 * 60 * 1000,
        graphiti: { label: 'Graphiti operational/provenance graph', deployed: true },
        neo4j: { label: 'Neo4j graph store', deployed: true },
        statusDetail: 'Graphiti is shared operational/provenance memory; mem0 remains personal/preference memory.'
      }]
    });

    const payload = await service.probeGraphitiNeo4jHealth(service.checks[0], '2026-10-02T11:00:00Z');
    const graphiti = payload.find((check) => check.component === 'graphiti');
    const neo4j = payload.find((check) => check.component === 'neo4j');

    assert.equal(graphiti.status, 'healthy');
    assert.equal(neo4j.status, 'healthy');
    assert.equal(graphiti.evidence.ingestPassed, true);
    assert.equal(graphiti.evidence.queryPassed, true);
    assert.equal(neo4j.evidence.backupPassed, true);
    assert.equal(neo4j.evidence.restoreTestPassed, true);
    assert.match(graphiti.evidence.service, /mem0 remains separate/);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('/mnt/pve/NAS'), false);
    assert.equal(serialized.includes('not-public'), false);
    assert.equal(serialized.includes('/var/lib/graphiti'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphitiMcpHealth summarizes safe MCP snapshot without leaking internals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graphiti-mcp-status-'));
  try {
    const statusFile = join(dir, 'latest-mcp-status.json');
    await writeFile(statusFile, JSON.stringify({
      schema: 'personal-dashboard.graphiti-mcp-status.v1',
      created_at_utc: '2026-10-03T13:00:00Z',
      service: 'Graphiti read-only MCP server',
      status: 'healthy',
      placement: 'separate stdio MCP server registered through MetaMCP/Hermes native MCP; raw Graphiti remains loopback-only',
      tools: ['graphiti_lookup_provenance', 'graphiti_search_facts', 'graphiti_status', 'graphiti_validate_curated_episode'],
      tool_count: 4,
      tested_tools: [
        { tool: 'graphiti_status', ok: true },
        { tool: 'graphiti_search_facts', ok: true }
      ],
      safety: {
        destructive_tools_exposed: false,
        unexpected_tools_exposed: false,
        raw_graphiti_public_route_created: false,
        mem0_provider_changed: false,
        secrets_included: false
      }
    }));
    const service = new StatusService({
      checks: [{
        id: 'graphiti-mcp',
        label: 'Graphiti MCP access',
        type: 'graphitiMcpHealth',
        statusFile,
        statusFileStaleAfterMs: 600000
      }]
    });

    const check = await service.probe(service.checks[0], '2026-10-03T13:04:00Z');

    assert.equal(check.status, 'healthy');
    assert.equal(check.evidence.toolCount, 4);
    assert.equal(check.evidence.destructiveToolsExposed, false);
    assert.equal(check.evidence.unexpectedToolsExposed, false);
    assert.equal(check.evidence.secretsIncluded, false);
    assert.match(check.evidence.service, /mem0 remains separate/);
    const serialized = JSON.stringify(check);
    assert.equal(serialized.includes('/opt/graphiti'), false);
    assert.equal(serialized.includes('127.0.0.1:8000'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphitiMcpHealth degrades if the MCP tool contract exposes destructive tools', async () => {
  const service = new StatusService({
    checks: [{ id: 'graphiti-mcp', label: 'Graphiti MCP access', type: 'graphitiMcpHealth', statusFile: '/unused' }],
    readFileImpl: async () => JSON.stringify({
      created_at_utc: '2026-10-03T13:00:00Z',
      status: 'healthy',
      tools: ['graphiti_status', 'graphiti_delete_everything'],
      tool_count: 2,
      safety: { destructive_tools_exposed: true, unexpected_tools_exposed: true, secrets_included: false }
    })
  });

  const check = await service.probe(service.checks[0], '2026-10-03T13:01:00Z');

  assert.equal(check.status, 'degraded');
  assert.equal(check.error, 'graphiti_mcp_safety_check_failed');
});
