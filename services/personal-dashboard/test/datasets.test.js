import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-datasets-config-'));
  const path = join(dir, 'dashboard.public.json');
  await writeFile(path, JSON.stringify(config), 'utf8');
  return path;
}

async function writeJsonl(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-datasets-'));
  const path = join(dir, 'aseprite.jsonl');
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
  return { dir, path };
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

const basicConfig = { title: 'Home Dashboard', sections: [], statusChecks: [] };
const validRecords = [
  JSON.stringify({ source: 'aseprite-docs', instruction: 'Create a 32x32 idle sprite.', output: 'Use File > New, set 32 by 32 pixels, and enable pixel grid.' }),
  JSON.stringify({ source: 'pixel-notes', instruction: 'Export a transparent sprite sheet.', output: 'Use File > Export Sprite Sheet and choose RGBA output.' })
];

async function appWithDatasets({ lines = validRecords, registry } = {}) {
  const configPath = await writeConfig(basicConfig);
  const { dir } = await writeJsonl(lines);
  return createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    datasetsRoot: dir,
    datasetRegistry: registry ?? [
      {
        dataset_id: 'aseprite',
        display_name: 'Aseprite command pairs',
        description: 'Small source/instruction/output examples for Aseprite workflows.',
        schema_version: 'source-instruction-output/v1',
        mode: 'read-only',
        file: 'aseprite.jsonl'
      },
      { dataset_id: '../secret', display_name: 'bad', file: '../secret.jsonl' },
      { dataset_id: 'absolute', display_name: 'bad', file: '/root/secret.jsonl' }
    ]
  });
}

test('GET /api/datasets lists only allowlisted sanitized registry entries', async () => {
  const app = await appWithDatasets();
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/datasets`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.datasets.length, 1);
    assert.equal(body.datasets[0].dataset_id, 'aseprite');
    assert.equal(body.datasets[0].record_count, 2);
    assert.equal(body.datasets[0].mode, 'read-only');
    assert.equal(body.storage, 'committed fixture');
    for (const forbidden of ['/root', '/tmp', '.jsonl', '../secret', 'absolute']) {
      assert.equal(serialized.includes(forbidden), false, `dataset list leaked ${forbidden}`);
    }
  } finally {
    await server.close();
  }
});

test('GET /api/datasets/:dataset_id/records reads paginated valid source/instruction/output records', async () => {
  const app = await appWithDatasets();
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/datasets/aseprite/records?limit=1&offset=1`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.dataset.dataset_id, 'aseprite');
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].line_number, 2);
    assert.equal(body.records[0].source, 'pixel-notes');
    assert.match(body.records[0].instruction, /Export/);
    assert.deepEqual(body.pagination, { limit: 1, offset: 1, total: 2, next_offset: null, previous_offset: 0 });
  } finally {
    await server.close();
  }
});

test('dataset record API rejects traversal, unknown ids, invalid pagination, and append attempts safely', async () => {
  const app = await appWithDatasets();
  const server = await listen(app);

  try {
    const traversal = await fetch(`${server.baseUrl}/api/datasets/..%2Fsecret/records`);
    const unknown = await fetch(`${server.baseUrl}/api/datasets/not-registered/records`);
    const invalidPage = await fetch(`${server.baseUrl}/api/datasets/aseprite/records?limit=1000`);
    const append = await fetch(`${server.baseUrl}/api/datasets/aseprite/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'x', instruction: 'y', output: 'z' })
    });
    const appendBody = await append.json();

    assert.equal(traversal.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(invalidPage.status, 400);
    assert.equal(append.status, 405);
    assert.equal(appendBody.error, 'dataset_append_disabled');
  } finally {
    await server.close();
  }
});

test('dataset JSONL validation reports malformed or unsafe records without leaking paths or raw payloads', async () => {
  const app = await appWithDatasets({
    lines: [
      validRecords[0],
      '{bad json',
      JSON.stringify({ source: '/root/private', instruction: 'steal', output: 'nope' }),
      JSON.stringify({ source: 'ok', instruction: '', output: 'missing instruction' })
    ]
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/datasets/aseprite/records`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 422);
    assert.equal(body.error, 'invalid_dataset_jsonl');
    assert.equal(body.invalid_line_count, 3);
    for (const forbidden of ['/root', 'bad json', 'steal', 'missing instruction']) {
      assert.equal(serialized.includes(forbidden), false, `invalid JSONL response leaked ${forbidden}`);
    }
  } finally {
    await server.close();
  }
});

test('dataset API remains behind dashboard API auth when reverse proxy auth is enabled', async () => {
  const configPath = await writeConfig(basicConfig);
  const { dir } = await writeJsonl(validRecords);
  const app = await createApp({
    configPath,
    datasetsRoot: dir,
    datasetRegistry: [{ dataset_id: 'aseprite', display_name: 'Aseprite command pairs', description: 'Examples.', schema_version: 'source-instruction-output/v1', mode: 'read-only', file: 'aseprite.jsonl' }],
    authMode: 'reverse-proxy',
    proxyUserHeader: 'x-forwarded-user'
  });
  const server = await listen(app);

  try {
    const unauthorized = await fetch(`${server.baseUrl}/api/datasets`);
    const authorized = await fetch(`${server.baseUrl}/api/datasets`, { headers: { 'x-forwarded-user': 'ben' } });

    assert.equal(unauthorized.status, 401);
    assert.equal(authorized.status, 200);
  } finally {
    await server.close();
  }
});

test('Knowledge panel exposes a read-only Dataset Curation workbench with no raw filename or innerHTML use', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const dockerfileSource = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');

  assert.match(indexSource, /id="datasets-panel"/);
  assert.match(indexSource, /Dataset Curation/);
  assert.match(indexSource, /read-only/i);
  assert.match(appSource, /const datasetsList = document\.querySelector\('#datasets-list'\)/);
  assert.match(appSource, /\/api\/datasets/);
  assert.match(appSource, /append\/create are deferred/i);
  assert.match(dockerfileSource, /COPY datasets \.\/datasets/);
  assert.doesNotMatch(appSource, /fileName/i);
  assert.doesNotMatch(appSource, /datasets[\s\S]{0,120}innerHTML\s*=/i);
});
