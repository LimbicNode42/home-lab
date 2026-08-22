import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createApp } from '../src/server.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-home-lab-catalog-'));
  const path = join(dir, 'dashboard.public.json');
  await writeFile(path, JSON.stringify(config), 'utf8');
  return path;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose, reject) => server.close((err) => err ? reject(err) : resolveClose()))
  };
}

const basicConfig = {
  title: 'Home Dashboard',
  sections: [],
  statusChecks: []
};

const forbiddenCatalogLeaks = [
  '/root/',
  '/mnt/nas',
  'DATABASE_URL',
  'TOKEN=',
  'PASSWORD=',
  'http://localhost:8080',
  'keycloak.wheeler-network.com',
  'api-dev-site'
];

test('GET /api/docs advertises the curated Home Lab service catalog doc', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    repoDocsRoot: resolve(new URL('../../..', import.meta.url).pathname)
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/docs`);
    const body = await response.json();
    const catalog = body.documents.find((doc) => doc.id === 'home-lab-service-catalog');

    assert.equal(response.status, 200);
    assert.ok(catalog, 'expected Home Lab service catalog in approved docs manifest');
    assert.equal(catalog.title, 'Home Lab Service Catalog');
    assert.equal(catalog.category, 'Home Lab');
    assert.equal(catalog.path, 'services/personal-dashboard/docs/products/home-lab/service-catalog.md');
  } finally {
    await server.close();
  }
});

test('GET /api/docs/home-lab-service-catalog returns curated imported inventory without path or secret leaks', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    repoDocsRoot: resolve(new URL('../../..', import.meta.url).pathname)
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/docs/home-lab-service-catalog`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.match(body.content, /historical-import/);
    assert.match(body.content, /needs-verification/);
    assert.match(body.content, /TP-Link AX5400 Router/);
    assert.match(body.content, /Traefik/);
    assert.match(body.content, /Vaultwarden/);
    assert.match(body.content, /Grafana/);
    for (const forbidden of forbiddenCatalogLeaks) {
      assert.equal(serialized.includes(forbidden), false, `catalog response leaked ${forbidden}`);
    }
  } finally {
    await server.close();
  }
});

test('Knowledge panel copy makes the Home Lab service catalog discoverable from the browser shell', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(indexSource, /Home Lab \/ Service Catalog/);
  assert.match(indexSource, /id="docs-panel"[\s\S]*service catalog/i);
  assert.match(appSource, /home-lab-service-catalog/);
});
