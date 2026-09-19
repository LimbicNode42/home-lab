import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeConfig, toPublicConfig } from '../src/config.js';

const baseCapability = {
  enabled: true,
  title: 'Media subtitles',
  status: 'blocked',
  freshnessLabel: 'Jellyfin-side verified 2026-09-19',
  summary: 'Jellyfin is reachable and the Open Subtitles plugin is installed, but search/download is blocked until the OpenSubtitles.com account login is reconciled.',
  provider: {
    label: 'Jellyfin Open Subtitles plugin',
    state: 'credentials_invalid',
    detail: 'Plugin version 24.0.0.0 is installed; the provider currently returns HTTP 401.'
  },
  automation: {
    label: 'Bazarr automation',
    state: 'healthy_separate_workflow',
    detail: 'Bazarr remains scheduled automation, not the Jellyfin in-app path.'
  },
  nextAction: 'Reconcile the account login, then verify search/download from Jellyfin.',
  links: [
    { label: 'Open Jellyfin subtitle workflow', href: 'http://192.168.0.8:8096' },
    { label: 'Open Bazarr automation', href: 'http://192.168.0.8:6767' }
  ]
};

test('normalizes public media subtitle capability without secret-bearing fields', () => {
  const publicConfig = toPublicConfig(normalizeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [],
    mediaSubtitleCapability: baseCapability
  }));
  const serialized = JSON.stringify(publicConfig);

  assert.equal(publicConfig.mediaSubtitleCapability.status, 'blocked');
  assert.equal(publicConfig.mediaSubtitleCapability.provider.state, 'credentials_invalid');
  assert.match(publicConfig.mediaSubtitleCapability.freshnessLabel, /2026-09-19/);
  assert.equal(publicConfig.mediaSubtitleCapability.links[0].href, 'http://192.168.0.8:8096');
  assert.doesNotMatch(serialized, /token|api[_-]?key|authorization|\/root\/|\/mnt\/nas/i);
});

test('rejects media subtitle capability links with embedded credential parameters', () => {
  assert.throws(
    () => normalizeConfig({
      title: 'Home Dashboard',
      sections: [],
      statusChecks: [],
      mediaSubtitleCapability: {
        ...baseCapability,
        links: [{ label: 'bad', href: 'https://jellyfin.example.test/?token=secret' }]
      }
    }),
    /links must not embed credentials/i
  );
});

test('dashboard overview renders a media subtitles panel and frontend renderer', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(indexSource, /id="media-subtitles-panel"/);
  assert.match(indexSource, /Loading media subtitle capability/);
  assert.match(appSource, /function renderMediaSubtitleCapability\(capability\)/);
  assert.match(appSource, /Next action:/);
  assert.match(appSource, /rel: 'noreferrer noopener'/);
  assert.match(stylesSource, /media-subtitle-components/);
});
