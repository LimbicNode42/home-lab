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
  const publicConfig = toPublicConfig(normalizeConfig(source));
  const coreLinks = publicConfig.sections.flatMap((section) => section.links).filter((link) => /metamcp/i.test(`${link.label} ${link.href}`));
  const metamcpStatus = publicConfig.statusChecks.find((check) => check.id === 'metamcp-gateway');
  const accessUrls = [publicConfig.metaMcp.access.localUrl, ...publicConfig.metaMcp.access.links.map((link) => link.href)];

  assert.deepEqual(coreLinks.map((link) => link.href), ['http://metamcp.local:12008']);
  assert.equal(metamcpStatus.displayUrl, 'http://metamcp.local:12008');
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
