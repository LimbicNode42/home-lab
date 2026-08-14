import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../src/server.js';
import { createPostgresPersonalDataStore } from '../src/personal-data-store.js';
import { FakePgPool } from './fake-pg-pool.js';

const basicConfig = { title: 'Home Dashboard', sections: [], statusChecks: [] };

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  };
}

async function postJson(baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  return { response, body };
}

test('Postgres personal data store initializes diary-compatible schema durably', async () => {
  const pool = new FakePgPool();
  const store = await createPostgresPersonalDataStore({ pool });
  const entry = await store.createDiaryEntry({ entry_date: '2026-08-11', title: 'Fake test entry', body: 'Obviously fake diary fixture text.', mood: 'steady' });
  assert.match(entry.id, /^d_[0-9a-f]{24}$/);
  assert.equal(entry.entry_date, '2026-08-11');
  assert.equal(entry.title, 'Fake test entry');
  assert.equal(entry.body, 'Obviously fake diary fixture text.');
  assert.equal(entry.mood, 'steady');

  const reopened = await createPostgresPersonalDataStore({ pool });
  const entries = await reopened.listDiaryEntries({ limit: 20, offset: 0 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Fake test entry');
  assert.equal(entries[0].preview, 'Obviously fake diary fixture text.');
  const full = await reopened.getDiaryEntry(entries[0].id);
  assert.equal(full.body, 'Obviously fake diary fixture text.');
});

test('diary APIs require auth and return not-configured only after auth succeeds', async () => {
  const app = await createApp({ config: basicConfig, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user', personalDataDatabaseUrl: null, personalDataPostgresPool: null });
  const server = await listen(app);
  try {
    const unauth = await fetch(`${server.baseUrl}/api/diary/entries`);
    assert.equal(unauth.status, 401);

    const authed = await fetch(`${server.baseUrl}/api/diary/entries`, { headers: { 'x-forwarded-user': 'ben@example.invalid' } });
    assert.equal(authed.status, 503);
    assert.deepEqual(await authed.json(), {
      error: 'personal_data_not_configured',
      message: 'Personal dashboard data store is not configured'
    });
  } finally {
    await server.close();
  }
});

test('diary APIs create, list, and read fake entries from persistent Postgres storage', async () => {
  const pool = new FakePgPool();
  const app = await createApp({ config: basicConfig, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, personalDataPostgresPool: pool });
  const server = await listen(app);
  try {
    const created = await postJson(server.baseUrl, '/api/diary/entries', {
      entry_date: '2026-08-11',
      title: 'Fake test entry',
      body: 'Obviously fake diary fixture body used only by automated tests.',
      mood: 'focused'
    });
    assert.equal(created.response.status, 201);
    assert.match(created.body.entry.id, /^d_[0-9a-f]{24}$/);
    assert.equal(created.body.entry.body, 'Obviously fake diary fixture body used only by automated tests.');

    const listResponse = await fetch(`${server.baseUrl}/api/diary/entries?limit=10&offset=0`);
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.limit, 10);
    assert.equal(listBody.offset, 0);
    assert.equal(listBody.entries.length, 1);
    assert.equal(listBody.entries[0].preview, 'Obviously fake diary fixture body used only by automated tests.');
    assert.equal(Object.hasOwn(listBody.entries[0], 'body'), false);

    const viewResponse = await fetch(`${server.baseUrl}/api/diary/entries/${created.body.entry.id}`);
    const viewBody = await viewResponse.json();
    assert.equal(viewResponse.status, 200);
    assert.equal(viewBody.entry.body, 'Obviously fake diary fixture body used only by automated tests.');
  } finally {
    await server.close();
  }
});

test('diary API validates inputs without echoing personal text', async () => {
  const pool = new FakePgPool();
  const app = await createApp({ config: basicConfig, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, personalDataPostgresPool: pool });
  const server = await listen(app);
  try {
    const badBody = await postJson(server.baseUrl, '/api/diary/entries', { entry_date: '2026-08-11', body: '' });
    assert.equal(badBody.response.status, 400);
    assert.equal(badBody.body.error, 'validation_failed');

    const badDate = await postJson(server.baseUrl, '/api/diary/entries', { entry_date: '2026-99-99', body: 'fake private text should not echo' });
    assert.equal(badDate.response.status, 400);
    assert.equal(badDate.body.error, 'validation_failed');
    assert.equal(JSON.stringify(badDate.body).includes('fake private text'), false);

    const unknownGoals = await postJson(server.baseUrl, '/api/diary/entries', { entry_date: '2026-08-11', body: 'fake fixture text', goal_ids: ['g_deadbeef'] });
    assert.equal(unknownGoals.response.status, 400);
    assert.equal(unknownGoals.body.error, 'invalid_goal_ids');
  } finally {
    await server.close();
  }
});

test('diary API sanitizes Postgres storage errors', async () => {
  const app = await createApp({ config: basicConfig, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, personalDataPostgresPool: new FakePgPool({ failConnect: true }) });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/diary/entries`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'personal_data_unavailable');
    assert.equal(JSON.stringify(body).includes('/tmp/private/database'), false);
    assert.equal(JSON.stringify(body).includes('FAKE_PG_UNAVAILABLE'), false);
  } finally {
    await server.close();
  }
});
