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

async function writeStatus(payload) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-metamcp-status-'));
  const path = join(dir, 'status.json');
  await writeFile(path, JSON.stringify(payload), 'utf8');
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
    access: {
      mode: 'lan_gateway',
      localUrl: 'http://192.168.0.20:12008',
      note: 'LAN gateway requires authentication; the dashboard stores only the URL.',
      links: [
        { label: 'Open MetaMCP gateway', href: 'http://192.168.0.20:12008' },
        { label: 'MCP endpoint', href: 'http://192.168.0.20:12008/mcp' }
      ]
    }
  }
};

test('normalizes MetaMCP overview metadata for public display', () => {
  const publicConfig = toPublicConfig(normalizeConfig(metamcpConfig));

  assert.equal(publicConfig.metaMcp.enabled, true);
  assert.equal(publicConfig.metaMcp.version, '2.4.22');
  assert.deepEqual(publicConfig.metaMcp.services.map((service) => service.id), ['metamcp', 'metamcp-pg']);
  // The legacy "tools" snapshot is now optional and no longer authoritative.
  assert.equal(publicConfig.metaMcp.tools.total, null);
  assert.deepEqual(publicConfig.metaMcp.tools.domains, []);
  assert.equal(publicConfig.metaMcp.access.mode, 'lan_gateway');
  assert.equal(publicConfig.metaMcp.access.localUrl, 'http://192.168.0.20:12008');
  assert.deepEqual(publicConfig.metaMcp.access.links.map((link) => link.href), ['http://192.168.0.20:12008', 'http://192.168.0.20:12008/mcp']);
  assert.equal(JSON.stringify(publicConfig).includes('bearer'), false);
  assert.equal(JSON.stringify(publicConfig).includes('/root/'), false);
});

test('still accepts a legacy tools block for backward compatibility', () => {
  const publicConfig = toPublicConfig(normalizeConfig({
    ...metamcpConfig,
    metaMcp: {
      ...metamcpConfig.metaMcp,
      tools: { total: 36, domains: [{ id: 'filesystem', label: 'filesystem', count: 11 }] }
    }
  }));
  assert.equal(publicConfig.metaMcp.tools.total, 36);
  assert.deepEqual(publicConfig.metaMcp.tools.domains.map((d) => d.id), ['filesystem']);
});

test('accepts reviewed MetaMCP LAN gateway links without embedding credentials', () => {
  const publicConfig = toPublicConfig(normalizeConfig(metamcpConfig));
  const serialized = JSON.stringify(publicConfig.metaMcp.access);

  assert.equal(publicConfig.metaMcp.access.mode, 'lan_gateway');
  assert.equal(publicConfig.metaMcp.access.links[0].href, 'http://192.168.0.20:12008');
  assert.equal(serialized.includes('api_key'), false);
  assert.equal(serialized.includes('token='), false);
});

test('rejects MetaMCP LAN links with credential query parameters', () => {
  assert.throws(
    () => normalizeConfig({
      ...metamcpConfig,
      metaMcp: {
        ...metamcpConfig.metaMcp,
        access: { ...metamcpConfig.metaMcp.access, links: [{ label: 'Bad', href: 'http://192.168.0.20:12008?token=secret' }] }
      }
    }),
    /must not embed credentials/i
  );
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
    assert.equal(body.metaMcp.services[1].label, 'MetaMCP Postgres');
    assert.equal(body.metaMcp.access.links[0].href, 'http://192.168.0.20:12008');
    assert.equal(body.metaMcp.access.command, undefined);
    assert.equal(serialized.includes('targetUrl'), false);
    assert.equal(serialized.includes('TOKEN'), false);
    assert.equal(serialized.includes('/mnt/nas'), false);
  } finally {
    await server.close();
  }
});

test('GET /api/metamcp/status returns a fresh registry snapshot with sanitized servers', async () => {
  const statusPath = await writeStatus({
    generatedAt: '2026-09-07T12:00:00Z',
    servers: [
      { name: 'eodhd', transport: 'STREAMABLE_HTTP', namespace: 'financial-data', errorStatus: 'ok' },
      { name: 'filesystem', transport: 'STDIO', namespace: 'homelab', errorStatus: 'ok' },
      { name: 'homelab-endpoint', transport: 'STREAMABLE_HTTP', namespace: null, errorStatus: 'ok' }
    ],
    namespaces: [{ name: 'financial-data' }, { name: 'homelab' }],
    counts: { servers: 3, namespaces: 2 }
  });
  const configPath = await writeConfig(metamcpConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, metamcpStatusFile: statusPath });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/metamcp/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.cacheStatus, 'fresh');
    assert.equal(body.servers.length, 3);
    assert.deepEqual(body.servers.map((s) => s.name), ['eodhd', 'filesystem', 'homelab-endpoint']);
    assert.equal(body.servers[0].transport, 'STREAMABLE_HTTP');
    assert.equal(body.servers[0].namespace, 'financial-data');
    assert.equal(body.servers[2].namespace, null);
    assert.deepEqual(body.namespaces, ['financial-data', 'homelab']);
    assert.equal(body.generatedAt, '2026-09-07T12:00:00.000Z');
  } finally {
    await server.close();
  }
});

test('GET /api/metamcp/status drops servers with unsafe/secret fields', async () => {
  const statusPath = await writeStatus({
    generatedAt: '2026-09-07T12:00:00Z',
    servers: [
      { name: 'eodhd', transport: 'STREAMABLE_HTTP', namespace: 'financial-data', errorStatus: 'ok', url: 'http://secret-internal:8000/mcp', bearer_token: 'shhh' },
      { name: 'SUSPICIOUS name!', transport: 'STDIO', errorStatus: 'ok' },
      { name: 'legit', transport: 'bogus-transport', errorStatus: 'crashed' }
    ],
    namespaces: [{ name: 'financial-data' }, { name: '../bad' }]
  });
  const configPath = await writeConfig(metamcpConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, metamcpStatusFile: statusPath });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/metamcp/status`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    // Only "eodhd" and "legit" pass the name sanitizer; the unsafe name is dropped.
    assert.deepEqual(body.servers.map((s) => s.name), ['eodhd', 'legit']);
    // Secret fields never reach the public payload.
    assert.equal(serialized.includes('bearer_token'), false);
    assert.equal(serialized.includes('shhh'), false);
    assert.equal(serialized.includes('bogus-transport'), false); // non-allowlisted transport -> UNKNOWN
    assert.equal(body.servers[1].transport, 'UNKNOWN');
    // Unsafe namespace names are dropped.
    assert.deepEqual(body.namespaces, ['financial-data']);
  } finally {
    await server.close();
  }
});

test('GET /api/metamcp/status returns not_configured when no snapshot file is set', async () => {
  const configPath = await writeConfig(metamcpConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/metamcp/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.cacheStatus, 'not_configured');
    assert.deepEqual(body.servers, []);
  } finally {
    await server.close();
  }
});

test('GET /api/metamcp/status returns missing for a nonexistent snapshot file', async () => {
  const configPath = await writeConfig(metamcpConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, metamcpStatusFile: '/nonexistent/metamcp-status.json' });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/metamcp/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.cacheStatus, 'missing');
  } finally {
    await server.close();
  }
});

test('GET /api/metamcp/status requires auth when reverse-proxy mode is active', async () => {
  const configPath = await writeConfig(metamcpConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', nodeEnv: 'test' });
  const server = await listen(app);

  try {
    const unauth = await fetch(`${server.baseUrl}/api/metamcp/status`);
    assert.equal(unauth.status, 401);
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

test('app.js renders MetaMCP services, live gateway status, live registry, and LAN access links', () => {
  assert.match(appSource, /function renderMetaMcpOverview\(metaMcp, statusPayload = null\)/);
  assert.match(appSource, /MetaMCP overview is not configured on this dashboard/);
  assert.match(appSource, /metamcp-gateway/);
  assert.match(appSource, /Live gateway:/);
  assert.match(appSource, /metamcp-access-links/);
  assert.match(appSource, /service\.state/);
  assert.match(appSource, /renderMetaMcpOverview\(dashboardConfig\.metaMcp, payload\)/);
  // Live registered-server registry rendering.
  assert.match(appSource, /function refreshMetaMcpRegistry/);
  assert.match(appSource, /\/api\/metamcp\/status/);
  assert.match(appSource, /metamcp-server-list/);
});

test('styles.css defines MetaMCP registry styling', () => {
  assert.match(stylesSource, /\.metamcp-grid/);
  assert.match(stylesSource, /\.metamcp-registry/);
  assert.match(stylesSource, /\.metamcp-server-list/);
});