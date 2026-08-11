import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { createPersonalDataStore } from '../src/personal-data-store.js';

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

async function withTempDb(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-goals-'));
  try {
    return await fn(join(dir, 'personal-dashboard.sqlite3'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('personal data store creates, lists, updates, and reopens goals durably', async () => {
  await withTempDb(async (dbFile) => {
    const store = createPersonalDataStore({ dbFile });
    let goal;
    try {
      goal = store.createGoal({
        title: 'Fake test goal',
        description: 'Obviously fake goal fixture text.',
        status: 'active',
        target_date: '2026-12-31'
      });
      assert.match(goal.id, /^g_[0-9a-f]{24}$/);
      assert.equal(goal.title, 'Fake test goal');
      assert.equal(goal.description, 'Obviously fake goal fixture text.');
      assert.equal(goal.status, 'active');
      assert.equal(goal.target_date, '2026-12-31');
      assert.equal(goal.completed_at, null);

      const updated = store.updateGoal(goal.id, { status: 'completed' });
      assert.equal(updated.status, 'completed');
      assert.match(updated.completed_at, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      store.close();
    }

    const reopened = createPersonalDataStore({ dbFile });
    try {
      const goals = reopened.listGoals({ status: 'all' });
      assert.equal(goals.length, 1);
      assert.equal(goals[0].id, goal.id);
      assert.equal(goals[0].status, 'completed');
      assert.equal(reopened.getGoal(goal.id).title, 'Fake test goal');
    } finally {
      reopened.close();
    }
  });
});

test('goal APIs require auth and return not-configured only after auth succeeds', async () => {
  const app = await createApp({ config: basicConfig, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user', personalDataDbFile: null });
  const server = await listen(app);
  try {
    const unauth = await fetch(`${server.baseUrl}/api/goals`);
    assert.equal(unauth.status, 401);

    const authed = await fetch(`${server.baseUrl}/api/goals`, { headers: { 'x-forwarded-user': 'ben@example.invalid' } });
    assert.equal(authed.status, 503);
    assert.deepEqual(await authed.json(), {
      error: 'personal_data_not_configured',
      message: 'Personal dashboard data store is not configured'
    });
  } finally {
    await server.close();
  }
});

test('goal APIs create, list, view, and update fake goals from persistent SQLite storage', async () => {
  await withTempDb(async (dbFile) => {
    const app = await createApp({ config: basicConfig, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, personalDataDbFile: dbFile });
    const server = await listen(app);
    try {
      const created = await sendJson(server.baseUrl, 'POST', '/api/goals', {
        id: 'g_browser_supplied_id_must_not_win',
        title: 'Fake test goal',
        description: 'Obviously fake goal body used only by automated tests.',
        status: 'active',
        target_date: '2026-12-31'
      });
      assert.equal(created.response.status, 201);
      assert.match(created.body.goal.id, /^g_[0-9a-f]{24}$/);
      assert.notEqual(created.body.goal.id, 'g_browser_supplied_id_must_not_win');

      const listResponse = await fetch(`${server.baseUrl}/api/goals?status=all`);
      const listBody = await listResponse.json();
      assert.equal(listResponse.status, 200);
      assert.equal(listBody.goals.length, 1);
      assert.equal(listBody.goals[0].title, 'Fake test goal');

      const viewResponse = await fetch(`${server.baseUrl}/api/goals/${created.body.goal.id}`);
      const viewBody = await viewResponse.json();
      assert.equal(viewResponse.status, 200);
      assert.equal(viewBody.goal.description, 'Obviously fake goal body used only by automated tests.');

      const updated = await sendJson(server.baseUrl, 'PATCH', `/api/goals/${created.body.goal.id}`, { status: 'paused', target_date: null });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.body.goal.status, 'paused');
      assert.equal(updated.body.goal.target_date, null);
      assert.notEqual(updated.body.goal.updated_at, created.body.goal.updated_at);
    } finally {
      await server.close();
    }
  });
});

test('goal API validates inputs without echoing personal text', async () => {
  await withTempDb(async (dbFile) => {
    const app = await createApp({ config: basicConfig, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, personalDataDbFile: dbFile });
    const server = await listen(app);
    try {
      const badTitle = await sendJson(server.baseUrl, 'POST', '/api/goals', { title: '' });
      assert.equal(badTitle.response.status, 400);
      assert.equal(badTitle.body.error, 'validation_failed');

      const privateText = 'fake private goal text should not echo';
      const badStatus = await sendJson(server.baseUrl, 'POST', '/api/goals', { title: 'Fake title', description: privateText, status: 'deleted' });
      assert.equal(badStatus.response.status, 400);
      assert.equal(badStatus.body.error, 'validation_failed');
      assert.equal(JSON.stringify(badStatus.body).includes(privateText), false);

      const badDate = await sendJson(server.baseUrl, 'PATCH', '/api/goals/g_deadbeef', { target_date: '2026-99-99' });
      assert.equal(badDate.response.status, 400);
      assert.equal(badDate.body.error, 'validation_failed');
    } finally {
      await server.close();
    }
  });
});

test('goal API sanitizes storage errors', async () => {
  const app = await createApp({ config: basicConfig, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, personalDataDbFile: tmpdir() });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/goals`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'personal_data_unavailable');
    assert.equal(JSON.stringify(body).includes(tmpdir()), false);
    assert.equal(JSON.stringify(body).includes('SQLITE'), false);
  } finally {
    await server.close();
  }
});
