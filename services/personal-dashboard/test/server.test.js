import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { createApp } from '../src/server.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-server-'));
  const path = join(dir, 'dashboard.public.json');
  await writeFile(path, JSON.stringify(config), 'utf8');
  return path;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  };
}

const basicConfig = {
  title: 'Home Dashboard',
  sections: [{ title: 'Core', links: [{ label: 'Vaultwarden', href: 'https://vault.example.test' }] }],
  statusChecks: []
};

test('GET /healthz is unauthenticated and does not leak topology', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy' });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/healthz`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: 'ok' });
    assert.equal(JSON.stringify(body).includes('vault'), false);
  } finally {
    await server.close();
  }
});

test('authenticated APIs reject requests without the reverse proxy identity header', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user' });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/config/public`);
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('authenticated APIs allow requests with the reverse proxy identity header', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user' });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/config/public`, {
      headers: { 'x-forwarded-user': 'ben' }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.title, 'Home Dashboard');
  } finally {
    await server.close();
  }
});

test('disabled auth is refused in production unless explicitly allowed', async () => {
  const configPath = await writeConfig(basicConfig);
  await assert.rejects(
    () => createApp({ configPath, authMode: 'disabled', nodeEnv: 'production', allowDisabledAuth: false }),
    /disabled auth/i
  );
});

test('GET /api/status probes configured targets and hides target URLs', async () => {
  const probe = await listen((_request, response) => {
    response.writeHead(204).end();
  });
  const configPath = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [{ id: 'probe', label: 'Probe', targetUrl: `${probe.baseUrl}/ready`, displayUrl: 'https://probe.example.test' }]
  });
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, statusCacheTtlMs: 1000 });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.checks[0].id, 'probe');
    assert.equal(body.checks[0].status, 'up');
    assert.equal(JSON.stringify(body).includes(probe.baseUrl), false);
  } finally {
    await server.close();
    await probe.close();
  }
});

test('GET /api/finnick/report returns 503 when finnickReportFile is not configured', async () => {
  const configPath = await writeConfig(basicConfig);
  // Pass finnickReportFile: null explicitly to override any env var set in the process environment
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, finnickReportFile: null });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/finnick/report`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'finnick_not_configured');
  } finally {
    await server.close();
  }
});

test('GET /api/finnick/report returns 404 when the report file does not exist', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    finnickReportFile: '/tmp/definitely-does-not-exist-finnick-test.txt'
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/finnick/report`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error, 'report_not_found');
  } finally {
    await server.close();
  }
});

test('GET /api/finnick/report returns 200 with trimmed report content when file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finnick-test-'));
  const reportPath = join(dir, 'latest_report.txt');
  const reportContent = '=== FINNICK TEST REPORT ===\n  Bankroll: $3,429.14\n  Win rate: 95.9%\n';
  await writeFile(reportPath, reportContent, 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    finnickReportFile: reportPath
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/finnick/report`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(typeof body.content === 'string');
    assert.ok(body.content.includes('FINNICK TEST REPORT'));
    assert.ok(body.content.includes('Bankroll'));
    // content is trimmed — no leading/trailing whitespace
    assert.equal(body.content, reportContent.trim());
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/finnick/report requires authentication in reverse-proxy mode', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'reverse-proxy',
    proxyUserHeader: 'x-forwarded-user',
    finnickReportFile: '/tmp/nonexistent.txt'
  });
  const server = await listen(app);

  try {
    const unauthResponse = await fetch(`${server.baseUrl}/api/finnick/report`);
    assert.equal(unauthResponse.status, 401);

    // With the header present, auth passes (file doesn't exist but that's a 404, not 401)
    const authResponse = await fetch(`${server.baseUrl}/api/finnick/report`, {
      headers: { 'x-forwarded-user': 'ben' }
    });
    assert.notEqual(authResponse.status, 401);
  } finally {
    await server.close();
  }
});
