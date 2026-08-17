import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../src/server.js';
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

async function sendJson(baseUrl, method, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  return { response, body };
}

function testAppOptions(pool) {
  return {
    config: basicConfig,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    personalDataPostgresPool: pool
  };
}

test('diary and goal APIs recover from initial Postgres unavailability and persist across app restart', async () => {
  const pool = new FakePgPool({ failConnect: true });
  const app = await createApp(testAppOptions(pool));
  const server = await listen(app);
  try {
    const unavailable = await fetch(`${server.baseUrl}/api/goals?status=all`);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, 'personal_data_unavailable');

    pool.failConnect = false;

    const createdGoal = await sendJson(server.baseUrl, 'POST', '/api/goals', {
      title: 'Fake recovered goal',
      description: 'Obviously fake goal persistence fixture.',
      status: 'active',
      target_date: '2026-12-31'
    });
    assert.equal(createdGoal.response.status, 201);
    assert.match(createdGoal.body.goal.id, /^g_[0-9a-f]{24}$/);

    const createdEntry = await sendJson(server.baseUrl, 'POST', '/api/diary/entries', {
      entry_date: '2026-08-17',
      title: 'Fake recovered diary entry',
      body: 'Obviously fake diary persistence fixture.',
      mood: 'steady',
      goal_ids: [createdGoal.body.goal.id]
    });
    assert.equal(createdEntry.response.status, 201);
    assert.match(createdEntry.body.entry.id, /^d_[0-9a-f]{24}$/);
  } finally {
    await server.close();
  }

  const restarted = await createApp(testAppOptions(pool));
  const restartedServer = await listen(restarted);
  try {
    const goalsResponse = await fetch(`${restartedServer.baseUrl}/api/goals?status=all`);
    const goalsBody = await goalsResponse.json();
    assert.equal(goalsResponse.status, 200);
    assert.equal(goalsBody.goals.length, 1);
    assert.equal(goalsBody.goals[0].title, 'Fake recovered goal');

    const diaryResponse = await fetch(`${restartedServer.baseUrl}/api/diary/entries?limit=20&offset=0`);
    const diaryBody = await diaryResponse.json();
    assert.equal(diaryResponse.status, 200);
    assert.equal(diaryBody.entries.length, 1);
    assert.equal(diaryBody.entries[0].title, 'Fake recovered diary entry');
    assert.deepEqual(diaryBody.entries[0].goal_ids, [goalsBody.goals[0].id]);

    const entryResponse = await fetch(`${restartedServer.baseUrl}/api/diary/entries/${diaryBody.entries[0].id}`);
    const entryBody = await entryResponse.json();
    assert.equal(entryResponse.status, 200);
    assert.equal(entryBody.entry.body, 'Obviously fake diary persistence fixture.');
    assert.equal(entryBody.entry.goals[0].title, 'Fake recovered goal');
  } finally {
    await restartedServer.close();
  }
});
