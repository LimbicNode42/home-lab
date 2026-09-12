import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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

async function snapshotTree(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    paths.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
    if (entry.isDirectory()) {
      paths.push(...await snapshotTree(join(root, entry.name), relativePath));
    }
  }
  return paths;
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

test('all API routes require reverse-proxy auth except healthz', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'reverse-proxy',
    proxyUserHeader: 'x-forwarded-user',
    finnickReportFile: '/tmp/nonexistent-finnick-auth-regression.txt',
    kanbanDbPath: '/tmp/nonexistent-kanban-auth-regression.db'
  });
  const server = await listen(app);
  const apiRequests = [
    { path: '/api/config/public' },
    { path: '/api/status' },
    { path: '/api/mobile-workflow/status' },
    { path: '/api/unified-inbox/status' },
    { path: '/api/finnick/report' },
    { path: '/api/investment-screener/report' },
    { path: '/api/investment-screener/ranked' },
    { path: '/api/investment-screener/coverage' },
    { path: '/api/epics' },
    { path: '/api/docs' },
    { path: '/api/docs/dashboard-readme' },
  ];

  try {
    const health = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(health.status, 200);

    for (const request of apiRequests) {
      const response = await fetch(`${server.baseUrl}${request.path}`, request.options);
      assert.equal(response.status, 401, `${request.path} should require reverse-proxy identity`);
    }
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


test('GET /api/status treats configured acceptable status codes as up for authenticated gateways', async () => {
  const probe = await listen((_request, response) => {
    response.writeHead(401).end();
  });
  const configPath = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [{ id: 'metamcp-gateway', label: 'MetaMCP gateway', targetUrl: `${probe.baseUrl}/mcp`, displayUrl: 'http://metamcp.local:12008', acceptableStatuses: [200, 401] }]
  });
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, statusCacheTtlMs: 1000 });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/status`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.checks[0].status, 'up');
    assert.equal(body.checks[0].httpStatus, 401);
    assert.equal(body.checks[0].displayUrl, 'http://metamcp.local:12008');
    assert.equal(serialized.includes(probe.baseUrl), false);
    assert.equal(serialized.includes('token'), false);
  } finally {
    await server.close();
    await probe.close();
  }
});

test('GET /api/status reports down for unacceptable MetaMCP gateway responses', async () => {
  const probe = await listen((_request, response) => {
    response.writeHead(500).end();
  });
  const configPath = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [{ id: 'metamcp-gateway', label: 'MetaMCP gateway', targetUrl: `${probe.baseUrl}/mcp`, displayUrl: 'http://metamcp.local:12008', acceptableStatuses: [200, 401] }]
  });
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, statusCacheTtlMs: 1000 });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.checks[0].status, 'down');
    assert.equal(body.checks[0].httpStatus, 500);
  } finally {
    await server.close();
    await probe.close();
  }
});

test('GET /api/status reports timeout for slow MetaMCP gateway probes', async () => {
  const probe = await listen((_request, _response) => {
    // Keep the request open until the dashboard probe aborts.
  });
  const configPath = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [{ id: 'metamcp-gateway', label: 'MetaMCP gateway', targetUrl: `${probe.baseUrl}/mcp`, displayUrl: 'http://metamcp.local:12008', acceptableStatuses: [200, 401] }]
  });
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, statusCacheTtlMs: 1000, statusProbeTimeoutMs: 20 });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.checks[0].status, 'down');
    assert.equal(body.checks[0].error, 'timeout');
  } finally {
    await server.close();
    await probe.close();
  }
});


test('authenticated embedded Kanban board API routes are removed from the dashboard surface', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: '/tmp/not-used-kanban.db' });
  const server = await listen(app);

  try {
    const board = await fetch(`${server.baseUrl}/api/kanban/board`);
    const move = await fetch(`${server.baseUrl}/api/kanban/tasks/t_a1b2c3/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'blocked', reason: 'removed surface test' })
    });

    assert.equal(board.status, 404);
    assert.equal(move.status, 404);
  } finally {
    await server.close();
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

test('GET /api/finnick/report treats a directory bind source as missing report data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finnick-dir-test-'));
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    finnickReportFile: dir
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/finnick/report`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error, 'report_not_found');
    assert.equal(JSON.stringify(body).includes('EISDIR'), false);
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


// ──────────────────────────────────────────────
// /api/homelab/health tests
// ──────────────────────────────────────────────

test('GET /api/homelab/health returns 503 when homelabHealthReportFile is not configured', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, homelabHealthReportFile: null });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/homelab/health`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'not_configured');
  } finally {
    await server.close();
  }
});

test('GET /api/homelab/health returns 404 when the report file does not exist', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    homelabHealthReportFile: '/tmp/definitely-does-not-exist-homelab-health-test.txt'
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/homelab/health`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error, 'not_found');
  } finally {
    await server.close();
  }
});

test('GET /api/homelab/health returns 200 with state=ok, parsed fields when file is fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'homelab-health-test-'));
  const reportPath = join(dir, 'latest_report.txt');
  const reportContent = [
    'Homelab health report - 2026-08-22T22:00:29Z',
    '',
    'Summary:',
    '- Proxmox guests observed: 6',
    '- Proxmox backup jobs observed: 6',
    '- Critical tracked guests: 100, 103, 110, 111, 112',
    '- Alerts: 0',
    '',
    'Backup coverage:',
    '- 100: name=critical status=running scheduled=yes latest=vzdump-lxc-100-2026-08-22.tar.zst',
    '',
    'Alerts:',
    '- none',
  ].join('\n');
  await writeFile(reportPath, reportContent, 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    homelabHealthReportFile: reportPath
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/homelab/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, 'ok');
    assert.ok(typeof body.content === 'string');
    assert.ok(body.content.includes('Homelab health report'));
    assert.equal(body.generated_at, '2026-08-22T22:00:29Z');
    assert.equal(body.alert_count, 0);
    assert.ok(typeof body.age_hours === 'number');
    assert.ok(typeof body.fetched_at === 'string');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/homelab/health returns state=degraded when alert_count > 0 and file is fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'homelab-health-degraded-'));
  const reportPath = join(dir, 'latest_report.txt');
  const reportContent = [
    'Homelab health report - 2026-08-22T22:00:29Z',
    '',
    'Summary:',
    '- Proxmox guests observed: 6',
    '- Alerts: 7',
    '',
    'Alerts:',
    '- some alert here',
  ].join('\n');
  await writeFile(reportPath, reportContent, 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    homelabHealthReportFile: reportPath
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/homelab/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, 'degraded');
    assert.equal(body.alert_count, 7);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/homelab/health returns state=empty when file is blank', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'homelab-health-empty-'));
  const reportPath = join(dir, 'latest_report.txt');
  await writeFile(reportPath, '   \n  \n', 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    homelabHealthReportFile: reportPath
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/homelab/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, 'empty');
    assert.equal(body.content, '');
    assert.equal(body.alert_count, null);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/homelab/health returns 502 on read error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'homelab-health-perm-'));
  const reportPath = join(dir, 'latest_report.txt');
  await writeFile(reportPath, 'content', 'utf8');
  await chmod(reportPath, 0o000);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    homelabHealthReportFile: reportPath
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/homelab/health`);
    const body = await response.json();
    // Running as root bypasses file permission checks; skip the assertion in that case.
    if (process.getuid && process.getuid() === 0) {
      assert.ok([200, 502].includes(response.status), `unexpected status ${response.status}`);
    } else {
      assert.equal(response.status, 502);
      assert.equal(body.error, 'read_error');
    }
  } finally {
    await server.close();
    await chmod(reportPath, 0o644);
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/homelab/health treats a directory bind source as not_found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'homelab-health-dir-'));
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    homelabHealthReportFile: dir
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/homelab/health`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error, 'not_found');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/homelab/health requires authentication in reverse-proxy mode', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'reverse-proxy',
    proxyUserHeader: 'x-forwarded-user',
    homelabHealthReportFile: '/tmp/nonexistent-homelab-health-auth.txt'
  });
  const server = await listen(app);
  try {
    const unauthResponse = await fetch(`${server.baseUrl}/api/homelab/health`);
    assert.equal(unauthResponse.status, 401);

    const authResponse = await fetch(`${server.baseUrl}/api/homelab/health`, {
      headers: { 'x-forwarded-user': 'ben' }
    });
    assert.notEqual(authResponse.status, 401);
  } finally {
    await server.close();
  }
});

test('GET /api/homelab/health alert_count is null when Alerts line is missing from Summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'homelab-health-noalerts-'));
  const reportPath = join(dir, 'latest_report.txt');
  await writeFile(reportPath, 'Homelab health report - 2026-08-22T22:00:29Z\n\nSummary:\n- Proxmox guests: 6\n', 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    homelabHealthReportFile: reportPath
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/homelab/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.alert_count, null);
    assert.equal(body.state, 'ok');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────
// /api/investment-screener tests
// ──────────────────────────────────────────────

test('GET /api/investment-screener/ranked returns 503 when ranked file is not configured', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: null });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'investment_screener_not_configured');
    assert.equal(JSON.stringify(body).includes('/'), false);
  } finally {
    await server.close();
  }
});

test('GET /api/investment-screener/ranked returns 404 when ranked file is missing or a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-ranked-dir-'));
  const configPath = await writeConfig(basicConfig);
  const missingApp = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: join(dir, 'missing.json') });
  const dirApp = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: dir });
  const missingServer = await listen(missingApp);
  const dirServer = await listen(dirApp);
  try {
    const missingResponse = await fetch(`${missingServer.baseUrl}/api/investment-screener/ranked`);
    const missingBody = await missingResponse.json();
    assert.equal(missingResponse.status, 404);
    assert.equal(missingBody.error, 'report_not_found');

    const dirResponse = await fetch(`${dirServer.baseUrl}/api/investment-screener/ranked`);
    const dirBody = await dirResponse.json();
    assert.equal(dirResponse.status, 404);
    assert.equal(dirBody.error, 'report_not_found');
    assert.equal(JSON.stringify(dirBody).includes('EISDIR'), false);
  } finally {
    await missingServer.close();
    await dirServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/ranked returns representative sanitized ranked output', async () => {
  const rankedPath = new URL('./fixtures/investment-screener-ranked.json', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ['mode', 'generated_at', 'data_as_of', 'disclaimer', 'limitations', 'candidates', 'excluded', 'doc_links', 'source_summary', 'coverage', 'available_facets']);
    assert.equal(body.mode, 'fixture');
    assert.equal(body.data_as_of, new Date('2026-08-08').toISOString());
    assert.ok(body.disclaimer.includes('not financial advice'));
    assert.equal(body.candidates.length, 2);
    assert.deepEqual(Object.keys(body.candidates[0]), ['rank', 'ticker', 'name', 'market', 'currency', 'sector', 'industry', 'score', 'sub_scores', 'missing_penalty_points', 'risk_flags', 'caveats', 'score_caps', 'sanitized_provenance_summary']);
    assert.equal(body.candidates[0].ticker, 'BRK.B');
    assert.equal(body.candidates[0].score, 91.4);
    assert.deepEqual(body.doc_links, [
      { label: 'Investment screener product guide', url: '/api/docs/investment-screener-overview', doc_id: 'investment-screener-overview' },
      { label: 'Interpreting screener results', url: '/api/docs/investment-screener-interpreting-results', doc_id: 'investment-screener-interpreting-results' },
      { label: 'Investment screener operations', url: '/api/docs/investment-screener-operations-limitations', doc_id: 'investment-screener-operations-limitations' },
      { label: 'NYSE source and identity rules', url: '/api/docs/investment-screener-nyse-source-identity', doc_id: 'investment-screener-nyse-source-identity' }
    ]);
  } finally {
    await server.close();
  }
});


test('GET /api/investment-screener/coverage returns degraded fixture provenance from ranked artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-coverage-fixture-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  await writeFile(rankedPath, JSON.stringify({
    mode: 'fixture',
    generated_at: '2026-08-22T08:00:00Z',
    data_as_of: '2026-08-21',
    candidates: [
      { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', score: 88 },
      { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', score: 86 },
      { rank: 3, ticker: 'CBA.AX', name: 'Commonwealth Bank', market: 'ASX', currency: 'AUD', score: 82 }
    ]
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/coverage?market=ASX`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.status, 'degraded');
    assert.equal(body.source, 'ranked_artifact');
    assert.equal(body.source_summary.mode, 'fixture');
    assert.equal(body.source_summary.mode_label, 'Fixture/sample data');
    assert.equal(body.coverage.market, 'ASX');
    assert.equal(body.coverage.denominator, 3);
    assert.equal(body.coverage.denominator_status, 'sample');
    assert.equal(body.coverage.usable, 3);
    assert.equal(body.coverage.percent, 100);
    assert.match(body.coverage.coverage_label, /fixture sample companies/i);
    assert.match(body.coverage.coverage_label, /not full ASX market coverage/i);
    assert.equal(body.coverage.alternate_denominators[0].denominator, 10);
    assert.equal(serialized.includes('/root/'), false);
    assert.equal(serialized.includes('DATABASE_URL'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('GET /api/investment-screener/ranked embeds compact source summary and coverage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-ranked-coverage-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  await writeFile(rankedPath, JSON.stringify({
    mode: 'fixture',
    generated_at: '2026-08-22T08:00:00Z',
    data_as_of: '2026-08-21',
    candidates: [
      { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', score: 88 },
      { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', score: 86 }
    ]
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=ASX&limit=10`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source_summary.mode_label, 'Fixture/sample data');
    assert.equal(body.coverage.denominator_status, 'sample');
    assert.match(body.coverage.coverage_label, /not full ASX market coverage/i);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('GET /api/investment-screener/coverage clamps inconsistent artifact counts and sanitizes metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-coverage-sanitize-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  await writeFile(rankedPath, JSON.stringify({
    mode: 'asx-yahoo-timeseries',
    generated_at: '2026-08-22T08:00:00Z',
    data_as_of: '2026-08-21',
    source_summary: {
      providers: ['yahoo-finance', '/root/private'],
      caveats: ['Yahoo Finance public endpoints are unofficial.', 'DATABASE_URL=postgres://secret']
    },
    coverage: {
      market: 'ASX',
      denominator: 2,
      denominator_label: 'configured ASX bootstrap watchlist',
      usable: 5,
      scraped: 5,
      scored: 5,
      excluded: 7,
      failed: 8,
      stale: 9,
      missing_required_fields: 10,
      caveats: ['safe caveat', 'raw SQL SELECT * FROM /root/private']
    },
    candidates: [
      { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', score: 88 }
    ]
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/coverage?market=ASX`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.coverage.usable, 2);
    assert.equal(body.coverage.scraped, 2);
    assert.equal(body.coverage.scored, 2);
    assert.equal(body.coverage.excluded, 2);
    assert.equal(body.coverage.failed, 2);
    assert.equal(body.coverage.stale, true);
    assert.equal(body.coverage.missing_required_fields, 2);
    assert.equal(body.coverage.percent, 100);
    assert.equal(body.coverage.coverage_inconsistent, true);
    assert.deepEqual(body.source_summary.providers, ['yahoo-finance']);
    assert.deepEqual(body.coverage.caveats, ['safe caveat', 'Postgres coverage history unavailable; coverage inferred from sanitized ranked artifact.', 'Coverage counts exceeded the denominator and were clamped for display.']);
    for (const forbidden of ['/root/', 'postgres://secret', 'DATABASE_URL', 'raw SQL']) {
      assert.equal(serialized.includes(forbidden), false, `coverage response leaked ${forbidden}`);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});



test('GET /api/investment-screener/coverage preserves sanitized freshness metadata and warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-coverage-freshness-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  await writeFile(rankedPath, JSON.stringify({
    mode: 'asx-yahoo-timeseries',
    generated_at: '2026-08-25T08:00:00Z',
    data_as_of: '2026-06-30',
    source_summary: { latest_retrieved_at: '2026-08-25T07:59:00Z', providers: ['yahoo-finance'] },
    coverage: {
      denominator: 1, usable: 1, stale: true,
      freshness: {
        generated_at: '2026-08-25T08:00:00Z',
        generated_age_hours: 2,
        latest_retrieved_at: '2026-08-25T07:59:00Z',
        latest_retrieved_age_hours: 2.1,
        data_as_of: '2026-06-30',
        data_as_of_age_days: 56,
        stale: false,
        stale_thresholds: { max_generated_age_hours: 26, max_source_age_hours: 26, max_data_as_of_age_days: 370 }
      },
      warnings: ['safe freshness warning', '/root/private leaked warning']
    },
    candidates: [{ rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', score: 88 }]
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/coverage?market=ASX`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.coverage.freshness.latest_retrieved_at, '2026-08-25T07:59:00.000Z');
    assert.equal(body.coverage.freshness.generated_age_hours, 2);
    assert.equal(body.coverage.freshness.stale, false);
    assert.deepEqual(body.coverage.warnings, ['safe freshness warning']);
    assert.equal(JSON.stringify(body).includes('/root/private'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/report prefers canonical non-fixture export over legacy fixture file', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'investment-report-canonical-'));
  const legacyDir = await mkdtemp(join(tmpdir(), 'investment-report-legacy-'));
  // Legacy runtime-cache report file holds fixture content labeled "(fixture)".
  const legacyReportPath = join(legacyDir, 'latest_report.txt');
  await writeFile(legacyReportPath, 'Investment Screener ASX\nRun: fixture-stub\nUsable: 1 / 3\nBHP.AX (fixture)\n', 'utf8');

  // Canonical publisher export under exports/dashboard/market=ASX/latest_report.txt.
  const canonicalDir = join(dataRoot, 'investment-screener', 'exports', 'dashboard', 'market=ASX');
  await mkdir(canonicalDir, { recursive: true });
  await writeFile(join(canonicalDir, 'latest_report.txt'), 'Investment Screener ASX\nRun: investment-screener_ASX_asx-yahoo-timeseries_2026-08-23T100100Z_0123456789ab\nUsable: 2 / 3\n', 'utf8');
  await writeFile(join(canonicalDir, 'latest_coverage.json'), JSON.stringify({
    market: 'ASX',
    source: 'published-artifact',
    generated_at: '2026-08-23T10:01:00.000Z',
    source_summary: {
      mode: 'asx-yahoo-timeseries',
      data_as_of: '2026-06-30',
      latest_retrieved_at: '2026-08-23T10:00:30.000Z'
    },
    coverage: {
      freshness: {
        data_as_of: '2026-06-30',
        stale: false
      }
    }
  }), 'utf8');
  const manifestDir = join(dataRoot, 'investment-screener', 'manifests', 'market=ASX', 'source=yahoo-finance');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, 'latest.json'), JSON.stringify({
    run_id: 'investment-screener_ASX_asx-yahoo-timeseries_2026-08-23T100100Z_0123456789ab',
    mode: 'asx-yahoo-timeseries',
    generated_at: '2026-08-23T10:01:00.000Z',
    run_manifest: 'runs/market=ASX/source=yahoo-finance/mode=asx-yahoo-timeseries/run_date=2026-08-23/investment-screener_ASX_asx-yahoo-timeseries_2026-08-23T100100Z_0123456789ab/manifest.json'
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerReportFile: legacyReportPath, investmentScreenerDataRoot: dataRoot });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/report`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'asx-yahoo-timeseries');
    assert.equal(body.generated_at, '2026-08-23T10:01:00.000Z');
    assert.equal(body.data_as_of, '2026-06-30');
    assert.match(body.content, /Run: investment-screener_ASX_asx-yahoo-timeseries/);
    assert.equal(body.content.includes('(fixture)'), false, 'canonical report must not contain fixture content');
  } finally {
    await server.close();
    await rm(legacyDir, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/report flags legacy fixture content as fixture, never live', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'investment-report-fixture-'));
  const legacyReportPath = join(legacyDir, 'latest_report.txt');
  await writeFile(legacyReportPath, 'Investment Screener ASX\nRun: fixture-stub\nUsable: 1 / 3\nBHP.AX (fixture)\n', 'utf8');

  const configPath = await writeConfig(basicConfig);
  // No data root configured: only the legacy file is available.
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerReportFile: legacyReportPath, investmentScreenerDataRoot: null });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/report`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'fixture', 'fixture content must never be labeled live');
    assert.equal(JSON.stringify(body).includes('"live"'), false);
  } finally {
    await server.close();
    await rm(legacyDir, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/coverage clamps artifact fallback candidate counts to configured universe denominator', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-coverage-over-universe-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  const candidates = Array.from({ length: 12 }, (_unused, index) => ({
    rank: index + 1,
    ticker: `ASX${String(index + 1).padStart(2, '0')}.AX`,
    name: `ASX Test ${index + 1}`,
    market: 'ASX',
    currency: 'AUD',
    score: 90 - index
  }));
  await writeFile(rankedPath, JSON.stringify({
    mode: 'asx-yahoo-timeseries',
    generated_at: '2026-08-22T08:00:00Z',
    data_as_of: '2026-08-21',
    candidates
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/coverage?market=ASX`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.coverage.denominator, 10);
    assert.equal(body.coverage.usable, 10);
    assert.equal(body.coverage.percent, 100);
    assert.equal(body.coverage.coverage_inconsistent, true);
    assert.match(body.coverage.coverage_label, /^10 \/ 10 configured ASX bootstrap watchlist/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('GET /api/investment-screener/coverage prefers Postgres latest completed market run when available', async () => {
  const queries = [];
  const investmentScreenerHistoryPool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{
        run_key: 'investment-screener:ASX:asx-yahoo-timeseries:test',
        mode: 'asx-yahoo-timeseries',
        market: 'ASX',
        started_at: new Date('2026-08-22T10:00:00.000Z'),
        completed_at: new Date('2026-08-22T10:05:00.000Z'),
        universe_version: 'sha256:test',
        source_mix: { providers: ['yahoo-finance'], universe: ['BHP.AX', 'CSL.AX', 'CBA.AX', 'WES.AX'] },
        usable: '3',
        scored: '4',
        excluded: '1',
        scraped: '4',
        missing_required_fields: '1',
        provenance_rows: '12',
        provenance_fields: '6',
        source_families: ['yahoo-finance'],
        latest_retrieved_at: new Date('2026-08-22T10:04:00.000Z'),
        data_as_of: new Date('2025-06-30T00:00:00.000Z')
      }] };
    }
  };

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: null, investmentScreenerHistoryPool });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/coverage?market=ASX`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.source, 'postgres');
    assert.equal(body.source_summary.mode, 'asx-yahoo-timeseries');
    assert.deepEqual(body.source_summary.source_families, ['yahoo-finance']);
    assert.equal(body.source_summary.provenance_rows, 12);
    assert.equal(body.coverage.denominator, 10);
    assert.equal(body.coverage.usable, 3);
    assert.equal(body.coverage.scored, 4);
    assert.equal(body.coverage.scraped, 4);
    assert.equal(body.coverage.excluded, 1);
    assert.equal(body.coverage.missing_required_fields, 1);
    assert.equal(body.coverage.percent, 30);
    assert.equal(body.coverage.freshness.latest_retrieved_at, '2026-08-22T10:04:00.000Z');
    assert.equal(body.coverage.freshness.data_as_of, '2025-06-30');
    assert.equal(body.coverage.freshness.stale, true);
    assert.equal(body.coverage.stale, true);
    assert.ok(body.coverage.warnings.some((warning) => warning.includes('Latest provider retrieval is')));
    assert.ok(body.coverage.warnings.some((warning) => warning.includes('Source data_as_of is')));
    assert.equal(JSON.stringify(body).includes('/root/'), false);
    assert.equal(body.coverage.window.run_key, 'investment-screener:ASX:asx-yahoo-timeseries:test');
    assert.equal(queries[0].params[0], 'ASX');
  } finally {
    await server.close();
  }
});


test('GET /api/investment-screener/coverage surfaces full NASDAQ denominator and freshness from Postgres metadata', async () => {
  const queries = [];
  const investmentScreenerHistoryPool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{
        run_key: 'investment-screener:NASDAQ:nasdaq-eodhd-fundamentals:2026-09-07T21:45:05.171Z:940292618fe1',
        mode: 'nasdaq-eodhd-fundamentals',
        market: 'NASDAQ',
        started_at: new Date('2026-09-07T21:40:00.000Z'),
        completed_at: new Date('2026-09-07T21:45:05.171Z'),
        universe_version: 'NASDAQ listed equities (security-type-filtered, reviewed static seed) sha256:491337a821469a830093aca740849358982960c46f0192537f5de898f59e9200 retrieved_at:2026-09-08T00:00:00Z',
        source_mix: { providers: ['eodhd'], source_families: ['eodhd'] },
        metadata: {},
        universe_metadata: {
          normalized_active_count: 3432,
          denominator_label: 'NASDAQ listed equities (security-type-filtered, reviewed static seed)',
          denominator_status: 'complete_security_type_filtered_listing',
          source_sha256: '491337a821469a830093aca740849358982960c46f0192537f5de898f59e9200'
        },
        provider_failures: Array.from({ length: 49 }, (_unused, index) => ({ ticker: `BAD${index}.US`, reason: 'provider 404' })),
        usable: '3162',
        scored: '3211',
        excluded: '49',
        scraped: '3211',
        missing_required_fields: '49',
        provenance_rows: '69564',
        provenance_fields: '42',
        source_families: ['eodhd'],
        latest_retrieved_at: new Date('2026-09-07T21:45:03.945Z'),
        data_as_of: new Date('2026-09-07T00:00:00.000Z'),
        latest_provenance_data_as_of: new Date('2026-09-07T00:00:00.000Z')
      }] };
    }
  };

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: null, investmentScreenerHistoryPool });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/coverage?market=NASDAQ`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.source, 'postgres');
    assert.equal(body.coverage.market, 'NASDAQ');
    assert.equal(body.source_summary.mode, 'nasdaq-eodhd-fundamentals');
    assert.deepEqual(body.source_summary.providers, ['eodhd']);
    assert.equal(body.coverage.denominator, 3432);
    assert.equal(body.coverage.denominator_status, 'complete_security_type_filtered_listing');
    assert.equal(body.coverage.denominator_label, 'NASDAQ listed equities (security-type-filtered, reviewed static seed)');
    assert.equal(body.coverage.usable, 3162);
    assert.equal(body.coverage.scored, 3211);
    assert.equal(body.coverage.scraped, 3211);
    assert.equal(body.coverage.failed, 49);
    assert.equal(body.coverage.excluded, 49);
    assert.equal(body.coverage.percent, 92.1);
    assert.equal(body.coverage.freshness.latest_retrieved_at, '2026-09-07T21:45:03.945Z');
    assert.equal(body.coverage.freshness.data_as_of, '2026-09-07');
    assert.match(body.coverage.coverage_label, /^3162 \/ 3432 NASDAQ listed equities/);
    assert.ok(body.coverage.caveats.some((item) => item.includes('security-type-filtered full listing')));
    assert.ok(body.coverage.caveats.some((item) => item.includes('49 provider failures')));
    assert.equal(queries[0].params[0], 'NASDAQ');
    assert.equal(JSON.stringify(body).includes('NASDAQ-100'), false);
  } finally {
    await server.close();
  }
});



test('GET /api/investment-screener/coverage surfaces NYSE as a first-class EODHD market from Postgres metadata', async () => {
  const queries = [];
  const investmentScreenerHistoryPool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{
        run_key: 'investment-screener:NYSE:nyse-eodhd-fundamentals:2026-09-12T03:11:22.000Z:cb016b32f404',
        mode: 'nyse-eodhd-fundamentals',
        market: 'NYSE',
        started_at: new Date('2026-09-12T03:00:00.000Z'),
        completed_at: new Date('2026-09-12T03:11:22.000Z'),
        universe_version: 'NYSE listed equities (security-type-filtered, reviewed static seed) sha256:ab1cd85be373c3e7a0fa17154146bc8d5dc25dcc4fa68db28a3546c96f2eb15f retrieved_at:2026-09-12T00:38:40Z',
        source_mix: { providers: ['eodhd'], source_families: ['eodhd'] },
        metadata: {},
        universe_metadata: {
          normalized_active_count: 2227,
          denominator_label: 'NYSE listed equities (security-type-filtered, reviewed static seed)',
          denominator_status: 'complete_security_type_filtered_listing',
          source_sha256: 'ab1cd85be373c3e7a0fa17154146bc8d5dc25dcc4fa68db28a3546c96f2eb15f'
        },
        provider_failures: Array.from({ length: 258 }, (_unused, index) => ({ ticker: `BAD${index}.US`, reason: 'provider unavailable' })),
        usable: '1881',
        scored: '1926',
        excluded: '45',
        scraped: '1969',
        missing_required_fields: '45',
        provenance_rows: '43230',
        provenance_fields: '42',
        source_families: ['eodhd'],
        latest_retrieved_at: new Date('2026-09-12T03:11:21.000Z'),
        data_as_of: new Date('2026-09-12T00:00:00.000Z'),
        latest_provenance_data_as_of: new Date('2026-09-12T00:00:00.000Z')
      }] };
    }
  };

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: null, investmentScreenerHistoryPool });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/coverage?market=NYSE`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.source, 'postgres');
    assert.equal(body.coverage.market, 'NYSE');
    assert.equal(body.source_summary.mode, 'nyse-eodhd-fundamentals');
    assert.equal(body.source_summary.mode_label, 'EODHD NYSE fundamentals');
    assert.deepEqual(body.source_summary.providers, ['eodhd']);
    assert.equal(body.coverage.denominator, 2227);
    assert.equal(body.coverage.denominator_status, 'complete_security_type_filtered_listing');
    assert.equal(body.coverage.usable, 1881);
    assert.equal(body.coverage.scored, 1926);
    assert.equal(body.coverage.scraped, 1969);
    assert.equal(body.coverage.failed, 258);
    assert.equal(body.coverage.excluded, 45);
    assert.match(body.coverage.coverage_label, /^1881 \/ 2227 NYSE listed equities/);
    assert.equal(queries[0].params[0], 'NYSE');
    assert.equal(JSON.stringify(body).includes('NASDAQ-100'), false);
  } finally {
    await server.close();
  }
});

test('GET /api/investment-screener/ranked can read NYSE EODHD DuckDB artifacts by market query', async () => {
  const { publishInvestmentScreenerRun } = await import('../src/investment-screener-storage.js');
  const dataRoot = await mkdtemp(join(tmpdir(), 'investment-api-duckdb-nyse-'));
  await publishInvestmentScreenerRun({
    dataRoot,
    run: {
      market: 'NYSE',
      source: 'eodhd',
      mode: 'nyse-eodhd-fundamentals',
      started_at: '2026-09-12T03:00:00.000Z',
      completed_at: '2026-09-12T03:11:22.000Z',
      data_as_of: '2026-09-12',
      universe: {
        source: 'NYSE listed equities (security-type-filtered, reviewed static seed)',
        version: 'sha256:ab1cd85be373c3e7a0fa17154146bc8d5dc25dcc4fa68db28a3546c96f2eb15f',
        count: 2227,
        selected_count: 2227,
        market: 'NYSE',
        complete_exchange_listing: false
      },
      companies: [
        { ticker: 'BRK.B', name: 'Berkshire Hathaway Inc.', market: 'NYSE', exchange: 'NYSE', region: 'US', currency: 'USD' },
        { ticker: 'V', name: 'Visa Inc.', market: 'NYSE', exchange: 'NYSE', region: 'US', currency: 'USD' }
      ],
      scores: [
        { rank: 1, ticker: 'BRK.B', name: 'Berkshire Hathaway Inc.', market: 'NYSE', exchange: 'NYSE', region: 'US', currency: 'USD', composite_score: 94.2, sub_scores: { quality: 23 } },
        { rank: 2, ticker: 'V', name: 'Visa Inc.', market: 'NYSE', exchange: 'NYSE', region: 'US', currency: 'USD', composite_score: 91.1, sub_scores: { quality: 22 } }
      ],
      provenance: [{ ticker: 'BRK.B', field_name: 'revenue', source_family: 'eodhd', provider: 'eodhd', retrieved_at: '2026-09-12T03:11:21.000Z', data_as_of: '2026-09-12' }],
      coverage: { denominator_status: 'complete_security_type_filtered_listing', failed: 258, excluded: 45 }
    }
  });

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: null, investmentScreenerDataRoot: dataRoot });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=NYSE&exchange=NYSE&region=US&limit=10`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.source_summary.mode, 'nyse-eodhd-fundamentals');
    assert.equal(body.source_summary.mode_label, 'EODHD NYSE fundamentals');
    assert.equal(body.coverage.market, 'NYSE');
    assert.equal(body.coverage.denominator, 2227);
    assert.equal(body.coverage.denominator_status, 'complete_security_type_filtered_listing');
    assert.deepEqual(body.available_facets.exchanges, ['NYSE']);
    assert.deepEqual(body.available_facets.regions, ['US']);
    assert.deepEqual(body.candidates.map((candidate) => candidate.ticker), ['BRK.B', 'V']);
    assert.equal(serialized.includes(dataRoot), false);
    assert.equal(serialized.includes('postgres://'), false);
  } finally {
    await server.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/ranked preserves bounded ASX Yahoo source mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-ranked-asx-mode-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  await writeFile(rankedPath, JSON.stringify({
    mode: 'asx-yahoo-timeseries',
    generated_at: '2026-08-22T09:00:00Z',
    data_as_of: '2026-08-21',
    limitations: ['Yahoo Finance public endpoints are unofficial and bounded; verify against ASX filings.'],
    candidates: [{
      rank: 1,
      ticker: 'BHP.AX',
      name: 'BHP Group',
      market: 'ASX',
      currency: 'AUD',
      score: 88,
      sub_scores: { quality: 20 },
      sanitized_provenance_summary: '2 source(s); data_as_of=2026-08-21; retrieved_at=2026-08-22T08:00:00Z'
    }]
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=ASX`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'asx-yahoo-timeseries');
    assert.equal(body.candidates[0].ticker, 'BHP.AX');
    assert.equal(body.limitations.some((item) => item.includes('unofficial')), true);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/ranked can query NAS-backed DuckDB screener artifacts without Postgres', async () => {
  const { publishInvestmentScreenerRun } = await import('../src/investment-screener-storage.js');
  const dataRoot = await mkdtemp(join(tmpdir(), 'investment-api-duckdb-'));
  await publishInvestmentScreenerRun({
    dataRoot,
    run: {
      market: 'ASX',
      source: 'yahoo-finance',
      mode: 'fixture',
      started_at: '2026-08-23T09:00:00.000Z',
      completed_at: '2026-08-23T09:01:00.000Z',
      data_as_of: '2026-08-22',
      universe: { source: 'fixture sample universe', count: 2, market: 'ASX', complete_exchange_listing: false },
      companies: [
        { ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD' },
        { ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD' }
      ],
      scores: [
        { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', composite_score: 91.4, sub_scores: { quality: 22 } },
        { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', composite_score: 89.1, sub_scores: { quality: 24 } }
      ],
      provenance: [{ ticker: 'BHP.AX', field_name: 'revenue', source_family: 'fixture', provider: 'fixture', retrieved_at: '2026-08-23T09:00:30.000Z', data_as_of: '2026-08-22' }]
    }
  });

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: null, investmentScreenerDataRoot: dataRoot });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=ASX&limit=10`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.source_summary.mode, 'fixture');
    assert.equal(body.source_summary.provenance_fields, 1);
    assert.equal(body.coverage.usable, 2);
    assert.equal(typeof body.coverage.stale, 'boolean');
    assert.deepEqual(body.candidates.map((candidate) => candidate.ticker), ['BHP.AX', 'CSL.AX']);
    assert.equal(serialized.includes(dataRoot), false);
    assert.equal(serialized.includes('postgres://'), false);
  } finally {
    await server.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/company/:ticker returns sanitized file-first fundamentals detail', async () => {
  const { publishInvestmentScreenerRun } = await import('../src/investment-screener-storage.js');
  const dataRoot = await mkdtemp(join(tmpdir(), 'investment-company-api-'));
  await publishInvestmentScreenerRun({
    dataRoot,
    run: {
      market: 'ASX',
      source: 'yahoo-finance',
      mode: 'asx-yahoo-timeseries',
      started_at: '2026-08-23T09:00:00.000Z',
      completed_at: '2026-08-23T09:01:00.000Z',
      data_as_of: '2026-06-30',
      universe: { source: 'configured ASX bootstrap watchlist', count: 1, market: 'ASX', complete_exchange_listing: false },
      companies: [{ ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD' }],
      scores: [{ rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', composite_score: 91.4, sub_scores: { quality: 22, valuation: 19 }, excluded: false }],
      observations: [
        { ticker: 'BHP.AX', field_name: 'revenue', value: 56642000000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T09:00:30.000Z', data_as_of: '2026-06-30' },
        { ticker: 'BHP.AX', field_name: 'market_cap', value: 225000000000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T09:00:31.000Z', data_as_of: '2026-08-23' }
      ],
      provenance: [
        { ticker: 'BHP.AX', field_name: 'revenue', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T09:00:30.000Z', data_as_of: '2026-06-30' },
        { ticker: 'BHP.AX', field_name: 'market_cap', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T09:00:31.000Z', data_as_of: '2026-08-23' }
      ]
    }
  });

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: null, investmentScreenerDataRoot: dataRoot });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/company/BHP.AX?market=ASX`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.ticker, 'BHP.AX');
    assert.equal(body.identity.name, 'BHP Group');
    assert.equal(body.valuation.market_cap.value, 225000000000);
    assert.equal(body.statements_summary.revenue.value, 56642000000);
    assert.equal(body.quality_growth_safety.quality.value, 22);
    assert.equal(body.identity.unavailable.includes('exchange'), true);
    assert.equal(body.earnings.eps.state, 'unavailable');
    assert.equal(serialized.includes(dataRoot), false);
    assert.equal(serialized.includes('/root/'), false);

    const missing = await fetch(`${server.baseUrl}/api/investment-screener/company/NOPE.AX?market=ASX`);
    assert.equal(missing.status, 404);
    const invalid = await fetch(`${server.baseUrl}/api/investment-screener/company/%2Froot%2Fsecret?market=ASX`);
    assert.equal(invalid.status, 400);
  } finally {
    await server.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/ranked reads DuckDB-backed artifacts without writing to the canonical screener tree', async () => {
  const { publishInvestmentScreenerRun } = await import('../src/investment-screener-storage.js');
  const dataRoot = await mkdtemp(join(tmpdir(), 'investment-api-readonly-duckdb-'));
  await publishInvestmentScreenerRun({
    dataRoot,
    run: {
      market: 'ASX',
      source: 'yahoo-finance',
      mode: 'fixture',
      started_at: '2026-08-23T09:00:00.000Z',
      completed_at: '2026-08-23T09:01:00.000Z',
      data_as_of: '2026-08-22',
      universe: { source: 'fixture sample universe', count: 2, market: 'ASX', complete_exchange_listing: false },
      companies: [
        { ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD' },
        { ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD' }
      ],
      scores: [
        { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', composite_score: 91.4, sub_scores: { quality: 22 } },
        { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', composite_score: 89.1, sub_scores: { quality: 24 } }
      ],
      provenance: [{ ticker: 'BHP.AX', field_name: 'revenue', source_family: 'fixture', provider: 'fixture', retrieved_at: '2026-08-23T09:00:30.000Z', data_as_of: '2026-08-22' }]
    }
  });

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: null, investmentScreenerDataRoot: dataRoot });
  const server = await listen(app);
  try {
    const before = await snapshotTree(join(dataRoot, 'investment-screener'));
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=ASX&limit=10`);
    const body = await response.json();
    const after = await snapshotTree(join(dataRoot, 'investment-screener'));

    assert.equal(response.status, 200);
    assert.deepEqual(body.candidates.map((candidate) => candidate.ticker), ['BHP.AX', 'CSL.AX']);
    assert.deepEqual(after, before, 'API reads must not create DuckDB/materialized/export files in the canonical screener tree');
    assert.equal(after.some((path) => path.startsWith('duckdb/')), false);
  } finally {
    await server.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test('GET /api/investment-screener/ranked strips paths, diagnostics, metadata, and secret-shaped values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-ranked-leak-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  await writeFile(rankedPath, JSON.stringify({
    mode: 'live',
    generated_at: '2026-08-09T08:00:00Z',
    data_as_of: '2026-08-08',
    limitations: ['safe limitation', 'raw path /root/.hermes/kanban.db must drop', 'TOKEN=abc123456789 must drop'],
    task_body: 'private task body should not leak',
    stderr: 'EACCES /mnt/nas/services/nope',
    candidates: [{
      rank: 1,
      ticker: 'SAFE',
      name: 'Safe Candidate',
      market: '/tmp/private-market',
      currency: 'USD',
      score: 88,
      sub_scores: { quality: 10, 'API_KEY': 99, '/root/key': 100 },
      risk_flags: ['normal risk', 'Authorization: Bearer abcdefghijk'],
      caveats: ['safe caveat', 'diagnostics from /app/private'],
      score_caps: ['cap ok'],
      sanitized_provenance_summary: 'uses /root/work/home-lab/private.csv'
    }]
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.candidates[0].market, null);
    assert.deepEqual(body.candidates[0].sub_scores, { quality: 10 });
    assert.deepEqual(body.candidates[0].risk_flags, ['normal risk']);
    assert.deepEqual(body.candidates[0].caveats, ['safe caveat']);
    assert.equal(body.candidates[0].sanitized_provenance_summary, null);
    for (const forbidden of ['/root/', '/mnt/nas', '/app/', '/tmp/', 'kanban.db', 'stderr', 'diagnostic', 'private task body', 'abc123456789', 'Bearer abcdefgh']) {
      assert.equal(serialized.includes(forbidden), false, `investment ranked response leaked ${forbidden}`);
    }
    assert.doesNotMatch(serialized, /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*[:=]\s*(?:["'][^"']{4,}["']|[^\s"']{4,})/i);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/report returns sanitized report text with freshness metadata', async () => {
  const reportPath = new URL('./fixtures/investment-screener-report.txt', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerReportFile: reportPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/report`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ['mode', 'generated_at', 'data_as_of', 'disclaimer', 'content', 'doc_links']);
    assert.equal(body.mode, 'fixture');
    assert.ok(body.generated_at);
    assert.ok(body.content.includes('BRK.B'));
    assert.ok(body.content.includes('Toyota Motor Corporation'));
    assert.ok(body.disclaimer.includes('not financial advice'));
  } finally {
    await server.close();
  }
});

test('GET /api/investment-screener/report sanitizes local paths and secrets from text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-report-leak-'));
  const reportPath = join(dir, 'latest_report.txt');
  await writeFile(reportPath, 'Safe line\n/root/work/home-lab/private.csv\nkanban.db details\nstderr: EACCES\nTOKEN=abc123456789\nAuthorization: Bearer abcdefghijk\nAnother safe line\n', 'utf8');
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerReportFile: reportPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/report`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.content, 'Safe line\nAnother safe line');
    for (const forbidden of ['/root/', 'kanban.db', 'stderr', 'abc123456789', 'Bearer abcdefgh']) {
      assert.equal(serialized.includes(forbidden), false, `investment report response leaked ${forbidden}`);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/ranked requires authentication in reverse-proxy mode', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user', investmentScreenerRankedFile: '/tmp/nonexistent-investment-ranked.json' });
  const server = await listen(app);
  try {
    const unauth = await fetch(`${server.baseUrl}/api/investment-screener/ranked`);
    assert.equal(unauth.status, 401);
    const auth = await fetch(`${server.baseUrl}/api/investment-screener/ranked`, { headers: { 'x-forwarded-user': 'ben' } });
    assert.notEqual(auth.status, 401);
  } finally {
    await server.close();
  }
});


test('GET /api/investment-screener/ranked applies market and topN filters after sanitization', async () => {
  const rankedPath = new URL('./fixtures/investment-screener-ranked.json', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=JP&topN=1`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].ticker, '7203.T');
    assert.deepEqual(body.applied_filters, { market: 'JP', topN: 1 });
    assert.equal(body.messages.some((message) => message.includes('1 candidate')), true);
  } finally {
    await server.close();
  }
});


test('GET /api/investment-screener/ranked returns ASX candidates and visible applied filter state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-asx-ranked-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  await writeFile(rankedPath, JSON.stringify({
    mode: 'fixture',
    generated_at: '2026-08-22T08:00:00Z',
    data_as_of: '2026-08-21',
    candidates: [
      { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', score: 88, sub_scores: { valuation: 25, quality: 22 } },
      { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', score: 86, sub_scores: { valuation: 17, quality: 29 } },
      { rank: 3, ticker: 'BRK.B', name: 'Berkshire Hathaway Inc.', market: 'US', currency: 'USD', score: 91, sub_scores: { valuation: 24, quality: 28 } }
    ]
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=ASX&limit=10`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.applied_filters, { market: 'ASX', limit: 10 });
    assert.deepEqual(body.candidates.map((candidate) => candidate.ticker), ['BHP.AX', 'CSL.AX']);
    assert.equal(body.candidates.every((candidate) => candidate.market === 'ASX'), true);
    assert.equal(body.messages.some((message) => message.includes('2 candidates')), true);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('GET /api/investment-screener/ranked can rank by a supported sub-score metric', async () => {
  const rankedPath = new URL('./fixtures/investment-screener-ranked.json', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?metric=valuation&topN=2`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.candidates.map((candidate) => candidate.ticker), ['BRK.B', '7203.T']);
    assert.deepEqual(body.applied_filters, { metric: 'valuation', topN: 2 });
  } finally {
    await server.close();
  }
});


test('GET /api/investment-screener/ranked accepts real CLI sanitized export shape without raw internals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-cli-shape-'));
  const rankedPath = join(dir, 'ranked.json');
  const reportPath = join(dir, 'report.txt');
  const screenerDir = '/root/.hermes/kanban/artifacts/investment-screener-t_6d63d69b';
  execFileSync('python3', ['investment_screener.py', '--fixture', '--output', rankedPath, '--report', reportPath], { cwd: screenerDir, stdio: 'pipe' });

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?metric=valuation&topN=1`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'fixture');
    assert.equal(body.candidates.length, 1);
    assert.ok(body.excluded.length >= 1);
    assert.equal(typeof body.candidates[0].ticker, 'string');
    assert.deepEqual(body.applied_filters, { metric: 'valuation', topN: 1 });
    assert.deepEqual(Object.keys(body.candidates[0]), ['rank', 'ticker', 'name', 'market', 'currency', 'sector', 'industry', 'score', 'sub_scores', 'missing_penalty_points', 'risk_flags', 'caveats', 'score_caps', 'sanitized_provenance_summary']);
    assert.equal(typeof body.candidates[0].sub_scores.valuation, 'number');
    assert.equal(serialized.includes('"fields"'), false);
    assert.equal(serialized.includes('"provenance_summary"'), false);
    for (const forbidden of ['/root/', '/mnt/nas', '/tmp/', 'private.csv', 'raw.csv']) {
      assert.equal(serialized.includes(forbidden), false, `investment ranked response leaked ${forbidden}`);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('GET /api/investment-screener/ranked normalizes bare CLI lists and can show more than two candidates', async () => {
  const rankedPath = new URL('./fixtures/investment-screener-cli-ranked-list.json', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.candidates.length, 4);
    assert.equal(body.excluded.length, 1);
    assert.deepEqual(body.candidates.map((candidate) => candidate.ticker), ['BRK-B', 'MSFT', '7203.T', 'NESN.SW']);
    assert.equal(body.candidates[0].score, 90.57);
    assert.deepEqual(body.candidates[2].score_caps, ['excessive_leverage: 55']);

    const filteredResponse = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=US&topN=10`);
    const filteredBody = await filteredResponse.json();
    assert.equal(filteredResponse.status, 200);
    assert.deepEqual(filteredBody.candidates.map((candidate) => candidate.ticker), ['BRK-B', 'MSFT']);
    assert.deepEqual(filteredBody.applied_filters, { market: 'US', topN: 10 });
    assert.equal(filteredBody.messages.some((message) => message.includes('2 candidates')), true);
  } finally {
    await server.close();
  }
});



test('GET /api/investment-screener/ranked paginates and searches a broad sanitized universe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investment-broad-universe-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  const candidates = Array.from({ length: 32 }, (_unused, index) => ({
    rank: index + 1,
    ticker: `CO${String(index + 1).padStart(2, '0')}`,
    name: index === 27 ? 'Needle Robotics' : `Coverage Company ${index + 1}`,
    market: index % 3 === 0 ? 'US' : index % 3 === 1 ? 'JP' : 'EU',
    currency: index % 3 === 0 ? 'USD' : index % 3 === 1 ? 'JPY' : 'EUR',
    score: 95 - index,
    sub_scores: { quality: 90 - index, valuation: 70 + (index % 10) }
  }));
  await writeFile(rankedPath, JSON.stringify({
    mode: 'live',
    generated_at: '2026-08-17T08:00:00Z',
    data_as_of: '2026-08-16',
    candidates
  }), 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const firstPage = await fetch(`${server.baseUrl}/api/investment-screener/ranked?limit=10&offset=0`);
    const firstBody = await firstPage.json();
    assert.equal(firstPage.status, 200);
    assert.equal(firstBody.total_candidates, 32);
    assert.equal(firstBody.displayed_count, 10);
    assert.deepEqual(firstBody.pagination, { limit: 10, offset: 0, total: 32, has_more: true, next_offset: 10, previous_offset: null });
    assert.deepEqual(firstBody.candidates.map((candidate) => candidate.ticker), ['CO01', 'CO02', 'CO03', 'CO04', 'CO05', 'CO06', 'CO07', 'CO08', 'CO09', 'CO10']);

    const secondPage = await fetch(`${server.baseUrl}/api/investment-screener/ranked?limit=10&offset=10`);
    const secondBody = await secondPage.json();
    assert.equal(secondPage.status, 200);
    assert.deepEqual(secondBody.candidates.map((candidate) => candidate.ticker), ['CO11', 'CO12', 'CO13', 'CO14', 'CO15', 'CO16', 'CO17', 'CO18', 'CO19', 'CO20']);
    assert.deepEqual(secondBody.pagination, { limit: 10, offset: 10, total: 32, has_more: true, next_offset: 20, previous_offset: 0 });

    const searched = await fetch(`${server.baseUrl}/api/investment-screener/ranked?q=needle&limit=10`);
    const searchedBody = await searched.json();
    assert.equal(searched.status, 200);
    assert.equal(searchedBody.total_candidates, 1);
    assert.deepEqual(searchedBody.candidates.map((candidate) => candidate.ticker), ['CO28']);
    assert.deepEqual(searchedBody.applied_filters, { q: 'needle', limit: 10 });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/ranked returns a clear no-match message without leaking unsafe query paths', async () => {
  const rankedPath = new URL('./fixtures/investment-screener-ranked.json', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=ASX`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.candidates, []);
    assert.equal(body.messages.some((message) => /No candidates match/i.test(message)), true);
    assert.equal(JSON.stringify(body).includes('/root/'), false);
  } finally {
    await server.close();
  }
});


test('GET /api/investment-screener/ranked validates filter query params with redacted errors', async () => {
  const rankedPath = new URL('./fixtures/investment-screener-ranked.json', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const invalidTopN = await fetch(`${server.baseUrl}/api/investment-screener/ranked?topN=999&market=/root/secret`);
    const invalidTopNBody = await invalidTopN.json();
    assert.equal(invalidTopN.status, 400);
    assert.equal(invalidTopNBody.error, 'invalid_investment_screener_filter');
    assert.equal(JSON.stringify(invalidTopNBody).includes('/root/secret'), false);

    const unsupportedField = await fetch(`${server.baseUrl}/api/investment-screener/ranked?provider=eodhd`);
    const unsupportedBody = await unsupportedField.json();
    assert.equal(unsupportedField.status, 400);
    assert.equal(unsupportedBody.error, 'unsupported_investment_screener_filter');
    assert.match(unsupportedBody.message, /not supported/i);
  } finally {
    await server.close();
  }
});



test('GET /api/investment-screener/ranked filters explicit NASDAQ exchange without generic US collapse', async () => {
  const configPath = await writeConfig(basicConfig);
  const dir = await mkdtemp(join(tmpdir(), 'investment-nasdaq-filter-'));
  const rankedPath = join(dir, 'latest_ranked.json');
  const candidates = [
    { rank: 1, ticker: 'AAPL.US', name: 'Apple Inc.', market: 'NASDAQ', exchange: 'NASDAQ', region: 'US', currency: 'USD', sector: 'Technology', industry: 'Consumer Electronics', score: 91, sub_scores: { quality: 25 } },
    { rank: 2, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', exchange: 'ASX', region: 'AU', currency: 'AUD', sector: 'Materials', industry: 'Metals & Mining', score: 88, sub_scores: { quality: 20 } }
  ];
  await writeFile(rankedPath, JSON.stringify({
    mode: 'nasdaq-eodhd-fundamentals',
    generated_at: '2026-09-07T00:00:00Z',
    data_as_of: '2026-09-06',
    coverage: { denominator: 3432, usable: 1, denominator_label: 'NASDAQ listed equities (security-type-filtered, reviewed static seed)', denominator_status: 'complete_security_type_filtered_listing' },
    source_summary: { provider: 'eodhd', mode: 'nasdaq-eodhd-fundamentals' },
    candidates
  }), 'utf8');
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/investment-screener/ranked?market=NASDAQ&exchange=NASDAQ&region=US`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.candidates.map((candidate) => candidate.ticker), ['AAPL.US']);
    assert.deepEqual(body.applied_filters, { market: 'NASDAQ', exchange: 'NASDAQ', region: 'US' });
    assert.equal(body.candidates[0].market, 'NASDAQ');
    assert.equal(body.candidates[0].exchange, 'NASDAQ');
    assert.equal(body.candidates[0].region, 'US');
    assert.equal(JSON.stringify(body).includes('"market":"US"'), false);
    assert.equal(body.coverage.denominator_label, 'NASDAQ listed equities (security-type-filtered, reviewed static seed)');
    assert.equal(body.coverage.denominator_status, 'complete_security_type_filtered_listing');
    assert.equal(JSON.stringify(body).includes('NASDAQ-100'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/investment-screener/ranked filters by sector and industry and surfaces facet options', async () => {
  const rankedPath = new URL('./fixtures/investment-screener-ranked.json', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);

  // Enrich the fixture on the wire path is not possible (fixture has no sector/industry),
  // so write a dedicated ASX fixture with classification values.
  const dir = await mkdtemp(join(tmpdir(), 'investment-sector-filter-'));
  const customRanked = join(dir, 'latest_ranked.json');
  const candidates = [
    { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', sector: 'Materials', industry: 'Metals & Mining', score: 88, sub_scores: { valuation: 25 } },
    { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', sector: 'Health Care', industry: 'Biotechnology', score: 86, sub_scores: { valuation: 17 } },
    { rank: 3, ticker: 'CBA.AX', name: 'Commonwealth Bank', market: 'ASX', currency: 'AUD', sector: 'Financials', industry: 'Banks', score: 84, sub_scores: { valuation: 20 } }
  ];
  await writeFile(customRanked, JSON.stringify({ mode: 'asx-yahoo-timeseries', generated_at: '2026-08-22T08:00:00Z', data_as_of: '2026-08-21', candidates }), 'utf8');

  const customApp = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: customRanked });
  const customServer = await listen(customApp);
  await server.close();
  try {
    const bySector = await fetch(`${customServer.baseUrl}/api/investment-screener/ranked?sector=Materials`);
    const bySectorBody = await bySector.json();
    assert.equal(bySector.status, 200);
    assert.deepEqual(bySectorBody.candidates.map((candidate) => candidate.ticker), ['BHP.AX']);
    assert.deepEqual(bySectorBody.applied_filters, { sector: ['Materials'] });

    const byIndustry = await fetch(`${customServer.baseUrl}/api/investment-screener/ranked?industry=Banks`);
    const byIndustryBody = await byIndustry.json();
    assert.deepEqual(byIndustryBody.candidates.map((candidate) => candidate.ticker), ['CBA.AX']);

    const multi = await fetch(`${customServer.baseUrl}/api/investment-screener/ranked?sector=Materials&sector=Financials`);
    const multiBody = await multi.json();
    assert.deepEqual(multiBody.candidates.map((candidate) => candidate.ticker), ['BHP.AX', 'CBA.AX']);
    assert.deepEqual(multiBody.applied_filters, { sector: ['Materials', 'Financials'] });

    const facetsResp = await fetch(`${customServer.baseUrl}/api/investment-screener/ranked`);
    const facetsBody = await facetsResp.json();
    assert.ok(Array.isArray(facetsBody.available_facets.sectors));
    assert.ok(facetsBody.available_facets.sectors.includes('Materials'));
    assert.ok(facetsBody.available_facets.industries.includes('Banks'));
  } finally {
    await customServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('GET /api/investment-screener/ranked round-trips comma-containing classification labels (multi-select regression)', async () => {
  const configPath = await writeConfig(basicConfig);
  const dir = await mkdtemp(join(tmpdir(), 'investment-comma-label-'));
  const customRanked = join(dir, 'latest_ranked.json');
  const candidates = [
    { rank: 1, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', sector: 'Pharmaceuticals, Biotechnology & Life Sciences', industry: 'Pharmaceuticals, Biotechnology & Life Sciences', score: 88, sub_scores: { valuation: 25 } },
    { rank: 2, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', sector: 'Materials', industry: 'Metals & Mining', score: 87, sub_scores: { valuation: 24 } },
    { rank: 3, ticker: 'TWE.AX', name: 'Treasury Wine', market: 'ASX', currency: 'AUD', sector: 'Food, Beverage & Tobacco', industry: 'Food, Beverage & Tobacco', score: 86, sub_scores: { valuation: 23 } }
  ];
  await writeFile(customRanked, JSON.stringify({ mode: 'asx-yahoo-timeseries', generated_at: '2026-08-22T08:00:00Z', data_as_of: '2026-08-21', candidates }), 'utf8');

  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: customRanked });
  const server = await listen(app);
  try {
    // A single selection of a comma-containing sector must round-trip as exactly
    // that label — not be split into fragments that produce a false zero-match.
    const single = await fetch(`${server.baseUrl}/api/investment-screener/ranked?sector=${encodeURIComponent('Pharmaceuticals, Biotechnology & Life Sciences')}`);
    const singleBody = await single.json();
    assert.equal(single.status, 200);
    assert.deepEqual(singleBody.candidates.map((candidate) => candidate.ticker), ['CSL.AX']);
    assert.deepEqual(singleBody.applied_filters, { sector: ['Pharmaceuticals, Biotechnology & Life Sciences'] });

    const byIndustry = await fetch(`${server.baseUrl}/api/investment-screener/ranked?industry=${encodeURIComponent('Food, Beverage & Tobacco')}`);
    const industryBody = await byIndustry.json();
    assert.deepEqual(industryBody.candidates.map((candidate) => candidate.ticker), ['TWE.AX']);

    // Two comma-containing sectors selected together still match both.
    const multi = await fetch(`${server.baseUrl}/api/investment-screener/ranked?sector=${encodeURIComponent('Pharmaceuticals, Biotechnology & Life Sciences')}&sector=${encodeURIComponent('Food, Beverage & Tobacco')}`);
    const multiBody = await multi.json();
    assert.deepEqual(multiBody.candidates.map((candidate) => candidate.ticker).sort(), ['CSL.AX', 'TWE.AX']);
    assert.deepEqual(multiBody.applied_filters, { sector: ['Pharmaceuticals, Biotechnology & Life Sciences', 'Food, Beverage & Tobacco'] });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('GET /api/investment-screener/ranked treats missing classification truthfully and rejects unsafe labels', async () => {
  const rankedPath = new URL('./fixtures/investment-screener-ranked.json', import.meta.url);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, investmentScreenerRankedFile: rankedPath });
  const server = await listen(app);
  try {
    // Invalid sector value contains a path/secret shape -> 400, no echo.
    const bad = await fetch(`${server.baseUrl}/api/investment-screener/ranked?sector=${encodeURIComponent('/root/secret')}`);
    const badBody = await bad.json();
    assert.equal(bad.status, 400);
    assert.equal(badBody.error, 'invalid_investment_screener_filter');
    assert.equal(JSON.stringify(badBody).includes('/root/secret'), false);

    // Classification is not available on the fixture, so an unknown-but-valid label yields zero matches (truthful), not an error.
    const unknown = await fetch(`${server.baseUrl}/api/investment-screener/ranked?sector=${encodeURIComponent('No Such Sector')}`);
    const unknownBody = await unknown.json();
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknownBody.candidates, []);
    assert.equal(unknownBody.messages.some((message) => /No candidates match/i.test(message)), true);
  } finally {
    await server.close();
  }
});


// ──────────────────────────────────────────────
// /api/epics tests
// ──────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';

/**
 * Create a minimal kanban.db in a temp dir for testing.
 * Returns the path to the db file.
 */
function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'epics-test-'));
  const dbPath = join(dir, 'kanban.db');
  const schema = `
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, assignee TEXT, status TEXT NOT NULL, completed_at INTEGER, body TEXT);
    CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER, kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY (parent_id, child_id));
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, profile TEXT, step_key TEXT, status TEXT NOT NULL, claim_lock TEXT, claim_expires INTEGER, worker_pid INTEGER, max_runtime_seconds INTEGER, last_heartbeat_at INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT, summary TEXT, metadata TEXT, error TEXT);
  `;
  execFileSync('sqlite3', [dbPath, schema]);
  return { dbPath, dir };
}

function seed(dbPath, sql) {
  execFileSync('sqlite3', [dbPath, sql]);
}

test('GET /api/epics returns a sanitized 503 when kanban DB is missing', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: '/tmp/definitely-no-such-kanban.db' });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'kanban_db_unavailable');
    assert.equal(JSON.stringify(body).includes('/tmp/definitely-no-such-kanban.db'), false);
  } finally {
    await server.close();
  }
});

test('GET /api/epics reads a valid kanban DB even when sqlite3 is not executable', async () => {
  const { dbPath, dir } = makeTempDb();
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_a1193120','Fixture Completed Epic','domovoi','done',1786160311,'secret body do not leak');
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_a1193120',NULL,'decomposed',NULL,1786160311);
  `);

  const originalPath = process.env.PATH;
  process.env.PATH = '';
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.epics.some((epic) => epic.id === 't_a1193120'), true);
    assert.equal(JSON.stringify(body).includes('secret body'), false);
  } finally {
    process.env.PATH = originalPath;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics returns epics with the public response shape only', async () => {
  const { dbPath, dir } = makeTempDb();
  const epicMetadata = JSON.stringify({ child_tasks: [{ id: 't_c11d03', label: 'Metadata Child' }] });
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_epic01','Epic One','domovoi','done',1748000000,'secret body do not leak');
    INSERT INTO tasks VALUES ('t_child01','Child One','kobold','done',1747900000,'child body do not leak');
    INSERT INTO tasks VALUES ('t_child02','Child Two','gremlin','running',NULL,'another body');
    INSERT INTO tasks VALUES ('t_c11d03','Metadata Child','scribe','done',1747950000,'metadata child body');
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_epic01',NULL,'decomposed',NULL,1748000000);
    INSERT INTO task_links VALUES ('t_child01','t_epic01');
    INSERT INTO task_links VALUES ('t_child02','t_epic01');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_epic01','domovoi','done',1747990000,1748000000,'completed','${epicMetadata.replace(/'/g, "''")}');
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ['epics']);
    assert.equal(body.epics.length, 1);
    const epic = body.epics[0];
    assert.deepEqual(Object.keys(epic), ['id', 'title', 'completed_at', 'subtasks', 'doc_links']);
    assert.equal(epic.id, 't_epic01');
    assert.equal(epic.title, 'Epic One');
    assert.equal(epic.completed_at, new Date(1748000000 * 1000).toISOString());
    assert.deepEqual(epic.subtasks, [
      { id: 't_child01', title: 'Child One', assignee: 'kobold', status: 'done' },
      { id: 't_child02', title: 'Child Two', assignee: 'gremlin', status: 'running' },
      { id: 't_c11d03', title: 'Metadata Child', assignee: 'scribe', status: 'done' }
    ]);
    assert.deepEqual(epic.doc_links, []);
    assert.equal(JSON.stringify(body).includes('secret body'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics returns doc_links only from committed scribe child artifacts', async () => {
  const { dbPath, dir } = makeTempDb();
  const epicMeta = JSON.stringify({
    artifacts: [
      '/root/work/home-lab/README.md',
      '/root/.hermes/profiles/gremlin/secrets/nope.md',
      'relative/should-not.md'
    ],
    token: 'do-not-leak'
  });
  const scribeAssigneeMeta = JSON.stringify({
    artifacts: [
      '/root/work/home-lab/services/personal-dashboard/README.md',
      '/root/work/home-lab/tmp/uncommitted-kanban-review-proof.md',
      '/root/work/home-lab/services/personal-dashboard/README.md'
    ]
  });
  const scribeProfileMeta = JSON.stringify({
    artifacts: ['/root/work/home-lab/docs/service-catalog.md']
  });
  const nonScribeMeta = JSON.stringify({
    artifacts: ['/root/work/home-lab/docs/backup-coverage-matrix.md']
  });

  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_epic02','Epic Two','domovoi','done',1748001000,'epic body should stay private');
    INSERT INTO tasks VALUES ('t_c11d03','Doc Child','scribe','done',1747960000,'scribe body should stay private');
    INSERT INTO tasks VALUES ('t_child04','Profile Scribe Child','gremlin','done',1747961000,NULL);
    INSERT INTO tasks VALUES ('t_child05','Non Scribe Child','gremlin','done',1747962000,NULL);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_epic02',NULL,'decomposed','event-payload-should-not-leak',1748001000);
    INSERT INTO task_links VALUES ('t_c11d03','t_epic02');
    INSERT INTO task_links VALUES ('t_child04','t_epic02');
    INSERT INTO task_links VALUES ('t_child05','t_epic02');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_epic02','domovoi','done',1747990000,1748001000,'completed','${epicMeta.replace(/'/g, "''")}');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_c11d03','scribe','done',1747950000,1747960000,'completed','${scribeAssigneeMeta.replace(/'/g, "''")}');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_child04','scribe','done',1747951000,1747961000,'completed','${scribeProfileMeta.replace(/'/g, "''")}');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_child05','gremlin','done',1747952000,1747962000,'completed','${nonScribeMeta.replace(/'/g, "''")}');
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.deepEqual(body.epics[0].doc_links, [
      { label: 'README.md', url: 'https://github.com/LimbicNode42/home-lab/blob/master/services/personal-dashboard/README.md' },
      { label: 'service-catalog.md', url: 'https://github.com/LimbicNode42/home-lab/blob/master/docs/service-catalog.md' }
    ]);
    assert.equal(serialized.includes('do-not-leak'), false);
    assert.equal(serialized.includes('event-payload-should-not-leak'), false);
    assert.equal(serialized.includes('epic body should stay private'), false);
    assert.equal(serialized.includes('scribe body should stay private'), false);
    assert.equal(serialized.includes('backup-coverage-matrix'), false);
    assert.equal(serialized.includes('uncommitted-kanban-review-proof'), false);
    assert.equal(serialized.includes('/root/'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics requires authentication in reverse-proxy mode', async () => {
  const { dbPath, dir } = makeTempDb();
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user', kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const unauth = await fetch(`${server.baseUrl}/api/epics`);
    assert.equal(unauth.status, 401);

    const auth = await fetch(`${server.baseUrl}/api/epics`, { headers: { 'x-forwarded-user': 'ben' } });
    assert.notEqual(auth.status, 401);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/docs returns only approved committed markdown docs and excludes secret-shaped paths', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    docsManifest: [
      { id: 'dashboard-readme', title: 'Dashboard README', path: 'services/personal-dashboard/README.md' },
      { id: 'absolute', title: 'Absolute Path', path: '/root/work/home-lab/README.md' },
      { id: 'uncommitted', title: 'Scratch Draft', path: 'tmp/uncommitted-kanban-review-proof.md' },
      { id: 'secret-type', title: 'Env File', path: 'services/personal-dashboard/.env.example' },
      { id: 'traversal', title: 'Traversal', path: '../README.md' }
    ]
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/docs`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ['documents']);
    assert.deepEqual(body.documents, [
      { id: 'dashboard-readme', title: 'Dashboard README', path: 'services/personal-dashboard/README.md' }
    ]);
    assert.equal(serialized.includes('uncommitted-kanban-review-proof'), false);
    assert.equal(serialized.includes('.env'), false);
  } finally {
    await server.close();
  }
});



test('GET /api/docs preserves safe document category metadata for grouped navigation', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    docsManifest: [
      { id: 'dashboard-readme', title: 'Dashboard README', category: 'Dashboard', path: 'services/personal-dashboard/README.md' },
      { id: 'service-catalog', title: 'Service Catalog', group: 'Operations', path: 'docs/service-catalog.md' },
      { id: 'backup-coverage', title: 'Backup Coverage Matrix', category: 'SECRET_TOKEN=do-not-leak', path: 'docs/backup-coverage-matrix.md' }
    ]
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/docs`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.deepEqual(body.documents, [
      { id: 'dashboard-readme', title: 'Dashboard README', path: 'services/personal-dashboard/README.md', category: 'Dashboard' },
      { id: 'service-catalog', title: 'Service Catalog', path: 'docs/service-catalog.md', category: 'Operations' },
      { id: 'backup-coverage', title: 'Backup Coverage Matrix', path: 'docs/backup-coverage-matrix.md' }
    ]);
    assert.equal(serialized.includes('do-not-leak'), false);
  } finally {
    await server.close();
  }
});
test('GET /api/docs/:id returns content only for an approved manifest id', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    docsManifest: [
      { id: 'service-catalog', title: 'Service catalog', path: 'docs/service-catalog.md' },
      { id: 'scratch', title: 'Scratch', path: 'tmp/uncommitted-kanban-review-proof.md' }
    ]
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/docs/service-catalog`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ['id', 'title', 'path', 'content']);
    assert.equal(body.id, 'service-catalog');
    assert.equal(body.title, 'Service catalog');
    assert.equal(body.path, 'docs/service-catalog.md');
    assert.ok(body.content.includes('# Service Catalog'));

    const scratch = await fetch(`${server.baseUrl}/api/docs/scratch`);
    assert.equal(scratch.status, 404);

    const pathQuery = await fetch(`${server.baseUrl}/api/docs/service-catalog?path=/root/work/home-lab/README.md`);
    const pathQueryBody = await pathQuery.json();
    assert.equal(pathQuery.status, 200);
    assert.equal(pathQueryBody.path, 'docs/service-catalog.md');
    assert.equal(JSON.stringify(pathQueryBody).includes('/root/work/home-lab/README.md'), false);
  } finally {
    await server.close();
  }
});

test('GET /api/docs/:id sanitizes copied container docs from a configurable repo docs root', async () => {
  const repoDocsRoot = await mkdtemp(join(tmpdir(), 'repo-docs-root-'));
  const docPath = join(repoDocsRoot, 'services', 'personal-dashboard', 'README.md');
  await mkdir(join(repoDocsRoot, 'services', 'personal-dashboard'), { recursive: true });
  await writeFile(docPath, '# Dashboard\n\nSource lives at /root/work/home-lab/services/personal-dashboard and Hermes at /root/.hermes.\nContainer paths like /app/config/dashboard.public.json and scratch files like /tmp/test-report.txt should not be served.\nTOKEN="quoted-secret-fixture"\nAuthorization: Bearer abcdefghijklmnop\n', 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    repoDocsRoot,
    docsManifest: [
      { id: 'dashboard-readme', title: 'Dashboard README', path: 'services/personal-dashboard/README.md' }
    ]
  });
  const server = await listen(app);
  try {
    const listResponse = await fetch(`${server.baseUrl}/api/docs`);
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listBody.documents, [
      { id: 'dashboard-readme', title: 'Dashboard README', path: 'services/personal-dashboard/README.md' }
    ]);

    const readmeResponse = await fetch(`${server.baseUrl}/api/docs/dashboard-readme`);
    const readmeBody = await readmeResponse.json();
    const serialized = JSON.stringify(readmeBody);
    assert.equal(readmeResponse.status, 200);
    assert.equal(readmeBody.path, 'services/personal-dashboard/README.md');
    assert.ok(readmeBody.content.includes('# Dashboard'));
    for (const forbidden of [repoDocsRoot, '/root/work/home-lab', '/root/.hermes', '/app/config', '/tmp/test-report', 'quoted-secret-fixture', 'Bearer abcdefgh']) {
      assert.equal(serialized.includes(forbidden), false, `docs response leaked ${forbidden}`);
    }
  } finally {
    await server.close();
    await rm(repoDocsRoot, { recursive: true, force: true });
  }
});

test('GET /api/docs lists only docs present in the runtime repo docs root', async () => {
  const repoDocsRoot = await mkdtemp(join(tmpdir(), 'repo-docs-root-filter-'));
  const docPath = join(repoDocsRoot, 'services', 'personal-dashboard', 'README.md');
  await mkdir(join(repoDocsRoot, 'services', 'personal-dashboard'), { recursive: true });
  await writeFile(docPath, '# Dashboard\n\nOnly this doc was copied into the container.\n', 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    repoDocsRoot,
    docsManifest: [
      { id: 'dashboard-readme', title: 'Dashboard README', path: 'services/personal-dashboard/README.md' },
      { id: 'service-catalog', title: 'Service Catalog', path: 'docs/service-catalog.md' },
      { id: 'backup-coverage', title: 'Backup Coverage Matrix', path: 'docs/backup-coverage-matrix.md' }
    ]
  });
  const server = await listen(app);
  try {
    const listResponse = await fetch(`${server.baseUrl}/api/docs`);
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listBody.documents, [
      { id: 'dashboard-readme', title: 'Dashboard README', path: 'services/personal-dashboard/README.md' }
    ]);

    const readmeResponse = await fetch(`${server.baseUrl}/api/docs/dashboard-readme`);
    assert.equal(readmeResponse.status, 200);

    const missingResponse = await fetch(`${server.baseUrl}/api/docs/service-catalog`);
    assert.equal(missingResponse.status, 404);
  } finally {
    await server.close();
    await rm(repoDocsRoot, { recursive: true, force: true });
  }
});

test('GET /api/docs default runtime docs do not expose local paths, DB paths, diagnostics, or secret-shaped values', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true
  });
  const server = await listen(app);
  try {
    const listResponse = await fetch(`${server.baseUrl}/api/docs`);
    const listBody = await listResponse.json();
    const listSerialized = JSON.stringify(listBody);
    assert.equal(listResponse.status, 200);
    assert.equal(listSerialized.includes('.env'), false);

    for (const doc of listBody.documents) {
      const docResponse = await fetch(`${server.baseUrl}/api/docs/${encodeURIComponent(doc.id)}`);
      const docBody = await docResponse.json();
      const serialized = JSON.stringify(docBody);

      assert.equal(docResponse.status, 200);
      assert.equal(docBody.id, doc.id);
      for (const forbidden of ['/root/', '/root/.hermes', '/mnt/nas', '/app/', '/tmp/', 'kanban.db', 'stderr', 'diagnostic']) {
        assert.equal(serialized.includes(forbidden), false, `${doc.id} leaked ${forbidden}`);
      }
      assert.doesNotMatch(serialized, /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*[:=]\s*(?:["'][^"']{4,}["']|[^\s"']{4,})/i);
      assert.doesNotMatch(serialized, /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._-]{8,}/i);
      assert.equal(serialized.includes('DASHBOARD_AUTH_MODE=***'), false);
      assert.equal(serialized.includes('DASHBOARD_ALLOW_DISABLED_AUTH=***'), false);
    }
  } finally {
    await server.close();
  }
});

test('README local smoke commands use runnable non-secret disabled-auth values', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal(readme.includes('DASHBOARD_AUTH_MODE=***'), false);
  assert.equal(readme.includes('DASHBOARD_ALLOW_DISABLED_AUTH=***'), false);
  assert.ok(readme.includes('DASHBOARD_AUTH_MODE=disabled DASHBOARD_ALLOW_DISABLED_AUTH=true'));
  assert.ok(readme.includes('DASHBOARD_AUTH_MODE=disabled \\\n  DASHBOARD_ALLOW_DISABLED_AUTH=true'));
});

test('GET /api/docs requires authentication in reverse-proxy mode', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user' });
  const server = await listen(app);
  try {
    const unauth = await fetch(`${server.baseUrl}/api/docs`);
    assert.equal(unauth.status, 401);

    const auth = await fetch(`${server.baseUrl}/api/docs`, { headers: { 'x-forwarded-user': 'ben' } });
    assert.notEqual(auth.status, 401);
  } finally {
    await server.close();
  }
});

test('GET /api/docs surfaces completed feature guides without completed-epic docs', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/docs`);
    const body = await response.json();
    assert.equal(response.status, 200);

    const docsById = new Map(body.documents.map((doc) => [doc.id, doc]));
    const expectedFeatureDocs = [
      ['dashboard-overview', 'Dashboard', 'services/personal-dashboard/docs/products/dashboard/overview.md'],
      ['dashboard-documentation-panel', 'Dashboard', 'services/personal-dashboard/docs/products/dashboard/documentation-panel.md'],
      ['blog-drafts-guide', 'Blog / Drafts', 'services/personal-dashboard/docs/products/blog-drafts/README.md'],
      ['reports-homelab-health', 'Reports', 'services/personal-dashboard/docs/products/reports/homelab-health.md'],
      ['reports-finnick', 'Reports', 'services/personal-dashboard/docs/products/reports/finnick.md'],
      ['diary-goals-guide', 'Diary & Goals', 'services/personal-dashboard/docs/products/diary-goals/README.md'],
      ['investment-screener-data-source-coverage', 'Investment Screener', 'services/personal-dashboard/docs/products/investment-screener/data-source-coverage.md']
    ];

    for (const [id, category, path] of expectedFeatureDocs) {
      const doc = docsById.get(id);
      assert.ok(doc, `${id} should be listed in the Documentation panel registry`);
      assert.equal(doc.category, category);
      assert.equal(doc.path, path);
    }

    assert.equal(docsById.has('dashboard-completed-epics'), false);
    const epicDocs = body.documents.filter((doc) => doc.id.startsWith('epic-t-') || doc.category === 'Completed Epics' || doc.path?.startsWith('services/personal-dashboard/docs/epics/'));
    assert.deepEqual(epicDocs, []);
    assert.equal(JSON.stringify(body).includes('/root/'), false);
  } finally {
    await server.close();
  }
});

test('GET /api/epics links every completed fixture epic to an opaque dashboard doc id', async () => {
  const { dbPath, dir } = makeTempDb();
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_a1193120','investment screener: global Graham/Buffett/Munger value-growth reporting','domovoi','done',1786171111,'private investment body');
    INSERT INTO tasks VALUES ('t_792f7c02','Home dashboard improvements: layout, navigation, and documentation','domovoi','done',1786171000,'private dashboard body');
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_a1193120',NULL,'decomposed',NULL,1786171111);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_792f7c02',NULL,'decomposed',NULL,1786171000);
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const docsResponse = await fetch(`${server.baseUrl}/api/docs`);
    const docsBody = await docsResponse.json();
    const epicsResponse = await fetch(`${server.baseUrl}/api/epics`);
    const epicsBody = await epicsResponse.json();

    assert.equal(docsResponse.status, 200);
    assert.equal(epicsResponse.status, 200);
    assert.equal(epicsBody.epics.length, 2);

    for (const epic of epicsBody.epics) {
      assert.ok(epic.doc_links.length >= 1, `${epic.id} should have a dashboard doc link`);
      const docLink = epic.doc_links[0];
      assert.equal(docLink.doc_id, `epic-${epic.id.replaceAll('_', '-')}`);
      assert.equal(docsBody.documents.some((doc) => doc.id === docLink.doc_id), false);
      assert.equal(docLink.url, `/api/docs/${docLink.doc_id}`);
      assert.equal(JSON.stringify(docLink).includes('/root/'), false);

      const docResponse = await fetch(`${server.baseUrl}${docLink.url}`);
      assert.equal(docResponse.status, 200);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/docs/:id serves an epic doc by opaque id and rejects traversal ids', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/docs/epic-t-a1193120?path=/root/.hermes/kanban.db`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.id, 'epic-t-a1193120');
    assert.equal(body.path, 'services/personal-dashboard/docs/epics/t_a1193120.md');
    assert.ok(body.content.includes('investment screener'));
    for (const forbidden of ['/root/', '/root/.hermes', '/mnt/nas', 'kanban.db', 'sqlite', 'EACCES', 'stderr', 'PRIVATE KEY']) {
      assert.equal(serialized.includes(forbidden), false, `epic doc response leaked ${forbidden}`);
    }
    assert.doesNotMatch(serialized, /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*[:=]\s*(?:["'][^"']{4,}["']|[^\s"']{4,})/i);

    const traversal = await fetch(`${server.baseUrl}/api/docs/..%2FREADME`);
    assert.equal(traversal.status, 404);
  } finally {
    await server.close();
  }
});

test('GET /api/epics returns completed epics in reverse-chronological order', async () => {
  const { dbPath, dir } = makeTempDb();
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_older','Older Epic','domovoi','done',1747000000,NULL);
    INSERT INTO tasks VALUES ('t_newer','Newer Epic','domovoi','done',1748000000,NULL);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_older',NULL,'decomposed',NULL,1747000000);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_newer',NULL,'decomposed',NULL,1748000000);
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.epics.map((epic) => epic.id), ['t_newer', 't_older']);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics returns a completed fan-in task without a decomposed event', async () => {
  const { dbPath, dir } = makeTempDb();
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_aaa111','Source A','scribe','done',1748090000,'private source a');
    INSERT INTO tasks VALUES ('t_bbb222','Source B','gremlin','done',1748090100,'private source b');
    INSERT INTO tasks VALUES ('t_ccc333','Final Fan In','scribe','done',1748100000,'private final body');
    INSERT INTO task_links VALUES ('t_aaa111','t_ccc333');
    INSERT INTO task_links VALUES ('t_bbb222','t_ccc333');
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.deepEqual(body.epics.map((epic) => epic.id), ['t_ccc333']);
    assert.deepEqual(body.epics[0].subtasks, [
      { id: 't_aaa111', title: 'Source A', assignee: 'scribe', status: 'done' },
      { id: 't_bbb222', title: 'Source B', assignee: 'gremlin', status: 'done' }
    ]);
    assert.equal(serialized.includes('private final body'), false);
    assert.equal(serialized.includes('private source a'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics returns an investment-screener task_graph with downstream remediation context', async () => {
  const { dbPath, dir } = makeTempDb();
  const taskGraph = JSON.stringify({
    task_graph: {
      t_4c6ff1da: { title: 'investment screener source discovery: Americas markets', assignee: 'scribe', parents: ['t_a1193120'] },
      t_f1f96f56: { title: 'investment screener source discovery: ASX/LSE/JPX/Europe', assignee: 'scribe', parents: ['t_a1193120'] },
      t_280f62fc: { title: 'investment screener scoring model and report schema', assignee: 'scribe', parents: ['t_4c6ff1da', 't_f1f96f56'] },
      t_170b4552: { title: 'investment screener prototype CLI and sample report', assignee: 'gremlin', parents: ['t_280f62fc'] },
      t_e721423a: { title: 'investment screener validation and safety review', assignee: 'sentinel', parents: ['t_170b4552'] },
      t_1a435422: { title: 'investment screener homelab trigger and runbook plan', assignee: 'kobold', parents: ['t_170b4552'] },
      t_c66f2c52: { title: 'investment screener final synthesis report', assignee: 'scribe', parents: ['t_e721423a', 't_1a435422'] }
    },
    routing_notes: ['private metadata should not leak'],
    private_flag: 'credential-shaped fixture should not leak'
  });
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_a1193120','investment screener: global Graham/Buffett/Munger value-growth reporting','domovoi','done',1786171111,'root body private');
    INSERT INTO tasks VALUES ('t_4c6ff1da','investment screener source discovery: Americas markets','scribe','done',1786171200,'americas body private');
    INSERT INTO tasks VALUES ('t_f1f96f56','investment screener source discovery: ASX/LSE/JPX/Europe','scribe','done',1786171300,NULL);
    INSERT INTO tasks VALUES ('t_280f62fc','investment screener scoring model and report schema','scribe','done',1786171400,NULL);
    INSERT INTO tasks VALUES ('t_170b4552','investment screener prototype CLI and sample report','gremlin','done',1786171500,NULL);
    INSERT INTO tasks VALUES ('t_e721423a','investment screener validation and safety review','sentinel','done',1786171600,NULL);
    INSERT INTO tasks VALUES ('t_1a435422','investment screener homelab trigger and runbook plan','kobold','done',1786171700,NULL);
    INSERT INTO tasks VALUES ('t_c66f2c52','investment screener final synthesis report','scribe','done',1786171800,NULL);
    INSERT INTO tasks VALUES ('t_11ef1004','remediate investment screener validation blockers','gremlin','done',1786250010,NULL);
    INSERT INTO task_links VALUES ('t_a1193120','t_4c6ff1da');
    INSERT INTO task_links VALUES ('t_a1193120','t_f1f96f56');
    INSERT INTO task_links VALUES ('t_4c6ff1da','t_280f62fc');
    INSERT INTO task_links VALUES ('t_f1f96f56','t_280f62fc');
    INSERT INTO task_links VALUES ('t_280f62fc','t_170b4552');
    INSERT INTO task_links VALUES ('t_170b4552','t_e721423a');
    INSERT INTO task_links VALUES ('t_170b4552','t_1a435422');
    INSERT INTO task_links VALUES ('t_e721423a','t_c66f2c52');
    INSERT INTO task_links VALUES ('t_1a435422','t_c66f2c52');
    INSERT INTO task_links VALUES ('t_e721423a','t_11ef1004');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_a1193120','domovoi','done',1786171000,1786171111,'completed','${taskGraph.replace(/'/g, "''")}');
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.deepEqual(body.epics.map((epic) => epic.id), ['t_a1193120']);
    const subtaskIds = body.epics[0].subtasks.map((task) => task.id);
    for (const expectedId of ['t_170b4552', 't_e721423a', 't_c66f2c52', 't_11ef1004']) {
      assert.ok(subtaskIds.includes(expectedId), `${expectedId} should be visible as investment graph context`);
    }
    assert.equal(serialized.includes('investment screener final synthesis report'), true);
    assert.equal(serialized.includes('remediate investment screener validation blockers'), true);
    assert.equal(serialized.includes('root body private'), false);
    assert.equal(serialized.includes('private metadata should not leak'), false);
    assert.equal(serialized.includes('credential-shaped fixture should not leak'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics ignores malformed run metadata safely', async () => {
  const { dbPath, dir } = makeTempDb();
  const nonObjectMetadata = JSON.stringify(['not', 'an', 'object']);
  const malformedChildren = JSON.stringify({ child_tasks: [{ id: '../nope' }, { task_id: 'not-a-task' }, null], artifacts: 'not-an-array' });
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_malformed','Malformed Metadata Epic','domovoi','done',1748100000,'private body');
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_malformed',NULL,'decomposed','private payload',1748100000);
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_malformed','domovoi','done',1748090000,1748100000,'completed','not json at all');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_malformed','domovoi','done',1748090001,1748100000,'completed','${nonObjectMetadata.replace(/'/g, "''")}');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_malformed','domovoi','done',1748090002,1748100000,'completed','${malformedChildren.replace(/'/g, "''")}');
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.epics.length, 1);
    assert.deepEqual(body.epics[0].subtasks, []);
    assert.deepEqual(body.epics[0].doc_links, []);
    assert.equal(serialized.includes('private body'), false);
    assert.equal(serialized.includes('private payload'), false);
    assert.equal(serialized.includes('not json at all'), false);
    assert.equal(serialized.includes('../nope'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});


// ──────────────────────────────────────────────
// /api/kanban/board tests
// ──────────────────────────────────────────────
function makeBoardTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-board-test-'));
  const dbPath = join(dir, 'kanban.db');
  const schema = `
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      assignee TEXT,
      status TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY (parent_id, child_id));
  `;
  execFileSync('sqlite3', [dbPath, schema]);
  return { dbPath, dir };
}
