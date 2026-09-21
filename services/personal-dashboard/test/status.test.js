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

test('mem0Health reports API, authenticated search, containers, and checked time without leaking secrets', async () => {
  const { calls, fetchImpl } = mem0Fetch();
  const service = new StatusService({
    checks: [mem0Check],
    fetchImpl,
    execFileImpl: dockerHealthyExec,
    env: { MEM0_API_KEY: 'super-secret-test-key' }
  });

  const payload = await service.getStatus();
  const check = payload.checks[0];

  assert.equal(check.status, 'up');
  assert.match(check.message, /docs reachable/);
  assert.match(check.message, /memory search reachable/);
  assert.match(check.message, /2 containers healthy/);
  assert.ok(check.checkedAt);
  assert.equal(JSON.stringify(check).includes('super-secret-test-key'), false);
  assert.equal(JSON.stringify(check).includes('127.0.0.1:8888'), false);
  const searchCall = calls.find((call) => String(call.url).endsWith('/search'));
  assert.equal(searchCall.options.headers['x-api-key'], 'super-secret-test-key');
  assert.equal(JSON.parse(searchCall.options.body).top_k, 1);
});

test('mem0Health returns stale when auth key is not configured but liveness is reachable', async () => {
  const { fetchImpl } = mem0Fetch();
  const service = new StatusService({
    checks: [mem0Check],
    fetchImpl,
    execFileImpl: dockerHealthyExec,
    env: {}
  });

  const check = (await service.getStatus()).checks[0];

  assert.equal(check.status, 'stale');
  assert.equal(check.error, 'auth_not_configured');
  assert.match(check.message, /auth not configured/);
});

test('mem0Health maps authenticated search failures to safe public errors', async () => {
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

test('mem0Health reports recent datastore log signals as stale without exposing log lines', async () => {
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

  assert.equal(check.status, 'stale');
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
