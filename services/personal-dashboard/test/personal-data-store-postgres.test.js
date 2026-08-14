import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

import { createApp } from '../src/server.js';
import { createPostgresPersonalDataStore } from '../src/personal-data-store.js';
import { FakePgPool } from './fake-pg-pool.js';

const basicConfig = { title: 'Home Dashboard', sections: [], statusChecks: [] };

test('personal data store production module does not import node:sqlite', async () => {
  const source = await readFile(new URL('../src/personal-data-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:sqlite/, 'Diary/Goals personal-data storage must use Postgres, not SQLite');
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  };
}

async function sendJson(baseUrl, method, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  return { response, body };
}


test('Postgres personal data store initializes schema and saves first goal durably', async () => {
  const pool = new FakePgPool();
  const store = await createPostgresPersonalDataStore({ pool });
  try {
    const goal = await store.createGoal({
      title: 'Fake Postgres goal',
      description: 'Postgres-backed goal fixture.',
      status: 'active',
      target_date: '2026-12-31'
    });

    assert.match(goal.id, /^g_[0-9a-f]{24}$/);
    assert.equal(goal.title, 'Fake Postgres goal');
    assert.equal(goal.target_date, '2026-12-31');

    const listed = await store.listGoals({ status: 'all' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, goal.id);

    const reopened = await createPostgresPersonalDataStore({ pool });
    const readBack = await reopened.getGoal(goal.id);
    assert.equal(readBack.title, 'Fake Postgres goal');
    assert.equal(pool.shared.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS goals')), true);
  } finally {
    await store.close();
  }
});


test('goal and diary APIs use configured Postgres store without a SQLite file', async () => {
  const pool = new FakePgPool();
  const app = await createApp({
    config: basicConfig,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    personalDataPostgresPool: pool
  });
  const server = await listen(app);
  try {
    const created = await sendJson(server.baseUrl, 'POST', '/api/goals', {
      title: 'Fake API Postgres goal',
      description: 'Stored through the Postgres adapter.',
      status: 'active'
    });
    assert.equal(created.response.status, 201);
    assert.match(created.body.goal.id, /^g_[0-9a-f]{24}$/);

    const diary = await sendJson(server.baseUrl, 'POST', '/api/diary/entries', {
      entry_date: '2026-08-14',
      title: 'Fake API Postgres diary',
      body: 'Diary entry stored through the Postgres adapter.',
      goal_ids: [created.body.goal.id]
    });
    assert.equal(diary.response.status, 201);
    assert.match(diary.body.entry.id, /^d_[0-9a-f]{24}$/);

    const listed = await fetch(`${server.baseUrl}/api/goals?status=all`);
    const listedBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listedBody.goals.length, 1);
    assert.equal(listedBody.goals[0].title, 'Fake API Postgres goal');
  } finally {
    await server.close();
  }
});
