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

function seed(dbPath, sql) {
  execFileSync('sqlite3', [dbPath, sql]);
}

test('GET /api/epics returns 200 with an empty epics array when kanban DB is missing', async () => {
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: '/tmp/definitely-no-such-kanban.db' });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { epics: [] });
  } finally {
    await server.close();
  }
});

test('GET /api/epics returns epics with the public response shape only', async () => {
  const { dbPath, dir } = makeTempDb();
  const epicMetadata = JSON.stringify({ child_tasks: [{ id: 't_c11d03', label: 'Metadata Child' }] });
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_epic01','Epic One','domovoi','done',1748000000,'secret body do not leak');
    INSERT INTO tasks VALUES ('t_child01','Child One','kobold','done',1747900000,'child body do not leak');
    INSERT INTO tasks VALUES ('t_child02','Child Two','gremlin','running',NULL,'another body');
    INSERT INTO tasks VALUES ('t_c11d03','Metadata Child','scribe','done',1747950000,'metadata child body');
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_epic01',NULL,'decomposed',NULL,1748000000);
    INSERT INTO task_links VALUES ('t_child01','t_epic01');
    INSERT INTO task_links VALUES ('t_child02','t_epic01');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_epic01','domovoi','done',1747990000,1748000000,'completed','${epicMetadata.replace(/'/g, "''")}');
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ['epics']);
    assert.equal(body.epics.length, 1);
    const epic = body.epics[0];
    assert.deepEqual(Object.keys(epic), ['id', 'title', 'completed_at', 'subtasks', 'doc_links']);
    assert.equal(epic.id, 't_epic01');
    assert.equal(epic.title, 'Epic One');
    assert.equal(epic.completed_at, new Date(1748000000 * 1000).toISOString());
    assert.deepEqual(epic.subtasks, [
      { id: 't_child01', title: 'Child One', assignee: 'kobold', status: 'done' },
      { id: 't_child02', title: 'Child Two', assignee: 'gremlin', status: 'running' },
      { id: 't_c11d03', title: 'Metadata Child', assignee: 'scribe', status: 'done' }
    ]);
    assert.deepEqual(epic.doc_links, []);
    assert.equal(JSON.stringify(body).includes('secret body'), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/epics returns doc_links only from committed scribe child artifacts', async () => {
  const { dbPath, dir } = makeTempDb();
  const epicMeta = JSON.stringify({
    artifacts: [
      '/root/work/home-lab/README.md',
      '/root/.hermes/profiles/gremlin/secrets/nope.md',
      'relative/should-not.md'
    ],
    token: 'do-not-leak'
  });
  const scribeAssigneeMeta = JSON.stringify({
    artifacts: [
      '/root/work/home-lab/services/personal-dashboard/README.md',
      '/root/work/home-lab/tmp/uncommitted-kanban-review-proof.md',
      '/root/work/home-lab/services/personal-dashboard/README.md'
    ]
  });
  const scribeProfileMeta = JSON.stringify({
    artifacts: ['/root/work/home-lab/docs/service-catalog.md']
  });
  const nonScribeMeta = JSON.stringify({
    artifacts: ['/root/work/home-lab/docs/backup-coverage-matrix.md']
  });

  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_epic02','Epic Two','domovoi','done',1748001000,'epic body should stay private');
    INSERT INTO tasks VALUES ('t_c11d03','Doc Child','scribe','done',1747960000,'scribe body should stay private');
    INSERT INTO tasks VALUES ('t_child04','Profile Scribe Child','gremlin','done',1747961000,NULL);
    INSERT INTO tasks VALUES ('t_child05','Non Scribe Child','gremlin','done',1747962000,NULL);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_epic02',NULL,'decomposed','event-payload-should-not-leak',1748001000);
    INSERT INTO task_links VALUES ('t_c11d03','t_epic02');
    INSERT INTO task_links VALUES ('t_child04','t_epic02');
    INSERT INTO task_links VALUES ('t_child05','t_epic02');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_epic02','domovoi','done',1747990000,1748001000,'completed','${epicMeta.replace(/'/g, "''")}');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_c11d03','scribe','done',1747950000,1747960000,'completed','${scribeAssigneeMeta.replace(/'/g, "''")}');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_child04','scribe','done',1747951000,1747961000,'completed','${scribeProfileMeta.replace(/'/g, "''")}');
    INSERT INTO task_runs(task_id,profile,status,started_at,ended_at,outcome,metadata) VALUES ('t_child05','gremlin','done',1747952000,1747962000,'completed','${nonScribeMeta.replace(/'/g, "''")}');
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.deepEqual(body.epics[0].doc_links, [
      { label: 'README.md', url: 'https://github.com/LimbicNode42/home-lab/blob/master/services/personal-dashboard/README.md' },
      { label: 'service-catalog.md', url: 'https://github.com/LimbicNode42/home-lab/blob/master/docs/service-catalog.md' }
    ]);
    assert.equal(serialized.includes('do-not-leak'), false);
    assert.equal(serialized.includes('event-payload-should-not-leak'), false);
    assert.equal(serialized.includes('epic body should stay private'), false);
    assert.equal(serialized.includes('scribe body should stay private'), false);
    assert.equal(serialized.includes('backup-coverage-matrix'), false);
    assert.equal(serialized.includes('uncommitted-kanban-review-proof'), false);
    assert.equal(serialized.includes('/root/'), false);
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
  seed(dbPath, `
    INSERT INTO tasks VALUES ('t_older','Older Epic','domovoi','done',1747000000,NULL);
    INSERT INTO tasks VALUES ('t_newer','Newer Epic','domovoi','done',1748000000,NULL);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_older',NULL,'decomposed',NULL,1747000000);
    INSERT INTO task_events(task_id,run_id,kind,payload,created_at) VALUES ('t_newer',NULL,'decomposed',NULL,1748000000);
  `);

  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, kanbanDbPath: dbPath });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/epics`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.epics.map((epic) => epic.id), ['t_newer', 't_older']);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
