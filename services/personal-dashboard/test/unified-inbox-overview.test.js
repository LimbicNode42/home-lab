import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { normalizeConfig, toPublicConfig } from '../src/config.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-unified-inbox-'));
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

const unifiedInboxConfig = {
  ...basicConfig,
  statusChecks: [
    {
      id: 'unified-inbox',
      label: 'Unified Inbox',
      targetUrl: 'http://192.168.0.20:4323/healthz',
      displayUrl: 'http://192.168.0.20:4323',
      acceptableStatuses: [200],
      timeoutMs: 1000
    }
  ],
  unifiedInbox: {
    enabled: true,
    title: 'Unified Inbox',
    publicUrl: 'http://192.168.0.20:4323',
    statusUrl: 'http://192.168.0.20:4323/api/unified-inbox/status',
    note: 'Read-only message aggregation status. Counts and freshness only.',
    expectedConnectors: [
      { id: 'discord', label: 'Discord', state: 'pending_credentials', detail: 'Connector credentials have not been authorized in this phase.' }
    ],
    timeoutMs: 1000
  }
};

test('normalizes Unified Inbox public config while hiding backend status URL', () => {
  const publicConfig = toPublicConfig(normalizeConfig(unifiedInboxConfig));
  const serialized = JSON.stringify(publicConfig);

  assert.equal(publicConfig.unifiedInbox.enabled, true);
  assert.equal(publicConfig.unifiedInbox.publicUrl, 'http://192.168.0.20:4323');
  assert.equal(publicConfig.unifiedInbox.statusUrl, undefined);
  assert.equal(publicConfig.statusChecks[0].displayUrl, 'http://192.168.0.20:4323');
  assert.equal(serialized.includes('targetUrl'), false);
  assert.equal(serialized.includes('/api/unified-inbox/status'), false);
  assert.equal(serialized.includes('body_text'), false);
  assert.equal(serialized.includes('/root/'), false);
  assert.equal(serialized.includes('/mnt/nas'), false);
});

test('rejects Unified Inbox URLs with credential query parameters', () => {
  assert.throws(
    () => normalizeConfig({
      ...unifiedInboxConfig,
      unifiedInbox: {
        ...unifiedInboxConfig.unifiedInbox,
        statusUrl: 'http://192.168.0.20:4323/api/unified-inbox/status?token=secret'
      }
    }),
    /must not embed credentials/i
  );
});

test('GET /api/unified-inbox/status reports not_configured when backend status URL is absent', async () => {
  const configPath = await writeConfig(unifiedInboxConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, unifiedInboxStatusUrl: null });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/unified-inbox/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.cacheStatus, 'not_configured');
    assert.equal(body.service.status, 'not_configured');
    assert.equal(body.connectors[0].state, 'pending_credentials');
    assert.equal(body.message_count, 0);
  } finally {
    await server.close();
  }
});

test('GET /api/unified-inbox/status surfaces sanitized backend connector status and freshness', async () => {
  const backend = await listen((_request, response) => {
    const payload = {
      service: { name: 'unified-inbox', mode: 'read_only', status: 'ok' },
      connectors: [
        {
          source: 'discord',
          account_ref: 'homelab-discord',
          state: 'pending_credentials',
          checked_at: '2026-09-01T10:00:00.000Z',
          last_success_at: null,
          last_error_code: 'credentials_missing',
          detail: 'OAuth setup is waiting for credentials.',
          body_text: 'super secret message body that must not leak'
        }
      ],
      message_count: 12,
      snapshots: {
        latest_batch_id: 'batch-123',
        record_count: 12,
        min_sent_at: '2026-09-01T09:00:00.000Z',
        max_sent_at: '2026-09-01T09:45:00.000Z',
        sha256: 'abc123',
        placements: { local_closed_snapshot: true, nas_snapshot: true, manifest: true }
      },
      messages: [{ body_text: 'do not show this either' }],
      exclusions: [{ source: 'whatsapp-personal-dm', state: 'excluded', reason: 'unsanctioned personal DM access is out of scope' }]
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  const configPath = await writeConfig(unifiedInboxConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, unifiedInboxStatusUrl: `${backend.baseUrl}/api/unified-inbox/status` });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/unified-inbox/status`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.service.status, 'ok');
    assert.equal(body.connectors[0].source, 'discord');
    assert.equal(body.connectors[0].state, 'pending_credentials');
    assert.equal(body.message_count, 12);
    assert.equal(body.snapshots.latest_batch_id, 'batch-123');
    assert.equal(body.snapshots.max_sent_at, '2026-09-01T09:45:00.000Z');
    assert.equal(body.exclusions[0].source, 'whatsapp-personal-dm');
    assert.equal(serialized.includes('super secret message body'), false);
    assert.equal(serialized.includes('do not show this either'), false);
    assert.equal(serialized.includes('body_text'), false);
    assert.equal(serialized.includes('sha256'), false);
    assert.equal(serialized.includes('/root/'), false);
    assert.equal(serialized.includes('/mnt/nas'), false);
  } finally {
    await server.close();
    await backend.close();
  }
});

test('GET /api/unified-inbox/status requires reverse-proxy auth', async () => {
  const configPath = await writeConfig(unifiedInboxConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user', unifiedInboxStatusUrl: null });
  const server = await listen(app);

  try {
    const unauthorized = await fetch(`${server.baseUrl}/api/unified-inbox/status`);
    const authorized = await fetch(`${server.baseUrl}/api/unified-inbox/status`, { headers: { 'x-forwarded-user': 'ben' } });

    assert.equal(unauthorized.status, 401);
    assert.equal(authorized.status, 200);
  } finally {
    await server.close();
  }
});

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('Overview HTML contains a Unified Inbox panel with loading state', () => {
  assert.match(indexSource, /id="panel-overview"[\s\S]*id="unified-inbox-panel"[\s\S]*id="unified-inbox-overview"/);
  assert.match(indexSource, /Loading unified inbox status/);
});

test('app.js renders Unified Inbox counts, freshness, connector states, exclusions, and safe link', () => {
  assert.match(appSource, /function renderUnifiedInboxOverview\(status/);
  assert.match(appSource, /Messages indexed:/);
  assert.match(appSource, /Freshness:/);
  assert.match(appSource, /pending_credentials/);
  assert.match(appSource, /Excluded personal DM sources/);
  assert.match(appSource, /\/api\/unified-inbox\/status/);
  assert.match(appSource, /Open Unified Inbox/);
});

test('styles.css defines Unified Inbox overview grid/card styling', () => {
  assert.match(stylesSource, /\.unified-inbox-grid/);
  assert.match(stylesSource, /\.unified-inbox-summary-card/);
  assert.match(stylesSource, /\.unified-inbox-connectors/);
});
