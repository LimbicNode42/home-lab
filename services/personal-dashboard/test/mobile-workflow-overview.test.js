import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { normalizeConfig, toPublicConfig } from '../src/config.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-mobile-workflow-'));
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

const mobileWorkflowConfig = {
  title: 'Home Dashboard',
  sections: [],
  statusChecks: [],
  mobileWorkflow: {
    enabled: true,
    title: 'Flutter mobile workflow',
    host: 'tori',
    components: [
      { id: 'flutter', label: 'Flutter SDK', state: 'last_known_present', detail: 'Flutter 3.47.2 was verified on tori.' },
      { id: 'android-sdk', label: 'Android SDK', state: 'last_known_present', detail: 'Android SDK is available for headless builds.' },
      { id: 'avd-flutter-headless', label: 'AVD flutter_headless', state: 'last_known_present', detail: 'The AVD exists and is not started by the dashboard.' }
    ],
    runtime: { state: 'not_running', adbDeviceId: null, detail: 'No adb device attached during the last check.' },
    lastSuccessfulCycleAt: null,
    viewer: {
      mode: 'review_required',
      label: 'Emulator viewer requires review',
      instruction: 'Use the proven headless cycle on tori until a read-only authenticated viewer is approved.',
      href: null
    }
  }
};

test('normalizes Flutter mobile workflow metadata for public display', () => {
  const publicConfig = toPublicConfig(normalizeConfig(mobileWorkflowConfig));

  assert.equal(publicConfig.mobileWorkflow.enabled, true);
  assert.equal(publicConfig.mobileWorkflow.host, 'tori');
  assert.deepEqual(publicConfig.mobileWorkflow.components.map((component) => component.id), ['flutter', 'android-sdk', 'avd-flutter-headless']);
  assert.equal(publicConfig.mobileWorkflow.runtime.state, 'not_running');
  assert.equal(publicConfig.mobileWorkflow.viewer.mode, 'review_required');
  const serialized = JSON.stringify(publicConfig);
  assert.equal(serialized.includes('/root/'), false);
  assert.equal(serialized.includes('/mnt/nas'), false);
  assert.equal(serialized.includes('targetUrl'), false);
});

test('rejects direct LAN emulator viewer links without reviewed authenticated access', () => {
  assert.throws(
    () => normalizeConfig({
      ...mobileWorkflowConfig,
      mobileWorkflow: {
        ...mobileWorkflowConfig.mobileWorkflow,
        viewer: {
          mode: 'ssh_tunnel',
          label: 'Bad viewer',
          instruction: 'This should be refused.',
          href: 'http://192.168.0.50:5900'
        }
      }
    }),
    /direct emulator links require reviewed authenticated proxy access/i
  );
});



test('accepts reviewed dashboard-relative mobile viewer without embedding credentials', () => {
  const publicConfig = toPublicConfig(normalizeConfig({
    ...mobileWorkflowConfig,
    mobileWorkflow: {
      ...mobileWorkflowConfig.mobileWorkflow,
      viewer: {
        mode: 'authenticated_novnc',
        label: 'Android emulator viewer',
        instruction: 'Open the authenticated dashboard noVNC viewer. The browser receives no backend connection material.',
        href: '/mobile-viewer/'
      }
    }
  }));

  assert.equal(publicConfig.mobileWorkflow.viewer.mode, 'authenticated_novnc');
  assert.equal(publicConfig.mobileWorkflow.viewer.href, '/mobile-viewer/');
  assert.equal(/token|password|secret/i.test(JSON.stringify(publicConfig)), false);
});

test('rejects authenticated mobile viewer links that point back to the dashboard root', () => {
  assert.throws(
    () => normalizeConfig({
      ...mobileWorkflowConfig,
      mobileWorkflow: {
        ...mobileWorkflowConfig.mobileWorkflow,
        viewer: {
          mode: 'authenticated_novnc',
          label: 'Bad viewer',
          instruction: 'This should be refused.',
          href: 'https://dashboard.wheeler-network.com/'
        }
      }
    }),
    /authenticated noVNC links must use the dashboard \/mobile-viewer\/ proxy/i
  );
});

test('rejects mobile viewer links that embed credentials', () => {
  assert.throws(
    () => normalizeConfig({
      ...mobileWorkflowConfig,
      mobileWorkflow: {
        ...mobileWorkflowConfig.mobileWorkflow,
        viewer: {
          mode: 'authenticated_novnc',
          label: 'Bad viewer',
          instruction: 'This should be refused.',
          href: 'https://dashboard.wheeler-network.com/mobile-viewer/?token=secret'
        }
      }
    }),
    /links must not embed credentials|unsafe operator internals|authenticated noVNC links must use the dashboard \/mobile-viewer\/ proxy/i
  );
});

test('GET /api/mobile-workflow/status falls back safely when no cache file is configured', async () => {
  const configPath = await writeConfig(mobileWorkflowConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, mobileWorkflowStatusFile: null });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/mobile-workflow/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.cacheStatus, 'not_configured');
    assert.equal(body.runtime.state, 'not_running');
    assert.equal(body.runtime.adbDeviceId, null);
    assert.equal(body.components.some((component) => component.id === 'avd-flutter-headless'), true);
  } finally {
    await server.close();
  }
});

test('GET /api/mobile-workflow/status returns sanitized cached runtime state', async () => {
  const configPath = await writeConfig(mobileWorkflowConfig);
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-mobile-status-'));
  const statusFile = join(dir, 'status.json');
  await writeFile(statusFile, JSON.stringify({
    generatedAt: '2026-09-01T06:30:00.000Z',
    runtime: { state: 'running', adbDeviceId: 'emulator-5554', bootCompleted: true, detail: 'adb reports device and sys.boot_completed=1' },
    lastSuccessfulCycleAt: '2026-09-01T03:00:00.000Z'
  }), 'utf8');
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, mobileWorkflowStatusFile: statusFile });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/mobile-workflow/status`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.cacheStatus, 'fresh');
    assert.equal(body.runtime.state, 'running');
    assert.equal(body.runtime.adbDeviceId, 'emulator-5554');
    assert.equal(body.runtime.bootCompleted, true);
    assert.equal(body.lastSuccessfulCycleAt, '2026-09-01T03:00:00.000Z');
    assert.equal(serialized.includes(statusFile), false);
    assert.equal(serialized.includes('/tmp/'), false);
  } finally {
    await server.close();
  }
});

test('GET /api/mobile-workflow/status reports malformed cache without leaking raw parse output', async () => {
  const configPath = await writeConfig(mobileWorkflowConfig);
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-mobile-malformed-'));
  const statusFile = join(dir, 'status.json');
  await writeFile(statusFile, '{not-json', 'utf8');
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, mobileWorkflowStatusFile: statusFile });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/mobile-workflow/status`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 502);
    assert.equal(body.cacheStatus, 'malformed');
    assert.equal(body.runtime.state, 'not_running');
    assert.equal(serialized.includes('SyntaxError'), false);
    assert.equal(serialized.includes(statusFile), false);
  } finally {
    await server.close();
  }
});

test('GET /api/mobile-workflow/status requires reverse-proxy auth', async () => {
  const configPath = await writeConfig(mobileWorkflowConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user', mobileWorkflowStatusFile: null });
  const server = await listen(app);

  try {
    const unauthorized = await fetch(`${server.baseUrl}/api/mobile-workflow/status`);
    const authorized = await fetch(`${server.baseUrl}/api/mobile-workflow/status`, { headers: { 'x-forwarded-user': 'ben' } });

    assert.equal(unauthorized.status, 401);
    assert.equal(authorized.status, 200);
  } finally {
    await server.close();
  }
});


test('GET /mobile-viewer/ requires dashboard auth before proxying noVNC', async () => {
  const configPath = await writeConfig(mobileWorkflowConfig);
  const app = await createApp({
    configPath,
    authMode: 'reverse-proxy',
    proxyUserHeader: 'x-forwarded-user',
    mobileViewerUpstreamUrl: 'http://127.0.0.1:9',
    mobileViewerToken: 'unused-test-token'
  });
  const server = await listen(app);

  try {
    const unauthorized = await fetch(`${server.baseUrl}/mobile-viewer/`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await server.close();
  }
});

test('GET /mobile-viewer/ serves the reviewed noVNC viewer instead of the dashboard shell', async () => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, '/vnc.html?autoconnect=1&resize=scale&path=mobile-viewer/websockify');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>noVNC</title><main>Reviewed emulator viewer</main>');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  const configPath = await writeConfig(mobileWorkflowConfig);
  const app = await createApp({
    configPath,
    authMode: 'reverse-proxy',
    proxyUserHeader: 'x-forwarded-user',
    mobileViewerUpstreamUrl: `http://127.0.0.1:${port}`,
    mobileViewerToken: 'unused-test-token'
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/mobile-viewer/`, { headers: { 'x-forwarded-user': 'ben' } });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Reviewed emulator viewer/);
    assert.doesNotMatch(body, /id=\"dashboard-title\"|Home Dashboard/);
  } finally {
    await server.close();
    await new Promise((resolve, reject) => upstream.close((err) => err ? reject(err) : resolve()));
  }
});

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('Overview HTML contains a Flutter mobile workflow panel with loading state', () => {
  assert.match(indexSource, /id="panel-overview"[\s\S]*id="mobile-workflow-panel"[\s\S]*id="mobile-workflow-overview"/);
  assert.match(indexSource, /Loading mobile workflow status/);
});

test('app.js renders mobile runtime, adb device, last successful cycle, and viewer instruction', () => {
  assert.match(appSource, /function renderMobileWorkflowOverview\(status/);
  assert.match(appSource, /Runtime:/);
  assert.match(appSource, /ADB device:/);
  assert.match(appSource, /Last successful headless cycle:/);
  assert.match(appSource, /Open reviewed emulator viewer/);
  assert.match(appSource, /\/api\/mobile-workflow\/status/);
});

test('styles.css defines mobile workflow overview grid/card styling', () => {
  assert.match(stylesSource, /\.mobile-workflow-grid/);
  assert.match(stylesSource, /\.mobile-runtime-card/);
  assert.match(stylesSource, /\.mobile-components/);
});
