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

async function loadScript() {
  return readFile(SCRIPT_PATH, 'utf8');
}

// ---------------------------------------------------------------------------
// PERSONAL_DASHBOARD_DB_HOST_PATH variable declaration
// ---------------------------------------------------------------------------

test('run-critical-docker.sh declares PERSONAL_DASHBOARD_DB_HOST_PATH variable with a default', async () => {
  const script = await loadScript();
  // Must define the variable and give it a default path (mirrors KANBAN_DB_HOST_PATH pattern)
  assert.match(
    script,
    /PERSONAL_DASHBOARD_DB_HOST_PATH=\$\{PERSONAL_DASHBOARD_DB_HOST_PATH:-[^}]+\}/,
    'PERSONAL_DASHBOARD_DB_HOST_PATH must be declared with a default value'
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
