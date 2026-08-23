/**
 * Tests for the homelab health report feature:
 *  - Sanitization rules (spec Section 4)
 *  - Reports tab UI: homelab-health card present, all states, refresh button
 *  - run-critical-docker.sh plumbing for homelab-health
 *  - sync-runtime-snapshots.sh copies homelab-health report
 *
 * Task: t_c6a1a9f2
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
const execFileAsync = promisify(execFile);

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

// ──────────────────────────────────────────────
// Sanitization rules (spec Section 4)
// ──────────────────────────────────────────────

// Inline reference implementation matching homelab_daily_health.sh sanitizer
function sanitize(text) {
  const SECRET_RE = /(?i:token[_-]?secret|password|passwd|api[_-]?key|secret)(\s*[:=]\s*)\S+/gi;
  const CRED_URL_RE = /https?:\/\/[^\s@]+@\S+/g;
  const SSHPASS_RE = /^(sshpass:|debug1:)/;
  const MAX_LINE_LEN = 512;

  return text.split('\n').filter(line => {
    if (SSHPASS_RE.test(line)) return false;
    if (line.length > MAX_LINE_LEN) return false;
    return true;
  }).map(line => {
    line = line.replace(
      /(?i:token[_-]?secret|password|passwd|api[_-]?key|secret)(\s*[:=]\s*)\S+/gi,
      (m, sep) => m.split(sep)[0] + sep + '[REDACTED]'
    );
    line = line.replace(CRED_URL_RE, '[REDACTED_URL]');
    return line;
  }).join('\n');
}

test('sanitization: redacts token_secret value', () => {
  const input = 'TOKEN_SECRET=abc123xyz\n';
  const out = sanitize(input);
  assert.ok(!out.includes('abc123xyz'), `expected secret value to be redacted in: ${out}`);
  assert.ok(out.includes('[REDACTED]'), `expected [REDACTED] placeholder in: ${out}`);
});

test('sanitization: redacts password= pattern case-insensitively', () => {
  const input = 'Password = hunter2\n';
  const out = sanitize(input);
  assert.ok(!out.includes('hunter2'));
  assert.ok(out.includes('[REDACTED]'));
});

test('sanitization: redacts api_key colon-separated value', () => {
  const input = 'api_key: secret123\n';
  const out = sanitize(input);
  assert.ok(!out.includes('secret123'));
  assert.ok(out.includes('[REDACTED]'));
});

test('sanitization: strips lines matching sshpass: prefix', () => {
  const input = 'sshpass: this is debug output\nnormal line\n';
  const out = sanitize(input);
  assert.ok(!out.includes('sshpass:'));
  assert.ok(out.includes('normal line'));
});

test('sanitization: strips lines matching debug1: prefix', () => {
  const input = 'debug1: SSH2_MSG_KEXINIT sent\nnormal line\n';
  const out = sanitize(input);
  assert.ok(!out.includes('debug1:'));
  assert.ok(out.includes('normal line'));
});

test('sanitization: strips lines exceeding 512 characters', () => {
  const longLine = 'x'.repeat(513);
  const input = `${longLine}\nnormal line\n`;
  const out = sanitize(input);
  assert.ok(!out.includes(longLine));
  assert.ok(out.includes('normal line'));
});

test('sanitization: redacts credential-bearing HTTPS URL', () => {
  const input = 'Connecting to https://user:password@example.com/api\n';
  const out = sanitize(input);
  assert.ok(!out.includes('user:password'));
  assert.ok(out.includes('[REDACTED_URL]'));
});

test('sanitization: preserves normal report content unchanged', () => {
  const normal = [
    'Homelab health report - 2026-08-22T22:00:29Z',
    'Summary:',
    '- Proxmox guests observed: 6',
    '- Alerts: 0',
    'Alerts:',
    '- none',
  ].join('\n');
  const out = sanitize(normal);
  assert.ok(out.includes('Homelab health report'));
  assert.ok(out.includes('Proxmox guests observed: 6'));
  assert.ok(out.includes('- none'));
});

// ──────────────────────────────────────────────
// Reports tab UI: homelab-health card structure
// ──────────────────────────────────────────────

test('Reports tab HTML contains homelab-health-panel section after finnick-panel', () => {
  assert.match(
    indexSource,
    /id="finnick-panel"[\s\S]*id="homelab-health-panel"/,
    'homelab-health-panel must follow finnick-panel in the Reports tab'
  );
});

test('Reports tab HTML contains homelab-health-content div with aria-live', () => {
  assert.match(indexSource, /id="homelab-health-content" aria-live="polite"/);
});

test('Reports tab HTML contains homelab-health-badge span', () => {
  assert.match(indexSource, /id="homelab-health-badge"/);
});

test('Reports tab HTML contains homelab-health-freshness paragraph', () => {
  assert.match(indexSource, /id="homelab-health-freshness"/);
});

test('Reports tab HTML contains refresh-homelab-health button', () => {
  assert.match(indexSource, /id="refresh-homelab-health"/);
});

test('app.js declares refreshHomelabHealth function', () => {
  assert.match(appSource, /async function refreshHomelabHealth\(\)/);
});

test('app.js calls refreshHomelabHealth on reports tab activation', () => {
  assert.match(appSource, /tabId === 'reports'[\s\S]*refreshFinnick[\s\S]*refreshHomelabHealth/);
});

test('app.js wires refresh-homelab-health button to refreshHomelabHealth', () => {
  assert.match(appSource, /refreshHomelabHealthButton[\s\S]*addEventListener.*refreshHomelabHealth/);
});

test('app.js renders 503/not_configured state message for homelab health', () => {
  assert.match(appSource, /Homelab health report is not configured on this instance/);
});

test('app.js renders 404/not_found state message for homelab health', () => {
  assert.match(appSource, /No report yet — check back after the 08:00 AEST cron runs/);
});

test('app.js renders 502/read_error state message for homelab health', () => {
  assert.match(appSource, /Unable to read homelab health report/);
});

// ──────────────────────────────────────────────
// run-critical-docker.sh plumbing
// ──────────────────────────────────────────────

test('run-critical-docker.sh declares HOMELAB_HEALTH_HOST_DIR variable with NAS default', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf8');
  assert.match(
    script,
    /HOMELAB_HEALTH_HOST_DIR=\$\{HOMELAB_HEALTH_HOST_DIR:-\/mnt\/nas\/services\/personal-dashboard\/homelab-health\}/
  );
});

test('run-critical-docker.sh has preflight check for HOMELAB_HEALTH_HOST_PATH', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf8');
  assert.match(script, /HOMELAB_HEALTH_HOST_PATH=\$HOMELAB_HEALTH_HOST_DIR\/latest_report\.txt/);
  assert.match(script, /!\s*-f\s*"\$HOMELAB_HEALTH_HOST_PATH"/);
});

test('run-critical-docker.sh passes HOMELAB_HEALTH_REPORT_FILE env var to docker run', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf8');
  assert.match(script, /-e HOMELAB_HEALTH_REPORT_FILE=\/app\/homelab-health\/latest_report\.txt/);
});

test('run-critical-docker.sh mounts homelab-health from runtime cache (not NAS directly)', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf8');
  assert.match(
    script,
    /--mount[^\n]*source=\$PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR\/homelab-health[^\n]*target=\/app\/homelab-health[^\n]*readonly/
  );
  assert.doesNotMatch(
    script,
    /--mount[^\n]*source=\$HOMELAB_HEALTH_HOST_DIR[^\n]*target=/,
    'Must not mount the NAS source directly'
  );
});

// ──────────────────────────────────────────────
// sync-runtime-snapshots.sh
// ──────────────────────────────────────────────

test('sync-runtime-snapshots.sh copies homelab-health latest_report.txt into runtime cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homelab-health-sync-'));
  const appDir = join(root, 'app');
  const finnickDir = join(root, 'nas', 'finnick');
  const investmentDir = join(root, 'nas', 'investment-screener');
  const kanbanDir = join(root, 'nas', 'kanban');
  const homelabHealthDir = join(root, 'nas', 'homelab-health');
  const cacheDir = join(root, 'runtime-cache');

  await mkdir(join(appDir, 'config'), { recursive: true });
  await mkdir(finnickDir, { recursive: true });
  await mkdir(investmentDir, { recursive: true });
  await mkdir(kanbanDir, { recursive: true });
  await mkdir(homelabHealthDir, { recursive: true });
  await writeFile(join(appDir, 'config', 'dashboard.public.json'), '{}', 'utf8');
  await writeFile(join(appDir, 'config', 'home-lab-committed-files.txt'), '', 'utf8');
  await writeFile(join(finnickDir, 'latest_report.txt'), 'finnick\n', 'utf8');
  await writeFile(join(investmentDir, 'latest_report.txt'), 'investment\n', 'utf8');
  await writeFile(join(investmentDir, 'latest_ranked.json'), '{}', 'utf8');
  await writeFile(join(kanbanDir, 'kanban.db'), 'db\n', 'utf8');
  await writeFile(join(homelabHealthDir, 'latest_report.txt'), 'Homelab health report - 2026-08-22T22:00:29Z\n', 'utf8');

  try {
    await execFileAsync('sh', [SYNC_SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_DIR: appDir,
        FINNICK_REPORT_HOST_DIR: finnickDir,
        INVESTMENT_SCREENER_HOST_DIR: investmentDir,
        KANBAN_DB_HOST_DIR: kanbanDir,
        HOMELAB_HEALTH_HOST_DIR: homelabHealthDir,
        PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR: cacheDir
      }
    });

    const cached = await readFile(join(cacheDir, 'homelab-health', 'latest_report.txt'), 'utf8');
    assert.equal(cached, 'Homelab health report - 2026-08-22T22:00:29Z\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
