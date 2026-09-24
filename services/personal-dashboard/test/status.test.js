import test from 'node:test';
import assert from 'node:assert/strict';

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
