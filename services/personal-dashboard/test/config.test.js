import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, toPublicConfig } from '../src/config.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-config-'));
  const path = join(dir, 'dashboard.public.json');
  await writeFile(path, JSON.stringify(config), 'utf8');
  return path;
}

test('loadConfig validates dashboard title and section links', async () => {
  const path = await writeConfig({
    title: 'Home Dashboard',
    sections: [
      {
        title: 'Core',
        links: [{ label: 'Vaultwarden', href: 'https://vault.example.test' }]
      }
    ],
    statusChecks: []
  });

  const config = await loadConfig({ configPath: path });

  assert.equal(config.title, 'Home Dashboard');
  assert.equal(config.sections[0].links[0].label, 'Vaultwarden');
});

test('loadConfig rejects invalid public link URLs', async () => {
  const path = await writeConfig({
    title: 'Home Dashboard',
    sections: [{ title: 'Core', links: [{ label: 'Bad', href: 'javascript:alert(1)' }] }],
    statusChecks: []
  });

  await assert.rejects(() => loadConfig({ configPath: path }), /invalid link href/i);
});

test('toPublicConfig never exposes server-side probe target URLs', async () => {
  const path = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [
      {
        id: 'vaultwarden',
        label: 'Vaultwarden',
        targetUrl: 'http://vaultwarden.internal:80/alive',
        displayUrl: 'https://vault.example.test'
      }
    ]
  });

  const config = await loadConfig({ configPath: path });
  const publicConfig = toPublicConfig(config);

  assert.deepEqual(publicConfig.statusChecks, [
    { id: 'vaultwarden', label: 'Vaultwarden', displayUrl: 'https://vault.example.test' }
  ]);
  assert.equal(JSON.stringify(publicConfig).includes('vaultwarden.internal'), false);
});


test('loadConfig accepts same-origin dashboard doc links', async () => {
  const path = await writeConfig({
    title: 'Home Dashboard',
    sections: [{ title: 'Runbooks', links: [{ label: 'Mem0 Runbook', href: '/api/docs/mem0-service-runbook' }] }],
    statusChecks: []
  });

  const config = await loadConfig({ configPath: path });

  assert.equal(config.sections[0].links[0].href, '/api/docs/mem0-service-runbook');
});

test('toPublicConfig never exposes backup freshness filesystem paths', async () => {
  const path = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [
      {
        id: 'mem0-backup',
        label: 'Mem0 backup freshness',
        type: 'backupFreshness',
        backupDir: '/mnt/pve/NAS/backups/mem0',
        manifestFile: 'MANIFEST.txt',
        maxAgeHours: 36
      }
    ]
  });

  const config = await loadConfig({ configPath: path });
  const publicConfig = toPublicConfig(config);

  assert.deepEqual(publicConfig.statusChecks, [
    { id: 'mem0-backup', label: 'Mem0 backup freshness' }
  ]);
  assert.equal(JSON.stringify(publicConfig).includes('/mnt/pve/NAS'), false);
});

test('loadConfig accepts mem0Health checks but public config hides internals and secret env names', async () => {
  const path = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [
      {
        id: 'mem0-health',
        label: 'Mem0 memory provider',
        type: 'mem0Health',
        baseUrl: 'http://127.0.0.1:8888',
        sshHost: '192.168.0.20',
        sshUser: 'root',
        sshPort: 22,
        apiKeyEnv: 'MEM0_API_KEY',
        searchUserId: 'dashboard-smoke',
        dockerContainers: ['mem0-mem0-1', 'mem0-postgres-1'],
        logContainers: ['mem0-mem0-1']
      }
    ]
  });

  const config = await loadConfig({ configPath: path });
  assert.equal(config.statusChecks[0].type, 'mem0Health');
  assert.equal(config.statusChecks[0].baseUrl, 'http://127.0.0.1:8888');
  assert.equal(config.statusChecks[0].sshHost, '192.168.0.20');

  const publicConfig = toPublicConfig(config);
  assert.deepEqual(publicConfig.statusChecks, [
    { id: 'mem0-health', label: 'Mem0 memory provider' }
  ]);
  assert.equal(JSON.stringify(publicConfig).includes('MEM0_API_KEY'), false);
  assert.equal(JSON.stringify(publicConfig).includes('127.0.0.1'), false);
  assert.equal(JSON.stringify(publicConfig).includes('mem0-postgres-1'), false);
});

test('loadConfig rejects invalid mem0Health API key environment variable names', async () => {
  const path = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [
      {
        id: 'mem0-health',
        label: 'Mem0 memory provider',
        type: 'mem0Health',
        baseUrl: 'http://127.0.0.1:8888',
        apiKeyEnv: 'mem0-api-key'
      }
    ]
  });

  await assert.rejects(() => loadConfig({ configPath: path }), /apiKeyEnv/i);
});


test('loadConfig rejects invalid mem0Health SSH host values', async () => {
  const path = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [
      {
        id: 'mem0-health',
        label: 'Mem0 memory provider',
        type: 'mem0Health',
        baseUrl: 'http://127.0.0.1:8888',
        sshHost: 'bad host;rm -rf /'
      }
    ]
  });

  await assert.rejects(() => loadConfig({ configPath: path }), /sshHost/i);
});
