/**
 * Static validation for scripts/run-critical-docker.sh.
 *
 * These tests parse the shell script as text to verify it stays in sync with
 * docker-compose.yml for every data-source bind mount. They exist because the
 * fallback is documented as the canonical deployment path on critical (which
 * lacks the Docker Compose plugin), so regressions here would silently break
 * live features on next deploy.
 *
 * Each group follows the TDD pattern: write the expectation for what must be
 * present, which catches missing lines that compile-clean shell won't catch.
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
const execFileAsync = promisify(execFile);

async function loadScript() {
  return readFile(SCRIPT_PATH, 'utf8');
}

async function loadCompose() {
  return readFile(COMPOSE_PATH, 'utf8');
}

// ---------------------------------------------------------------------------
// PERSONAL_DASHBOARD_DB_HOST_PATH variable declaration
// ---------------------------------------------------------------------------

test('run-critical-docker.sh declares PERSONAL_DASHBOARD_DB_HOST_DIR and derived DB path', async () => {
  const script = await loadScript();
  assert.match(
    script,
    /PERSONAL_DASHBOARD_DB_HOST_DIR=\$\{PERSONAL_DASHBOARD_DB_HOST_DIR:-[^}]+\}/,
    'PERSONAL_DASHBOARD_DB_HOST_DIR must be declared with a default value'
  );
  assert.match(
    script,
    /PERSONAL_DASHBOARD_DB_HOST_PATH=\$PERSONAL_DASHBOARD_DB_HOST_DIR\/personal-dashboard\.sqlite3/,
    'PERSONAL_DASHBOARD_DB_HOST_PATH must be derived from the mounted data directory'
  );
});

// ---------------------------------------------------------------------------
// Host-path prerequisite guard — must be a regular file, not just present
// ---------------------------------------------------------------------------

test('run-critical-docker.sh guards PERSONAL_DASHBOARD_DB_HOST_PATH with [ -f ] before docker run', async () => {
  const script = await loadScript();
  // Must check the variable is a regular file (not a dir) to avoid Docker
  // silently creating a directory bind when the file does not yet exist.
  assert.match(
    script,
    /!\s*-f\s*['"$]?\$\{?PERSONAL_DASHBOARD_DB_HOST_PATH\}?['"$]?/,
    '[ ! -f "$PERSONAL_DASHBOARD_DB_HOST_PATH" ] guard is required'
  );
});

// ---------------------------------------------------------------------------
// PERSONAL_DASHBOARD_DB_FILE env var must be forwarded to the container
// ---------------------------------------------------------------------------

test('run-critical-docker.sh passes PERSONAL_DASHBOARD_DB_FILE env to docker run', async () => {
  const script = await loadScript();
  // Must set PERSONAL_DASHBOARD_DB_FILE=/app/data/personal-dashboard.sqlite3
  // (the container-internal path, matching docker-compose.yml)
  assert.match(
    script,
    /-e\s+PERSONAL_DASHBOARD_DB_FILE=\/app\/data\/personal-dashboard\.sqlite3/,
    '-e PERSONAL_DASHBOARD_DB_FILE=/app/data/personal-dashboard.sqlite3 is required in docker run'
  );
});

// ---------------------------------------------------------------------------
// Writable bind mount for the personal SQLite DB
// ---------------------------------------------------------------------------

test('run-critical-docker.sh bind-mounts the personal SQLite DB directory to /app/data', async () => {
  const script = await loadScript();
  // SQLite WAL mode needs to create sidecar files next to the database, so the
  // critical fallback must mount the host directory, not only the DB file.
  assert.match(
    script,
    /--mount.*source=\$PERSONAL_DASHBOARD_DB_HOST_DIR.*target=\/app\/data/s,
    '--mount source=$PERSONAL_DASHBOARD_DB_HOST_DIR,target=/app/data is required'
  );
  assert.doesNotMatch(
    script,
    /target=\/app\/data\/personal-dashboard\.sqlite3/,
    'Do not file-bind SQLite to /app/data/personal-dashboard.sqlite3; WAL needs a writable containing directory'
  );
});

test('run-critical-docker.sh does NOT mark the personal data directory bind mount as readonly', async () => {
  const script = await loadScript();
  // Diary/Goals write to this DB and SQLite may create WAL/SHM sidecars, so the
  // mount must be writable.
  const mountLineMatch = script.match(
    /--mount[^\n]*target=\/app\/data[^\n]*/g
  );
  assert.ok(
    mountLineMatch && mountLineMatch.length > 0,
    'Expected at least one --mount line targeting /app/data'
  );
  for (const line of mountLineMatch) {
    assert.ok(
      !line.includes(',readonly') && !line.includes('readonly=true'),
      `personal data directory bind mount must not be readonly; found: ${line}`
    );
  }
});

// ---------------------------------------------------------------------------
// Read-only NAS artifacts must be copied into a host-local runtime cache before
// container start. Mounting NAS/NFS paths directly into Docker can preserve stale
// NFS handles across writer replacement/remount events even when the host path is
// readable again.
// ---------------------------------------------------------------------------

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

test('docker-compose.yml mounts host-local runtime cache for read-only artifacts and writable personal data dir', async () => {
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

  assert.match(
    compose,
    /source: \$\{PERSONAL_DASHBOARD_DB_HOST_DIR:-\/mnt\/nas\/services\/personal-dashboard\/data\}[\s\S]*?target: \/app\/data[\s\S]*?read_only: false/,
    'Compose must bind the writable personal-data directory to /app/data'
  );
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
