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
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'run-critical-docker.sh');
const COMPOSE_PATH = join(__dirname, '..', 'docker-compose.yml');

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
// Read-only NAS artifacts must be directory-mounted, not file-mounted
// ---------------------------------------------------------------------------

test('run-critical-docker.sh directory-mounts atomically replaced read-only NAS artifacts', async () => {
  const script = await loadScript();

  for (const variableName of [
    'FINNICK_REPORT_HOST_DIR',
    'INVESTMENT_SCREENER_HOST_DIR',
    'KANBAN_DB_HOST_DIR',
  ]) {
    assert.match(
      script,
      new RegExp(`${variableName}=\\$\\{${variableName}:-[^}]+\\}`),
      `${variableName} must be declared with a default directory`
    );
  }

  for (const [sourceVariable, target] of [
    ['FINNICK_REPORT_HOST_DIR', '/app/finnick'],
    ['INVESTMENT_SCREENER_HOST_DIR', '/app/investment-screener'],
    ['KANBAN_DB_HOST_DIR', '/app/kanban'],
    ['APP_DIR/config', '/app/config'],
  ]) {
    assert.match(
      script,
      new RegExp(`--mount[^\\n]*source=\\$${sourceVariable}[^\\n]*target=${target}[^\\n]*readonly`),
      `Expected read-only directory bind from $${sourceVariable} to ${target}`
    );
  }

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

test('docker-compose.yml directory-mounts read-only NAS artifacts and writable personal data dir', async () => {
  const compose = await loadCompose();

  for (const source of [
    './config',
    '${FINNICK_REPORT_HOST_DIR:-/mnt/nas/services/personal-dashboard/finnick}',
    '${INVESTMENT_SCREENER_HOST_DIR:-/mnt/nas/services/personal-dashboard/investment-screener}',
    '${KANBAN_DB_HOST_DIR:-/mnt/nas/services/personal-dashboard/kanban}',
  ]) {
    assert.match(
      compose,
      new RegExp(`source: ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?read_only: true`),
      `Expected read-only compose directory bind for ${source}`
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
