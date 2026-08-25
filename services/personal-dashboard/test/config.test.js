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


test('default public config includes external Hermes Kanban link and status check without leaking probe URL', async () => {
  const config = await loadConfig({});
  const publicConfig = toPublicConfig(config);
  const serialized = JSON.stringify(publicConfig);

  assert.ok(publicConfig.sections.some((section) => section.links.some((link) => link.label === 'Hermes Kanban' && link.href === 'http://192.168.0.20:9119/kanban')));
  assert.ok(publicConfig.statusChecks.some((check) => check.id === 'hermes-kanban' && check.label === 'Hermes Kanban' && check.displayUrl === 'http://192.168.0.20:9119/kanban'));
  assert.equal(serialized.includes('targetUrl'), false);
  assert.equal(serialized.includes('192.168.0.20:9119/kanban'), true);
});
