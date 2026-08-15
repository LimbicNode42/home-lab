/**
 * Static validation for scripts/run-critical-docker.sh.
 *
 * These tests parse the shell script as text to verify it stays in sync with
 * docker-compose.yml for every data-source bind mount and secret-shaped runtime
 * input. The fallback is documented as the canonical deployment path on critical
 * while Docker Compose is unavailable there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'run-critical-docker.sh');
const SYNC_SCRIPT_PATH = join(__dirname, '..', 'scripts', 'sync-runtime-snapshots.sh');
const COMPOSE_PATH = join(__dirname, '..', 'docker-compose.yml');
const POSTGRES_COMPOSE_PATH = join(__dirname, '..', '..', 'postgres', 'docker-compose.yml');
const execFileAsync = promisify(execFile);

async function loadScript() {
  return readFile(SCRIPT_PATH, 'utf8');
}

async function loadCompose() {
  return readFile(COMPOSE_PATH, 'utf8');
}

async function loadPostgresCompose() {
  return readFile(POSTGRES_COMPOSE_PATH, 'utf8');
}

test('run-critical-docker.sh requires PERSONAL_DASHBOARD_DATABASE_URL before docker run', async () => {
  const script = await loadScript();
  assert.match(
    script,
    /PERSONAL_DASHBOARD_DATABASE_URL:\?Render PERSONAL_DASHBOARD_DATABASE_URL from Vaultwarden/,
    'fallback script must fail fast until the Postgres connection URL is rendered from Vaultwarden'
  );
});

test('run-critical-docker.sh manages the stable internal Postgres network before recreating the dashboard', async () => {
  const script = await loadScript();

  assert.match(
    script,
    /DB_NETWORK=\$\{PERSONAL_DASHBOARD_DB_NETWORK:-critical-internal\}/,
    'fallback script must default the shared DB network to critical-internal'
  );
  assert.match(
    script,
    /DB_NETWORK_ALIAS=\$\{PERSONAL_DASHBOARD_DB_ALIAS:-postgres\}/,
    'fallback script must default the Postgres alias to postgres'
  );
  assert.match(script, /docker network inspect "\$DB_NETWORK"/, 'fallback script must check for the DB network');
  assert.match(script, /docker network create --internal "\$DB_NETWORK"/, 'fallback script must create the DB network as internal when absent');
  assert.match(script, /docker inspect postgres/, 'fallback script must verify the Postgres container exists before recreate');
  assert.match(script, /docker network connect --alias "\$DB_NETWORK_ALIAS" "\$DB_NETWORK" postgres/, 'fallback script must attach Postgres with the stable alias');
  assert.match(script, /--network bridge \\/, 'dashboard must keep bridge egress/published-port behavior for status probes and Traefik');
  assert.match(script, /docker network connect "\$DB_NETWORK" "\$CONTAINER"/, 'dashboard must also attach to the shared DB network');
});

test('run-critical-docker.sh passes Postgres env vars to docker run without embedding secret values', async () => {
  const script = await loadScript();
  assert.match(script, /-e\s+PERSONAL_DASHBOARD_DATABASE_URL\s*\\/, 'docker run must pass the caller-provided database URL env var by name');
  assert.match(script, /-e\s+PGSSLMODE=\$\{PGSSLMODE:-require\}/, 'docker run must default PGSSLMODE=require for the shared TLS Postgres service');
  assert.doesNotMatch(script, /postgres(?:ql)?:\/\//i, 'script must not embed a database URL');
});

test('run-critical-docker.sh no longer bind-mounts a writable SQLite personal data directory', async () => {
  const script = await loadScript();
  assert.doesNotMatch(script, /PERSONAL_DASHBOARD_DB_HOST_PATH/, 'fallback script should not configure the old SQLite DB file path');
  assert.doesNotMatch(script, /PERSONAL_DASHBOARD_DB_HOST_DIR/, 'fallback script should not configure the old SQLite DB directory path');
  assert.doesNotMatch(script, /target=\/app\/data/, 'fallback script should not mount a writable /app/data SQLite directory');
  assert.doesNotMatch(script, /PERSONAL_DASHBOARD_DB_FILE/, 'fallback script should not pass the old SQLite DB file env var');
});

test('run-critical-docker.sh syncs NAS artifacts into a host-local runtime cache before docker run', async () => {
  const script = await loadScript();

  assert.match(
    script,
    /PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR=\$\{PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-\/var\/lib\/personal-dashboard\/runtime-cache\}/,
    'critical fallback must declare the host-local runtime cache directory'
  );
  assert.match(
    script,
    /scripts\/sync-runtime-snapshots\.sh/,
    'critical fallback must run scripts/sync-runtime-snapshots.sh before recreating the container'
  );

  for (const [cacheSubdir, target] of [
    ['config', '/app/config'],
    ['finnick', '/app/finnick'],
    ['investment-screener', '/app/investment-screener'],
    ['kanban', '/app/kanban'],
  ]) {
    assert.match(
      script,
      new RegExp(`--mount[^\\n]*source=\\$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/${cacheSubdir}[^\\n]*target=${target}[^\\n]*readonly`),
      `Expected read-only host-local cache bind from $PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR/${cacheSubdir} to ${target}`
    );
  }

  for (const nasVariable of ['FINNICK_REPORT_HOST_DIR', 'INVESTMENT_SCREENER_HOST_DIR', 'KANBAN_DB_HOST_DIR']) {
    assert.doesNotMatch(
      script,
      new RegExp(`--mount[^\\n]*source=\\$${nasVariable}[^\\n]*target=`),
      `Do not mount NAS source $${nasVariable} directly into the dashboard container`
    );
  }
});

test('run-critical-docker.sh does not bind individual read-only artifact files', async () => {
  const script = await loadScript();
  for (const fileTarget of [
    '/app/config/dashboard.public.json',
    '/app/finnick/latest_report.txt',
    '/app/investment-screener/latest_report.txt',
    '/app/investment-screener/latest_ranked.json',
    '/app/kanban/kanban.db',
  ]) {
    assert.doesNotMatch(
      script,
      new RegExp(`--mount[^\\n]*target=${fileTarget.replaceAll('/', '\\/')}`),
      `Do not bind-mount individual file target ${fileTarget}; atomic writer replacement can stale that handle`
    );
  }
});

test('docker-compose.yml mounts host-local runtime cache for read-only artifacts and configures Postgres with no SQLite bind', async () => {
  const compose = await loadCompose();

  for (const source of [
    '${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}/config',
    '${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}/finnick',
    '${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}/investment-screener',
    '${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}/kanban',
  ]) {
    assert.match(
      compose,
      new RegExp(`source: ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?read_only: true`),
      `Expected read-only compose runtime-cache directory bind for ${source}`
    );
  }

  for (const forbiddenSource of [
    './config',
    '${FINNICK_REPORT_HOST_DIR:-/mnt/nas/services/personal-dashboard/finnick}',
    '${INVESTMENT_SCREENER_HOST_DIR:-/mnt/nas/services/personal-dashboard/investment-screener}',
    '${KANBAN_DB_HOST_DIR:-/mnt/nas/services/personal-dashboard/kanban}',
  ]) {
    assert.doesNotMatch(
      compose,
      new RegExp(`source: ${forbiddenSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?target: \/app\/(config|finnick|investment-screener|kanban)`),
      `Compose must not mount direct NAS/repo read-only source ${forbiddenSource}`
    );
  }

  for (const fileTarget of [
    '/app/config/dashboard.public.json',
    '/app/finnick/latest_report.txt',
    '/app/investment-screener/latest_report.txt',
    '/app/investment-screener/latest_ranked.json',
    '/app/kanban/kanban.db',
    '/app/data/personal-dashboard.sqlite3',
  ]) {
    assert.doesNotMatch(
      compose,
      new RegExp(`target: ${fileTarget.replaceAll('/', '\\/')}`),
      `Compose must not bind individual file target ${fileTarget}`
    );
  }

  assert.match(compose, /PERSONAL_DASHBOARD_DATABASE_URL:\s*\$\{PERSONAL_DASHBOARD_DATABASE_URL:-\}/, 'Compose must pass the Postgres database URL from the rendered environment');
  assert.match(compose, /PGSSLMODE:\s*\$\{PGSSLMODE:-require\}/, 'Compose must default PGSSLMODE=require');
  assert.match(compose, /networks:[\s\S]*?- default[\s\S]*?- critical-internal/, 'Compose must attach the dashboard to both default and stable DB networks');
  assert.match(compose, /critical-internal:[\s\S]*?name:\s*critical-internal[\s\S]*?external:\s*true/, 'Dashboard Compose must consume the shared critical-internal network');
  assert.doesNotMatch(compose, /PERSONAL_DASHBOARD_DB_HOST_DIR/, 'Compose should not configure the old SQLite directory bind');
  assert.doesNotMatch(compose, /target:\s*\/app\/data/, 'Compose should not mount a writable /app/data SQLite directory');
  assert.doesNotMatch(compose, /PERSONAL_DASHBOARD_DB_FILE/, 'Compose should not pass the old SQLite DB file env var');
});

test('Postgres Compose owns the stable internal DB network and postgres alias', async () => {
  const compose = await loadPostgresCompose();

  assert.match(compose, /container_name:\s*postgres/, 'Postgres container name remains postgres');
  assert.match(compose, /networks:[\s\S]*?critical-internal:[\s\S]*?aliases:[\s\S]*?- postgres/, 'Postgres service must attach with postgres alias');
  assert.match(compose, /critical-internal:[\s\S]*?name:\s*critical-internal[\s\S]*?internal:\s*true/, 'Postgres Compose must create the internal critical-internal network');
  assert.match(compose, /\/mnt\/nas\/services\/postgres:\/bitnami\/postgresql/, 'Postgres data mount must remain preserved');
});

test('sync-runtime-snapshots.sh copies expected source files into host-local cache layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-runtime-sync-'));
  const appDir = join(root, 'app');
  const finnickDir = join(root, 'nas', 'finnick');
  const investmentDir = join(root, 'nas', 'investment-screener');
  const kanbanDir = join(root, 'nas', 'kanban');
  const cacheDir = join(root, 'runtime-cache');

  await mkdir(join(appDir, 'config'), { recursive: true });
  await mkdir(finnickDir, { recursive: true });
  await mkdir(investmentDir, { recursive: true });
  await mkdir(kanbanDir, { recursive: true });
  await writeFile(join(appDir, 'config', 'dashboard.public.json'), '{"title":"Cache Test"}\n', 'utf8');
  await writeFile(join(finnickDir, 'latest_report.txt'), 'finnick report\n', 'utf8');
  await writeFile(join(investmentDir, 'latest_report.txt'), 'investment report\n', 'utf8');
  await writeFile(join(investmentDir, 'latest_ranked.json'), '{"candidates":[]}\n', 'utf8');
  await writeFile(join(kanbanDir, 'kanban.db'), 'sqlite snapshot bytes\n', 'utf8');

  try {
    await execFileAsync('sh', [SYNC_SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_DIR: appDir,
        FINNICK_REPORT_HOST_DIR: finnickDir,
        INVESTMENT_SCREENER_HOST_DIR: investmentDir,
        KANBAN_DB_HOST_DIR: kanbanDir,
        PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR: cacheDir
      }
    });

    assert.equal(await readFile(join(cacheDir, 'config', 'dashboard.public.json'), 'utf8'), '{"title":"Cache Test"}\n');
    assert.equal(await readFile(join(cacheDir, 'finnick', 'latest_report.txt'), 'utf8'), 'finnick report\n');
    assert.equal(await readFile(join(cacheDir, 'investment-screener', 'latest_report.txt'), 'utf8'), 'investment report\n');
    assert.equal(await readFile(join(cacheDir, 'investment-screener', 'latest_ranked.json'), 'utf8'), '{"candidates":[]}\n');
    assert.equal(await readFile(join(cacheDir, 'kanban', 'kanban.db'), 'utf8'), 'sqlite snapshot bytes\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
