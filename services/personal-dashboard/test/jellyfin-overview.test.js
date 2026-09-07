import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadConfig, toPublicConfig } from '../src/config.js';

const dashboardConfigPath = new URL('../config/dashboard.public.json', import.meta.url);
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('committed public dashboard config exposes Jellyfin link and status display without leaking target URL', async () => {
  const config = await loadConfig({ configPath: dashboardConfigPath.pathname });
  const publicConfig = toPublicConfig(config);
  const serialized = JSON.stringify(publicConfig);

  assert.ok(publicConfig.sections.some((section) =>
    section.links.some((link) => link.label === 'Jellyfin' && link.href === 'http://jester.local:8096')
  ));
  assert.ok(publicConfig.statusChecks.some((check) =>
    check.id === 'jellyfin'
      && check.label === 'Jellyfin'
      && check.displayUrl === 'http://jester.local:8096'
  ));
  assert.equal(serialized.includes('192.168.0.8:8096/health'), false);
});

test('default public config includes Jellyfin with friendly browser URL and redacted IP health probe', async () => {
  const publicConfig = toPublicConfig(await loadConfig({}));
  const serialized = JSON.stringify(publicConfig);

  assert.ok(publicConfig.sections.some((section) =>
    section.links.some((link) => link.label === 'Jellyfin' && link.href === 'http://jester.local:8096')
  ));
  assert.ok(publicConfig.statusChecks.some((check) =>
    check.id === 'jellyfin'
      && check.label === 'Jellyfin'
      && check.displayUrl === 'http://jester.local:8096'
  ));
  assert.equal(serialized.includes('targetUrl'), false);
  assert.equal(serialized.includes('192.168.0.8:8096/health'), false);
});

test('overview renderer turns Jellyfin status check into an Open link card', () => {
  assert.match(appSource, /check\.label/);
  assert.match(appSource, /check\.displayUrl/);
  assert.match(appSource, /body\.push\(el\('a', \{ href: check\.displayUrl, text: 'Open', rel: 'noreferrer noopener' \}\)\)/);
});
