import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-server-'));
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
  sections: [{ title: 'Core', links: [{ label: 'Vaultwarden', href: 'https://vault.example.test' }] }],
  statusChecks: []
};

test('GET /healthz is unauthenticated and does not leak topology', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy' });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/healthz`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: 'ok' });
    assert.equal(JSON.stringify(body).includes('vault'), false);
  } finally {
    await server.close();
  }
});

test('authenticated APIs reject requests without the reverse proxy identity header', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user' });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/config/public`);
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('authenticated APIs allow requests with the reverse proxy identity header', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user' });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/config/public`, {
      headers: { 'x-forwarded-user': 'ben' }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.title, 'Home Dashboard');
  } finally {
    await server.close();
  }
});

test('disabled auth is refused in production unless explicitly allowed', async () => {
  const configPath = await writeConfig(basicConfig);
  await assert.rejects(
    () => createApp({ configPath, authMode: 'disabled', nodeEnv: 'production', allowDisabledAuth: false }),
    /disabled auth/i
  );
});

test('GET /api/status probes configured targets and hides target URLs', async () => {
  const probe = await listen((_request, response) => {
    response.writeHead(204).end();
  });
  const configPath = await writeConfig({
    title: 'Home Dashboard',
    sections: [],
    statusChecks: [{ id: 'probe', label: 'Probe', targetUrl: `${probe.baseUrl}/ready`, displayUrl: 'https://probe.example.test' }]
  });
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, statusCacheTtlMs: 1000 });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.checks[0].id, 'probe');
    assert.equal(body.checks[0].status, 'up');
    assert.equal(JSON.stringify(body).includes(probe.baseUrl), false);
  } finally {
    await server.close();
    await probe.close();
  }
});
