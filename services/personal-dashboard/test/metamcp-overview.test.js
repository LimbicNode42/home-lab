import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { normalizeConfig, toPublicConfig } from '../src/config.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-metamcp-'));
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
  sections: [],
  statusChecks: []
};

const metamcpConfig = {
  ...basicConfig,
  metaMcp: {
    enabled: true,
    title: 'MetaMCP aggregator',
    version: '2.4.22',
    services: [
      { id: 'metamcp', label: 'MetaMCP app', state: 'last_known_healthy', detail: 'Loopback-only on tori.' },
      { id: 'metamcp-pg', label: 'MetaMCP Postgres', state: 'last_known_healthy', detail: 'Internal database for MetaMCP.' }
    ],
    tools: {
      total: 36,
      domains: [
        { id: 'filesystem', label: 'filesystem', count: 11 },
        { id: 'git', label: 'git', count: 11 },
        { id: 'memory', label: 'memory', count: 9 },
        { id: 'fetch', label: 'fetch', count: 5 }
      ]
    },
    access: {
      mode: 'lan_gateway',
      localUrl: 'http://metamcp.local:12008',
      note: 'LAN gateway requires authentication; the dashboard stores only URLs.',
      links: [
        { label: 'Open MetaMCP gateway (metamcp.local)', href: 'http://metamcp.local:12008' },
        { label: 'MCP endpoint (metamcp.local)', href: 'http://metamcp.local:12008/mcp' }
      ]
    }
  }
};

test('normalizes MetaMCP overview metadata for public display', () => {
  const publicConfig = toPublicConfig(normalizeConfig(metamcpConfig));

  assert.equal(publicConfig.metaMcp.enabled, true);
  assert.equal(publicConfig.metaMcp.version, '2.4.22');
  assert.deepEqual(publicConfig.metaMcp.services.map((service) => service.id), ['metamcp', 'metamcp-pg']);
  assert.equal(publicConfig.metaMcp.tools.total, 36);
  assert.deepEqual(publicConfig.metaMcp.tools.domains.map((domain) => domain.id), ['filesystem', 'git', 'memory', 'fetch']);
  assert.equal(publicConfig.metaMcp.access.mode, 'lan_gateway');
  assert.equal(publicConfig.metaMcp.access.localUrl, 'http://metamcp.local:12008');
  assert.deepEqual(publicConfig.metaMcp.access.links.map((link) => link.href), ['http://metamcp.local:12008', 'http://metamcp.local:12008/mcp']);
  assert.equal(JSON.stringify(publicConfig.metaMcp.access).includes('http://192.168.0.20:12008'), false);
  assert.equal(JSON.stringify(publicConfig).includes('bearer'), false);
  assert.equal(JSON.stringify(publicConfig).includes('/root/'), false);
});

test('accepts reviewed MetaMCP LAN gateway links without embedding credentials', () => {
  const publicConfig = toPublicConfig(normalizeConfig(metamcpConfig));
  const serialized = JSON.stringify(publicConfig.metaMcp.access);

  assert.equal(publicConfig.metaMcp.access.mode, 'lan_gateway');
  assert.equal(publicConfig.metaMcp.access.links[0].href, 'http://metamcp.local:12008');
  assert.equal(serialized.includes('api_key'), false);
  assert.equal(serialized.includes('token='), false);
});

test('rejects MetaMCP LAN links with credential query parameters', () => {
  assert.throws(
    () => normalizeConfig({
      ...metamcpConfig,
      metaMcp: {
        ...metamcpConfig.metaMcp,
        access: { ...metamcpConfig.metaMcp.access, links: [{ label: 'Bad', href: 'http://metamcp.local:12008?token=secret' }] }
      }
    }),
    /must not embed credentials/i
  );
});


test('repository config keeps MetaMCP Overview links friendly-name only while status display uses metamcp.local', async () => {
  const source = JSON.parse(await readFile(new URL('../config/dashboard.public.json', import.meta.url), 'utf8'));
  const normalizedConfig = normalizeConfig(source);
  const publicConfig = toPublicConfig(normalizedConfig);
  const coreLinks = publicConfig.sections.flatMap((section) => section.links).filter((link) => /metamcp/i.test(`${link.label} ${link.href}`));
  const metamcpStatus = publicConfig.statusChecks.find((check) => check.id === 'metamcp-gateway');
  const internalMetamcpStatus = normalizedConfig.statusChecks.find((check) => check.id === 'metamcp-gateway');
  const accessUrls = [publicConfig.metaMcp.access.localUrl, ...publicConfig.metaMcp.access.links.map((link) => link.href)];

  assert.deepEqual(coreLinks.map((link) => link.href), ['http://metamcp.local:12008']);
  assert.equal(metamcpStatus.displayUrl, 'http://metamcp.local:12008');
  assert.equal(internalMetamcpStatus.timeoutMs, 6000);
  assert.match(internalMetamcpStatus.statusDetail, /false-down flapping/);
  assert.deepEqual(accessUrls, ['http://metamcp.local:12008', 'http://metamcp.local:12008', 'http://metamcp.local:12008/mcp']);
  assert.equal(JSON.stringify({ coreLinks, metamcpStatus, accessUrls }).includes('http://192.168.0.20:12008'), false);
});

test('GET /api/config/public returns the MetaMCP overview without target URLs or secrets', async () => {
  const configPath = await writeConfig(metamcpConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/config/public`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.metaMcp.tools.total, 36);
    assert.equal(body.metaMcp.services[1].label, 'MetaMCP Postgres');
    assert.equal(body.metaMcp.access.links[0].href, 'http://metamcp.local:12008');
    assert.equal(serialized.includes('http://192.168.0.20:12008'), false);
    assert.equal(body.metaMcp.access.command, undefined);
    assert.equal(serialized.includes('targetUrl'), false);
    assert.equal(serialized.includes('TOKEN'), false);
    assert.equal(serialized.includes('/mnt/nas'), false);
  } finally {
    await server.close();
  }
});

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('Overview HTML contains a MetaMCP panel with loading state', () => {
  assert.match(indexSource, /id="panel-overview"[\s\S]*id="metamcp-panel"[\s\S]*id="metamcp-overview"/);
  assert.match(indexSource, /Loading MetaMCP overview/);
});

test('app.js renders MetaMCP services, live gateway status, domain tool counts, and LAN access links', () => {
  assert.match(appSource, /function renderMetaMcpOverview\(metaMcp, statusPayload = null\)/);
  assert.match(appSource, /MetaMCP overview is not configured on this dashboard/);
  assert.match(appSource, /metamcp-gateway/);
  assert.match(appSource, /Live gateway:/);
  assert.match(appSource, /metamcp-access-links/);
  assert.match(appSource, /domain\.count/);
  assert.match(appSource, /service\.state/);
  assert.match(appSource, /renderMetaMcpOverview\(dashboardConfig\.metaMcp, payload\)/);
});

test('styles.css defines MetaMCP overview grid/card styling', () => {
  assert.match(stylesSource, /\.metamcp-grid/);
  assert.match(stylesSource, /\.metamcp-domain-list/);
});


async function writeMetaMcpStatusFile(payload) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-metamcp-status-'));
  const path = join(dir, 'status.json');
  await writeFile(path, JSON.stringify(payload), 'utf8');
  return path;
}

async function metamcpStatusApp({ statusFile, probeStatus = 200, authMode = 'disabled', staleAfterMs = 15 * 60 * 1000 } = {}) {
  const probe = await listen((_request, response) => {
    response.writeHead(probeStatus).end();
  });
  const configPath = await writeConfig({
    ...metamcpConfig,
    statusChecks: [{ id: 'metamcp-gateway', label: 'MetaMCP gateway', targetUrl: `${probe.baseUrl}/health`, displayUrl: 'http://metamcp.local:12008', acceptableStatuses: [200] }]
  });
  const app = await createApp({
    configPath,
    authMode,
    nodeEnv: 'test',
    allowDisabledAuth: true,
    metaMcpStatusFile: statusFile,
    metaMcpStatusStaleAfterMs: staleAfterMs,
    statusCacheTtlMs: 0,
    statusProbeTimeoutMs: 100
  });
  const server = await listen(app);
  return { server, probe };
}

const liveMetaMcpSnapshot = {
  generatedAt: new Date().toISOString(),
  counts: { namespaces: 2, servers: 3 },
  namespaces: [{ name: 'financial-data' }, { name: 'homelab' }],
  servers: [
    { name: 'eodhd', namespace: 'financial-data', transport: 'STREAMABLE_HTTP', errorStatus: 'ok' },
    { name: 'git', namespace: 'homelab', transport: 'STDIO', errorStatus: 'ok' },
    { name: 'memory', namespace: 'homelab', transport: 'STDIO', errorStatus: 'ok' }
  ]
};

test('GET /api/metamcp/status reports live gateway and fresh publisher snapshot', async () => {
  const statusFile = await writeMetaMcpStatusFile(liveMetaMcpSnapshot);
  const { server, probe } = await metamcpStatusApp({ statusFile });

  try {
    const response = await fetch(`${server.baseUrl}/api/metamcp/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'up');
    assert.equal(body.gateway.status, 'up');
    assert.equal(body.gateway.displayUrl, 'http://metamcp.local:12008');
    assert.equal(body.registry.counts.servers, 3);
    assert.deepEqual(body.registry.namespaces.map((namespace) => namespace.name), ['financial-data', 'homelab']);
    assert.equal(body.cacheStatus, 'fresh');
  } finally {
    await server.close();
    await probe.close();
  }
});

test('GET /api/metamcp/status reports degraded when publisher snapshot is stale', async () => {
  const statusFile = await writeMetaMcpStatusFile({ ...liveMetaMcpSnapshot, generatedAt: '2026-01-01T00:00:00.000Z' });
  const { server, probe } = await metamcpStatusApp({ statusFile, staleAfterMs: 1000 });

  try {
    const response = await fetch(`${server.baseUrl}/api/metamcp/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'degraded');
    assert.equal(body.registry.freshness.stale, true);
    assert.match(body.message, /stale/i);
  } finally {
    await server.close();
    await probe.close();
  }
});

test('GET /api/metamcp/status reports degraded when publisher snapshot is missing', async () => {
  const missingFile = join(tmpdir(), `missing-metamcp-${Date.now()}.json`);
  const { server, probe } = await metamcpStatusApp({ statusFile: missingFile });

  try {
    const response = await fetch(`${server.baseUrl}/api/metamcp/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'degraded');
    assert.equal(body.cacheStatus, 'missing');
    assert.match(body.message, /No MetaMCP publisher snapshot/i);
  } finally {
    await server.close();
    await probe.close();
  }
});

test('GET /api/metamcp/status reports down when gateway health is down', async () => {
  const statusFile = await writeMetaMcpStatusFile(liveMetaMcpSnapshot);
  const { server, probe } = await metamcpStatusApp({ statusFile, probeStatus: 503 });

  try {
    const response = await fetch(`${server.baseUrl}/api/metamcp/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'down');
    assert.equal(body.gateway.status, 'down');
    assert.equal(body.gateway.httpStatus, 503);
  } finally {
    await server.close();
    await probe.close();
  }
});

test('GET /api/metamcp/status keeps auth boundary and does not leak raw targets or secrets', async () => {
  const statusFile = await writeMetaMcpStatusFile({
    ...liveMetaMcpSnapshot,
    namespaces: [{ name: 'homelab' }, { name: '192.168.0.20' }, { name: '/root/secret' }],
    servers: [
      { name: 'git', namespace: 'homelab', transport: 'STDIO', errorStatus: 'ok' },
      { name: '192.168.0.20', namespace: 'token=secret', transport: '/mnt/nas/private', errorStatus: 'ok' }
    ]
  });
  const { server, probe } = await metamcpStatusApp({ statusFile, authMode: 'reverse-proxy' });

  try {
    const unauthorized = await fetch(`${server.baseUrl}/api/metamcp/status`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${server.baseUrl}/api/metamcp/status`, { headers: { 'x-forwarded-user': 'ben@example.test' } });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.gateway.displayUrl, 'http://metamcp.local:12008');
    assert.equal(serialized.includes('192.168.0.20'), false);
    assert.equal(serialized.includes('token=secret'), false);
    assert.equal(serialized.includes('/root/'), false);
    assert.equal(serialized.includes('/mnt/nas'), false);
    assert.equal(serialized.includes('targetUrl'), false);
  } finally {
    await server.close();
    await probe.close();
  }
});
