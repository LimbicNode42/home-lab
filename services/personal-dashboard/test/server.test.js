import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

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

test('GET /api/finnick/report returns 503 when finnickReportFile is not configured', async () => {
  const configPath = await writeConfig(basicConfig);
  // Pass finnickReportFile: null explicitly to override any env var set in the process environment
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, finnickReportFile: null });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/finnick/report`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'finnick_not_configured');
  } finally {
    await server.close();
  }
});

test('GET /api/finnick/report returns 404 when the report file does not exist', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    finnickReportFile: '/tmp/definitely-does-not-exist-finnick-test.txt'
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/finnick/report`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error, 'report_not_found');
  } finally {
    await server.close();
  }
});

test('GET /api/finnick/report returns 200 with trimmed report content when file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finnick-test-'));
  const reportPath = join(dir, 'latest_report.txt');
  const reportContent = '=== FINNICK TEST REPORT ===\n  Bankroll: $3,429.14\n  Win rate: 95.9%\n';
  await writeFile(reportPath, reportContent, 'utf8');

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    finnickReportFile: reportPath
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/finnick/report`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(typeof body.content === 'string');
    assert.ok(body.content.includes('FINNICK TEST REPORT'));
    assert.ok(body.content.includes('Bankroll'));
    // content is trimmed — no leading/trailing whitespace
    assert.equal(body.content, reportContent.trim());
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/finnick/report requires authentication in reverse-proxy mode', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    authMode: 'reverse-proxy',
    proxyUserHeader: 'x-forwarded-user',
    finnickReportFile: '/tmp/nonexistent.txt'
  });
  const server = await listen(app);

  try {
    const unauthResponse = await fetch(`${server.baseUrl}/api/finnick/report`);
    assert.equal(unauthResponse.status, 401);

    // With the header present, auth passes (file doesn't exist but that's a 404, not 401)
    const authResponse = await fetch(`${server.baseUrl}/api/finnick/report`, {
      headers: { 'x-forwarded-user': 'ben' }
    });
    assert.notEqual(authResponse.status, 401);
  } finally {
    await server.close();
  }
});

// ──────────────────────────────────────────────
// /api/epics tests
// ──────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';

/**
 * Create a minimal kanban.db in a temp dir for testing.
 * Returns the path to the db file.
 */
function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'epics-test-'));
  const dbPath = join(dir, 'kanban.db');
  const schema = `
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, assignee TEXT, status TEXT NOT NULL, completed_at INTEGER, body TEXT);
    CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER, kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY (parent_id, child_id));
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, profile TEXT, step_key TEXT, status TEXT NOT NULL, claim_lock TEXT, claim_expires INTEGER, worker_pid INTEGER, max_runtime_seconds INTEGER, last_heartbeat_at INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT, summary TEXT, metadata TEXT, error TEXT);
  `;
  execFileSync('sqlite3', [dbPath, schema]);
  return { dbPath, dir };
}

test('GET /api/epics returns 503 when kanbanDbPath is null', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: null });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'kanban_not_configured');
  } finally {
    await server.close();
  }
});

test('GET /api/epics returns 503 when kanban DB file does not exist', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: '/tmp/definitely-no-such-kanban.db' });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'kanban_not_configured');
  } finally {
    await server.close();
  }
});

test('GET /api/epics returns empty array when no epics exist', async () => {
  const { dbPath, dir } = makeTempDb();
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { epics: [] });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics returns epics with subtasks from task_links', async () => {
  const { dbPath, dir } = makeTempDb();

  // Seed: one epic + two child tasks linked via task_links
  execFileSync('sqlite3', [dbPath, `
    INSERT INTO tasks VALUES ('t_epic01','Epic One','domovoi','done',1748000000,NULL);
    INSERT INTO tasks VALUES ('t_child01','Child One','kobold','done',1747900000,NULL);
    INSERT INTO tasks VALUES ('t_child02','Child Two','gremlin','running',NULL,NULL);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_epic01',NULL,'decomposed',NULL,1748000000);
    INSERT INTO task_links VALUES ('t_epic01','t_child01');
    INSERT INTO task_links VALUES ('t_epic01','t_child02');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_epic01','domovoi','done',1747990000,1748000000,'completed','{}');
  `]);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.epics.length, 1);
    const epic = body.epics[0];
    assert.equal(epic.id, 't_epic01');
    assert.equal(epic.title, 'Epic One');
    assert.equal(epic.assignee, 'domovoi');
    assert.ok(epic.completedAt.startsWith('2025'));
    // body must NOT be exposed
    assert.equal(epic.body, undefined);
    assert.equal(epic.subtasks.length, 2);
    const ids = epic.subtasks.map((s) => s.id).sort();
    assert.deepEqual(ids, ['t_child01', 't_child02']);
    // subtasks must not expose body
    for (const st of epic.subtasks) {
      assert.equal(st.body, undefined);
    }
    assert.deepEqual(epic.docLinks, []);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics returns subtasks from metadata child_tasks', async () => {
  const { dbPath, dir } = makeTempDb();
  const meta = JSON.stringify({ child_tasks: ['t_aabbcc11 (map)', 't_ddeeff22 (implement)'] });

  execFileSync('sqlite3', [dbPath, `
    INSERT INTO tasks VALUES ('t_epic02','Epic Two','domovoi','done',1748001000,NULL);
    INSERT INTO tasks VALUES ('t_aabbcc11','Meta Child One','kobold','done',1747950000,NULL);
    INSERT INTO tasks VALUES ('t_ddeeff22','Meta Child Two','scribe','done',1747960000,NULL);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_epic02',NULL,'decomposed',NULL,1748001000);
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_epic02','domovoi','done',1747990000,1748001000,'completed','${meta.replace(/'/g, "''")}');
  `]);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.epics.length, 1);
    const epic = body.epics[0];
    assert.equal(epic.id, 't_epic02');
    assert.equal(epic.subtasks.length, 2);
    const ids = epic.subtasks.map((s) => s.id).sort();
    assert.deepEqual(ids, ['t_aabbcc11', 't_ddeeff22']);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics requires authentication in reverse-proxy mode', async () => {
  const { dbPath, dir } = makeTempDb();
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user', kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const unauth = await fetch(`${server.baseUrl}/api/epics`);
    assert.equal(unauth.status, 401);

    const auth = await fetch(`${server.baseUrl}/api/epics`, { headers: { 'x-forwarded-user': 'ben' } });
    assert.notEqual(auth.status, 401);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics returns completed epics in reverse-chronological order', async () => {
  const { dbPath, dir } = makeTempDb();

  // Seed two epics: newer has a higher completed_at timestamp
  execFileSync('sqlite3', [dbPath, `
    INSERT INTO tasks VALUES ('t_older','Older Epic','domovoi','done',1747000000,NULL);
    INSERT INTO tasks VALUES ('t_newer','Newer Epic','domovoi','done',1748000000,NULL);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_older',NULL,'decomposed',NULL,1747000000);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_newer',NULL,'decomposed',NULL,1748000000);
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_older','domovoi','done',1746990000,1747000000,'completed','{}');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_newer','domovoi','done',1747990000,1748000000,'completed','{}');
  `]);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.epics.length, 2);
    // Newer epic must appear first (reverse-chronological)
    assert.equal(body.epics[0].id, 't_newer');
    assert.equal(body.epics[1].id, 't_older');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
