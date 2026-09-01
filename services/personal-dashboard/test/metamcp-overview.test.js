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
      mode: 'ssh_tunnel',
      localUrl: 'http://127.0.0.1:12008',
      command: 'ssh -L 12008:127.0.0.1:12008 tori',
      note: 'Aggregator remains loopback-only; use the tunnel before opening the local UI link.'
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
  assert.equal(publicConfig.metaMcp.access.mode, 'ssh_tunnel');
  assert.equal(publicConfig.metaMcp.access.localUrl, 'http://127.0.0.1:12008');
  assert.equal(JSON.stringify(publicConfig).includes('bearer'), false);
  assert.equal(JSON.stringify(publicConfig).includes('/root/'), false);
});

test('rejects MetaMCP direct LAN UI links so loopback stays behind a reviewed access decision', () => {
  assert.throws(
    () => normalizeConfig({
      ...metamcpConfig,
      metaMcp: {
        ...metamcpConfig.metaMcp,
        access: { ...metamcpConfig.metaMcp.access, mode: 'direct_link', localUrl: 'http://192.168.0.20:12008' }
      }
    }),
    /MetaMCP.*direct.*reviewed/i
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
    assert.equal(body.metaMcp.tools.total, 36);
    assert.equal(body.metaMcp.services[1].label, 'MetaMCP Postgres');
    assert.equal(body.metaMcp.access.command, 'ssh -L 12008:127.0.0.1:12008 tori');
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

test('app.js renders MetaMCP services, domain tool counts, and SSH tunnel access instruction', () => {
  assert.match(appSource, /function renderMetaMcpOverview\(metaMcp\)/);
  assert.match(appSource, /MetaMCP overview is not configured on this dashboard/);
  assert.match(appSource, /ssh_tunnel/);
  assert.match(appSource, /Use SSH tunnel/);
  assert.match(appSource, /domain\.count/);
  assert.match(appSource, /service\.state/);
  assert.match(appSource, /renderMetaMcpOverview\(config\.metaMcp\)/);
});

test('styles.css defines MetaMCP overview grid/card styling', () => {
  assert.match(stylesSource, /\.metamcp-grid/);
  assert.match(stylesSource, /\.metamcp-domain-list/);
});
