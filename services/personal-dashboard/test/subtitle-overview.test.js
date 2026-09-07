import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { normalizeConfig, toPublicConfig } from '../src/config.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-subtitle-'));
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
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

const basicConfig = {
  title: 'Home Dashboard',
  sections: [],
  statusChecks: []
};

const subtitleConfig = {
  ...basicConfig,
  subtitleAutomation: {
    enabled: true,
    title: 'Subtitle automation (Bazarr)',
    note: 'Last-known backfill summary, not a live poll.',
    state: 'provider_limited',
    link: { label: 'Open Bazarr', href: 'http://192.168.0.8:6767' },
    lastRunAt: '2026-09-08T02:29:44Z',
    providerSummary: 'gestdown worked; opensubtitlescom auth-failed.',
    blockedOn: 'Recover OpenSubtitles.com credentials.',
    coverage: { episodesDownloaded: 10, episodesWanted: 53, moviesWanted: 409 }
  }
};

test('normalizes subtitleAutomation overview metadata for public display', () => {
  const publicConfig = toPublicConfig(normalizeConfig(subtitleConfig));

  assert.equal(publicConfig.subtitleAutomation.enabled, true);
  assert.equal(publicConfig.subtitleAutomation.state, 'provider_limited');
  assert.equal(publicConfig.subtitleAutomation.link.href, 'http://192.168.0.8:6767');
  assert.equal(publicConfig.subtitleAutomation.lastRunAt, '2026-09-08T02:29:44Z');
  assert.deepEqual(publicConfig.subtitleAutomation.coverage, {
    episodesDownloaded: 10,
    episodesWanted: 53,
    moviesWanted: 409
  });
});

test('rejects subtitleAutomation link with embedded credentials', () => {
  assert.throws(
    () => normalizeConfig({
      ...subtitleConfig,
      subtitleAutomation: {
        ...subtitleConfig.subtitleAutomation,
        link: { label: 'Bad', href: 'http://192.168.0.8:6767?api_key=secret' }
      }
    }),
    /must not embed credentials/i
  );
});

test('rejects subtitleAutomation coverage with negative counts', () => {
  assert.throws(
    () => normalizeConfig({
      ...subtitleConfig,
      subtitleAutomation: {
        ...subtitleConfig.subtitleAutomation,
        coverage: { episodesDownloaded: -1 }
      }
    }),
    /non-negative integer/i
  );
});

test('omits subtitleAutomation from public config when not configured', () => {
  const publicConfig = toPublicConfig(normalizeConfig(basicConfig));
  assert.equal(publicConfig.subtitleAutomation, undefined);
});

test('GET /api/config/public returns the subtitle overview without secrets or target URLs', async () => {
  const configPath = await writeConfig(subtitleConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/config/public`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.subtitleAutomation.state, 'provider_limited');
    assert.equal(body.subtitleAutomation.link.href, 'http://192.168.0.8:6767');
    assert.equal(serialized.includes('api_key'), false);
    assert.equal(serialized.includes('token='), false);
    assert.equal(serialized.includes('targetUrl'), false);
    assert.equal(serialized.includes('/root/'), false);
  } finally {
    await server.close();
  }
});

test('GET /api/config/public requires auth when reverse-proxy mode is active', async () => {
  const configPath = await writeConfig(subtitleConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', nodeEnv: 'test' });
  const server = await listen(app);

  try {
    const unauth = await fetch(`${server.baseUrl}/api/config/public`);
    assert.equal(unauth.status, 401);
  } finally {
    await server.close();
  }
});

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('Overview HTML contains a subtitle automation panel with loading state', () => {
  assert.match(indexSource, /id="subtitle-automation-panel"/);
  assert.match(indexSource, /id="subtitle-automation-overview"/);
  assert.match(indexSource, /Loading subtitle automation status/);
});

test('app.js renders subtitle automation state, coverage, and link', () => {
  assert.match(appSource, /function renderSubtitleAutomationOverview/);
  assert.match(appSource, /Subtitle automation is not configured on this dashboard/);
  assert.match(appSource, /Last backfill run:/);
  assert.match(appSource, /Movies still wanted:/);
  assert.match(appSource, /renderSubtitleAutomationOverview\(subtitleAutomationConfig\)/);
});

test('styles.css defines subtitle automation styling', () => {
  assert.match(stylesSource, /\.subtitle-automation-grid/);
  assert.match(stylesSource, /\.subtitle-automation-summary-card/);
  assert.match(stylesSource, /\.subtitle-automation-detail-list/);
});