import { accessSync, constants, createReadStream, readFileSync } from 'node:fs';
import { chmod, mkdir, lstat, readFile, rename, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { basename, delimiter, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadConfig, toPublicConfig } from './config.js';
import { buildInvestmentScreenerDuckDbSummary, readInvestmentScreenerCompanyDetail, readLatestInvestmentScreenerManifest } from './investment-screener-storage.js';
import { createPostgresPersonalDataStore } from './personal-data-store.js';
import { StatusService } from './status.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
}

function text(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(payload);
}

function isAuthorized(request, { authMode, proxyUserHeader }) {
  if (authMode === 'disabled') {
    return true;
  }
  if (authMode === 'reverse-proxy') {
    const value = request.headers[proxyUserHeader.toLowerCase()];
    return typeof value === 'string' && value.trim() !== '';
  }
  return false;
}

function assertSafeAuth({ authMode, nodeEnv, allowDisabledAuth }) {
  if (!['reverse-proxy', 'disabled'].includes(authMode)) {
    throw new Error(`Unsupported DASHBOARD_AUTH_MODE: ${authMode}`);
  }
  if (authMode === 'disabled' && nodeEnv === 'production' && !allowDisabledAuth) {
    throw new Error('Refusing to start with disabled auth in production unless DASHBOARD_ALLOW_DISABLED_AUTH=true');
  }
}


const MOBILE_VIEWER_PREFIX = '/mobile-viewer';

function readOptionalSecretFile(path) {
  if (!path) return null;
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function normalizeMobileViewerPath(url) {
  if (url.pathname === MOBILE_VIEWER_PREFIX || url.pathname === `${MOBILE_VIEWER_PREFIX}/`) {
    return '/vnc.html?autoconnect=1&resize=scale&path=mobile-viewer/websockify';
  }
  const strippedPath = url.pathname.slice(MOBILE_VIEWER_PREFIX.length) || '/';
  const upstreamPath = strippedPath.startsWith('/') ? strippedPath : `/${strippedPath}`;
  if (upstreamPath === '/vnc.html' && !url.searchParams.has('path')) {
    const params = new URLSearchParams(url.searchParams);
    params.set('path', 'mobile-viewer/websockify');
    params.set('resize', params.get('resize') ?? 'scale');
    return `${upstreamPath}?${params.toString()}`;
  }
  return `${upstreamPath}${url.search}`;
}

function proxyMobileViewerHttp(request, response, { authMode, proxyUserHeader, upstreamUrl }) {
  if (!isAuthorized(request, { authMode, proxyUserHeader })) {
    return text(response, 401, 'Unauthorized');
  }
  if (!upstreamUrl) {
    return text(response, 503, 'Mobile viewer proxy is not configured');
  }

  const requestUrl = new URL(request.url, 'http://dashboard.local');
  const upstream = new URL(normalizeMobileViewerPath(requestUrl), upstreamUrl);
  const upstreamRequest = http.request(upstream, {
    method: request.method,
    headers: {
      accept: request.headers.accept ?? '*/*',
      'user-agent': request.headers['user-agent'] ?? 'personal-dashboard-mobile-viewer-proxy'
    },
    timeout: 5000
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers, 'cache-control': 'no-store' };
    delete headers['content-security-policy'];
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('mobile viewer upstream timeout')));
  upstreamRequest.on('error', () => text(response, 502, 'Mobile viewer upstream is unavailable'));
  request.pipe(upstreamRequest);
}

function handleMobileViewerUpgrade(request, socket, head, { authMode, proxyUserHeader, upstreamUrl, token }) {
  if (!isAuthorized(request, { authMode, proxyUserHeader })) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!upstreamUrl || !token) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const requestUrl = new URL(request.url, 'http://dashboard.local');
  if (requestUrl.pathname !== `${MOBILE_VIEWER_PREFIX}/websockify`) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstream = new URL(`/websockify?token=${encodeURIComponent(token)}`, upstreamUrl);
  const upgradeHeaders = {
    connection: 'Upgrade',
    upgrade: request.headers.upgrade ?? 'websocket',
    'sec-websocket-key': request.headers['sec-websocket-key'],
    'sec-websocket-version': request.headers['sec-websocket-version'],
    'sec-websocket-protocol': request.headers['sec-websocket-protocol'],
    origin: request.headers.origin
  };
  for (const [key, value] of Object.entries(upgradeHeaders)) {
    if (value === undefined) delete upgradeHeaders[key];
  }
  const upstreamRequest = http.request(upstream, {
    method: 'GET',
    headers: upgradeHeaders
  });

  upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n');
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) socket.write(`${key}: ${item}\r\n`);
      } else if (value !== undefined) {
        socket.write(`${key}: ${value}\r\n`);
      }
    }
    socket.write('\r\n');
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamRequest.on('response', (upstreamResponse) => {
    socket.write(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} Upstream rejected upgrade\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    upstreamResponse.resume();
  });
  upstreamRequest.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  upstreamRequest.end();
}

async function serveStatic(request, response) {
  const url = new URL(request.url, 'http://dashboard.local');
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = resolve(publicDir, `.${normalize(requestedPath)}`);
  if (candidate !== publicDir && !candidate.startsWith(`${publicDir}${sep}`)) {
    return text(response, 403, 'Forbidden');
  }

  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return text(response, 404, 'Not found');
    }
    response.writeHead(200, {
      'content-type': MIME_TYPES[extname(candidate)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store'
    });
    createReadStream(candidate).pipe(response);
  } catch {
    const fallback = join(publicDir, 'index.html');
    const info = await stat(fallback);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': info.size,
      'cache-control': 'no-store'
    });
    createReadStream(fallback).pipe(response);
  }
}

const HOME_LAB_ROOT = '/root/work/home-lab';
const DEFAULT_REPO_DOCS_ROOT = HOME_LAB_ROOT;
const GITHUB_BASE = 'https://github.com/LimbicNode42/home-lab/blob/master';
const DEFAULT_DOCS_MANIFEST = [
  { id: 'dashboard-readme', title: 'Personal Dashboard README', category: 'Dashboard', path: 'services/personal-dashboard/README.md' },
  { id: 'dashboard-overview', title: 'Dashboard Overview', category: 'Dashboard', path: 'services/personal-dashboard/docs/products/dashboard/overview.md' },
  { id: 'dashboard-documentation-panel', title: 'Documentation Panel Guide', category: 'Dashboard', path: 'services/personal-dashboard/docs/products/dashboard/documentation-panel.md' },
  { id: 'home-lab-service-catalog', title: 'Home Lab Service Catalog', category: 'Home Lab', path: 'services/personal-dashboard/docs/products/home-lab/service-catalog.md' },
  { id: 'blog-drafts-guide', title: 'Blog / Drafts Guide', category: 'Blog / Drafts', path: 'services/personal-dashboard/docs/products/blog-drafts/README.md' },
  { id: 'reports-homelab-health', title: 'Homelab Health Report Guide', category: 'Reports', path: 'services/personal-dashboard/docs/products/reports/homelab-health.md' },
  { id: 'reports-finnick', title: 'Finnick Report Guide', category: 'Reports', path: 'services/personal-dashboard/docs/products/reports/finnick.md' },
  { id: 'diary-goals-guide', title: 'Diary & Goals Guide', category: 'Diary & Goals', path: 'services/personal-dashboard/docs/products/diary-goals/README.md' },
  { id: 'investment-screener-overview', title: 'Investment Screener Product Guide', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/README.md' },
  { id: 'investment-screener-cli-generator', title: 'Investment Screener CLI and Generator', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/cli-generator.md' },
  { id: 'investment-screener-dashboard-panel', title: 'Investment Screener Dashboard Panel', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/dashboard-panel.md' },
  { id: 'investment-screener-interpreting-results', title: 'Interpreting Investment Screener Results', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/interpreting-results.md' },
  { id: 'investment-screener-historical-pipeline', title: 'ASX Screener Historical Pipeline Architecture', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/historical-pipeline-architecture.md' },
  { id: 'investment-screener-operations-limitations', title: 'Investment Screener Operations and Limitations', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/operations-limitations.md' },
  { id: 'investment-screener-data-source-coverage', title: 'Investment Screener Data Source and Coverage', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/data-source-coverage.md' },
  { id: 'service-catalog', title: 'Service Catalog', category: 'Operations', path: 'docs/service-catalog.md' },
  { id: 'backup-coverage', title: 'Backup Coverage Matrix', category: 'Operations', path: 'docs/backup-coverage-matrix.md' }
];
const DEFAULT_EPIC_DOCS_INDEX = resolve(__dirname, '..', 'docs', 'epics', 'index.json');
const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DOC_CONTENT_MAX_BYTES = 192 * 1024;
const RUNTIME_DOC_FORBIDDEN_PATTERNS = [
  /\bDATABASE_URL\b/i,
  /\bpostgres(?:ql)?:\/\//i,
  /\b(raw\s+)?sql\b/i,
  /\/root(?:\/|\b)/i,
  /\/mnt\/nas(?:\/|\b)/i,
  /\/app(?:\/|\b)/i,
  /\/tmp(?:\/|\b)/i,
  /\bkanban\.db\b/i,
  /\bstderr\b/i,
  /\bdiagnostics?\b/i,
  /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*[:=]\s*(?:["'][^"']{4,}["']|[^\s"']{4,})/i,
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._-]{8,}/i
];
// Build/deploy trust boundary: this manifest is generated from `git ls-files` in
// the home-lab repo and copied into the container. If it is absent in development,
// fall back to a local git check against HOME_LAB_ROOT.
const COMMITTED_PATHS_FILE = resolve(__dirname, '..', 'config', 'home-lab-committed-files.txt');
let committedPathSet;

function getCommittedPathSet() {
  if (committedPathSet !== undefined) return committedPathSet;
  try {
    const content = readFileSync(process.env.HOME_LAB_COMMITTED_PATHS_FILE ?? COMMITTED_PATHS_FILE, 'utf8');
    committedPathSet = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch {
    committedPathSet = null;
  }
  return committedPathSet;
}

/**
 * Resolve the kanban DB path from an option or environment variable.
 * Expands leading ~ to the user home directory.
 */
function resolveKanbanDbPath(kanbanDbPath) {
  const raw = kanbanDbPath ?? process.env.KANBAN_DB_PATH ?? '~/.hermes/kanban.db';
  if (raw.startsWith('~/') || raw === '~') {
    const home = process.env.HOME ?? homedir();
    return join(home, raw.slice(1));
  }
  return raw;
}

/**
 * Escape a string literal for SQLite. Task ids are internal, but keeping shell-out SQL
 * boringly quoted is cheaper than explaining the incident later.
 */
function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Query the kanban SQLite DB in-process. The container runs as USER node and may
 * not be able to spawn host-installed sqlite3 binaries, so runtime DB reads must
 * not depend on a subprocess.
 */
function queryKanbanDb(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const KANBAN_BOARD_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'scheduled', 'review', 'done'];
const KANBAN_SAFE_MOVE_STATUSES = ['ready', 'blocked', 'done', 'archived'];
const TASK_ID_PATTERN = /^t_[0-9a-f]+$/;
const MAX_MOVE_BODY_BYTES = 8 * 1024;
const MAX_DIARY_BODY_BYTES = 40 * 1024;
const MAX_GOAL_BODY_BYTES = 16 * 1024;
const MAX_WRITING_BODY_BYTES = 48 * 1024;

function personalDataNotConfiguredPayload() {
  return {
    error: 'personal_data_not_configured',
    message: 'Personal dashboard data store is not configured'
  };
}

function personalDataUnavailablePayload() {
  return {
    error: 'personal_data_unavailable',
    message: 'Personal dashboard data store is unavailable. Check server logs and runtime storage configuration.'
  };
}

function safePublicDiaryError(err) {
  if (err?.code === 'invalid_goal_ids') {
    return { statusCode: 400, payload: { error: 'invalid_goal_ids', message: 'One or more linked goals are invalid' } };
  }
  if (err?.code === 'validation_failed') {
    return { statusCode: 400, payload: { error: 'validation_failed', message: 'Diary entry validation failed' } };
  }
  if (err?.code === 'unsupported_media_type') {
    return { statusCode: 415, payload: { error: 'unsupported_media_type', message: 'Expected application/json request body' } };
  }
  if (err?.code === 'request_body_too_large') {
    return { statusCode: 413, payload: { error: 'request_body_too_large', message: 'Request body is too large' } };
  }
  if (err?.code === 'invalid_json') {
    return { statusCode: 400, payload: { error: 'invalid_request_body', message: 'Invalid JSON request body' } };
  }
  return { statusCode: 503, payload: personalDataUnavailablePayload() };
}

function safePublicGoalError(err) {
  if (err?.code === 'validation_failed') {
    return { statusCode: 400, payload: { error: 'validation_failed', message: 'Goal validation failed' } };
  }
  if (err?.code === 'unsupported_media_type') {
    return { statusCode: 415, payload: { error: 'unsupported_media_type', message: 'Expected application/json request body' } };
  }
  if (err?.code === 'request_body_too_large') {
    return { statusCode: 413, payload: { error: 'request_body_too_large', message: 'Request body is too large' } };
  }
  if (err?.code === 'invalid_json') {
    return { statusCode: 400, payload: { error: 'invalid_request_body', message: 'Invalid JSON request body' } };
  }
  return { statusCode: 503, payload: personalDataUnavailablePayload() };
}

function parseGoalListParams(searchParams) {
  const status = searchParams.get('status') ?? 'all';
  if (!['all', 'active', 'paused', 'completed', 'archived'].includes(status)) {
    const error = new Error('Invalid goal status filter');
    error.code = 'validation_failed';
    throw error;
  }
  return { status };
}

function parseDiaryListParams(searchParams) {
  const limit = searchParams.get('limit') ?? '20';
  const offset = searchParams.get('offset') ?? '0';
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    const error = new Error('Invalid diary pagination');
    error.code = 'validation_failed';
    throw error;
  }
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 10000) {
    const error = new Error('Invalid diary pagination');
    error.code = 'validation_failed';
    throw error;
  }
  return { limit: parsedLimit, offset: parsedOffset };
}

function createPersonalDataState({ postgresConnectionString, postgresPool, postgresSsl } = {}) {
  const configured = Boolean(postgresConnectionString || postgresPool);
  let store = null;
  let initializing = null;

  async function initialize() {
    if (!configured) return null;
    if (store) return store;
    if (!initializing) {
      initializing = createPostgresPersonalDataStore({ connectionString: postgresConnectionString, pool: postgresPool, ssl: postgresSsl })
        .then((createdStore) => {
          store = createdStore;
          return store;
        })
        .catch((err) => {
          if (typeof console?.warn === 'function') {
            console.warn('Personal dashboard Postgres data store unavailable', { code: err?.code, name: err?.name });
          }
          throw err;
        })
        .finally(() => {
          initializing = null;
        });
    }
    return initializing;
  }

  return {
    configured,
    async getStore() {
      if (!configured) return { store: null, unavailable: false, configured };
      try {
        return { store: await initialize(), unavailable: false, configured };
      } catch {
        return { store: null, unavailable: true, configured };
      }
    }
  };
}

function isoFromUnixSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp * 1000).toISOString();
}

function emptyKanbanLanes() {
  return KANBAN_BOARD_STATUSES.map((status) => ({ status, cards: [] }));
}

function kanbanDbUnavailablePayload(extra = {}) {
  return {
    error: 'kanban_db_unavailable',
    message: 'Kanban database is unavailable to the dashboard runtime. Check the read-only container bind mount and server logs for details.',
    ...extra
  };
}

function buildKanbanBoard(rows) {
  const lanes = emptyKanbanLanes();
  const laneByStatus = new Map(lanes.map((lane) => [lane.status, lane]));
  for (const row of rows) {
    const lane = laneByStatus.get(row.status);
    if (!lane) continue;
    lane.cards.push({
      id: row.id,
      title: row.title,
      assignee: row.assignee ?? null,
      status: row.status,
      priority: Number(row.priority ?? 0),
      created_at: isoFromUnixSeconds(row.created_at),
      started_at: isoFromUnixSeconds(row.started_at),
      completed_at: isoFromUnixSeconds(row.completed_at),
      parent_count: Number(row.parent_count ?? 0),
      child_count: Number(row.child_count ?? 0)
    });
  }
  return lanes;
}

function getKanbanBoard(dbPath) {
  const statusesClause = KANBAN_BOARD_STATUSES.map(sqlString).join(',');
  const rows = queryKanbanDb(
    dbPath,
    `SELECT
       t.id,
       t.title,
       t.assignee,
       t.status,
       COALESCE(t.priority, 0) AS priority,
       t.created_at,
       t.started_at,
       t.completed_at,
       COALESCE((SELECT COUNT(*) FROM task_links tl WHERE tl.parent_id = t.id), 0) AS parent_count,
       COALESCE((SELECT COUNT(*) FROM task_links tl WHERE tl.child_id = t.id), 0) AS child_count
     FROM tasks t
     WHERE t.status IN (${statusesClause})
     ORDER BY
       CASE t.status
         WHEN 'triage' THEN 1
         WHEN 'todo' THEN 2
         WHEN 'ready' THEN 3
         WHEN 'running' THEN 4
         WHEN 'blocked' THEN 5
         WHEN 'scheduled' THEN 6
         WHEN 'review' THEN 7
         WHEN 'done' THEN 8
         ELSE 99
       END,
       COALESCE(t.priority, 0) DESC,
       t.created_at DESC,
       t.id ASC`
  );
  return buildKanbanBoard(rows);
}

async function readJsonBody(request, maxBytes = MAX_MOVE_BODY_BYTES) {
  const contentType = request.headers['content-type'] ?? '';
  if (!String(contentType).toLowerCase().includes('application/json')) {
    const error = new Error('Expected application/json request body');
    error.statusCode = 415;
    error.code = 'unsupported_media_type';
    throw error;
  }

  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      error.code = 'request_body_too_large';
      throw error;
    }
  }

  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object');
    }
    return parsed;
  } catch {
    const error = new Error('Invalid JSON request body');
    error.statusCode = 400;
    error.code = 'invalid_json';
    throw error;
  }
}

function textField(value, fallback, maxLength = 500) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function commandForKanbanMove(taskId, body) {
  const status = body.status;
  if (!KANBAN_SAFE_MOVE_STATUSES.includes(status)) {
    return { error: 'unsupported_transition', statusCode: 409, message: `Moving Kanban tasks to ${status ?? 'unknown'} is not supported by the dashboard API` };
  }
  if (status === 'archived' && body.confirm !== true) {
    return { error: 'confirmation_required', statusCode: 409, message: 'Archiving requires confirm: true' };
  }

  if (status === 'ready') {
    return { args: ['kanban', 'promote', taskId, textField(body.reason, 'Promoted from dashboard')] };
  }
  if (status === 'blocked') {
    return { args: ['kanban', 'block', taskId, textField(body.reason, 'Blocked from dashboard')] };
  }
  if (status === 'done') {
    return { args: ['kanban', 'complete', taskId, '--summary', textField(body.summary ?? body.reason, 'Completed from dashboard')] };
  }
  return { args: ['kanban', 'archive', taskId] };
}

function runKanbanCommand(commandPath, args) {
  execFileSync(commandPath, args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function parseKanbanCommandHealthArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.trim() === '') return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(/\s+/);
}

function hasPathSeparator(commandPath) {
  return commandPath.includes('/') || (process.platform === 'win32' && commandPath.includes('\\'));
}

function isExecutableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isCommandExecutable(commandPath) {
  if (typeof commandPath !== 'string' || commandPath.trim() === '') return false;
  if (hasPathSeparator(commandPath)) return isExecutableFile(commandPath);

  const pathValue = process.env.PATH ?? '';
  if (!pathValue) return false;
  return pathValue.split(delimiter).some((dir) => dir && isExecutableFile(join(dir, commandPath)));
}

function logKanbanMutationDiagnostic(reason, err) {
  if (typeof console?.warn !== 'function') return;
  const diagnostic = { reason };
  if (err && typeof err === 'object') {
    diagnostic.code = err.code;
    diagnostic.status = err.status;
    diagnostic.signal = err.signal;
  }
  console.warn('Kanban mutation command unavailable', diagnostic);
}

function kanbanMutationAvailability({ requested, commandPath, healthArgs }) {
  if (!requested) return { enabled: false, error: 'kanban_mutations_disabled' };
  if (!isCommandExecutable(commandPath)) {
    logKanbanMutationDiagnostic('command_not_executable');
    return { enabled: false, error: 'kanban_mutations_unavailable' };
  }

  if (healthArgs.length === 0) {
    logKanbanMutationDiagnostic('health_check_not_configured');
    return { enabled: false, error: 'kanban_mutations_unavailable' };
  }

  try {
    runKanbanCommand(commandPath, healthArgs);
  } catch (err) {
    logKanbanMutationDiagnostic('health_check_failed', err);
    return { enabled: false, error: 'kanban_mutations_unavailable' };
  }

  return { enabled: true, error: null };
}

function parseMetadata(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse a child_tasks entry like "t_28e723be (map)" and return just the task id.
 */
function parseChildTaskId(entry) {
  if (entry && typeof entry === 'object') {
    const id = entry.id ?? entry.task_id ?? entry.taskId;
    if (typeof id === 'string' && /^t_[0-9a-f]+$/.test(id)) return id;
  }
  const match = /^(t_[0-9a-f]+)/.exec(String(entry).trim());
  return match ? match[1] : null;
}

function metadataChildTaskIds(metadataRows) {
  const ids = [];
  for (const row of metadataRows) {
    const metadata = parseMetadata(row.metadata);
    const childTasks = Array.isArray(metadata.child_tasks) ? metadata.child_tasks : [];
    for (const childTask of childTasks) {
      const id = parseChildTaskId(childTask);
      if (id) ids.push(id);
    }
  }
  return ids;
}

function metadataTaskGraphIds(metadataRows) {
  const ids = [];
  for (const row of metadataRows) {
    const metadata = parseMetadata(row.metadata);
    if (!metadata.task_graph || typeof metadata.task_graph !== 'object' || Array.isArray(metadata.task_graph)) continue;
    for (const [taskId, node] of Object.entries(metadata.task_graph)) {
      if (TASK_ID_PATTERN.test(taskId)) ids.push(taskId);
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const parents = Array.isArray(node.parents) ? node.parents : [];
      for (const parent of parents) {
        if (typeof parent === 'string' && TASK_ID_PATTERN.test(parent)) ids.push(parent);
      }
    }
  }
  return ids;
}

function metadataHasTaskGraph(metadataRows) {
  return metadataRows.some((row) => {
    const metadata = parseMetadata(row.metadata);
    return metadata.task_graph && typeof metadata.task_graph === 'object' && !Array.isArray(metadata.task_graph);
  });
}

function uniqueTaskIds(ids, excludeId = null) {
  const seen = new Set();
  const unique = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    if (excludeId && id === excludeId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function metadataArtifacts(metadataRows) {
  const artifacts = [];
  for (const row of metadataRows) {
    const metadata = parseMetadata(row.metadata);
    if (!Array.isArray(metadata.artifacts)) continue;
    for (const artifact of metadata.artifacts) {
      if (typeof artifact === 'string') artifacts.push(artifact);
    }
  }
  return artifacts;
}

function isScribeTask(task, metadataRow) {
  return task.assignee === 'scribe' || metadataRow.profile === 'scribe';
}

function scribeMetadataArtifacts(task, metadataRows) {
  const artifacts = [];
  for (const row of metadataRows) {
    if (!isScribeTask(task, row)) continue;
    artifacts.push(...metadataArtifacts([row]));
  }
  return artifacts;
}

/**
 * Return true only for repo paths that are present in HEAD. The API maps artifacts
 * to public GitHub blob URLs, so repo-prefix alone is not enough; uncommitted local
 * scratch files must not become convincing-looking links.
 */
function isCommittedHomeLabPath(relativePath) {
  const committedPaths = getCommittedPathSet();
  if (committedPaths) return committedPaths.has(relativePath);

  try {
    execFileSync('git', ['-C', HOME_LAB_ROOT, 'cat-file', '-e', `HEAD:${relativePath}`], {
      stdio: 'ignore',
      timeout: 5000
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Given a list of artifact paths from metadata, filter to committed files under
 * HOME_LAB_ROOT and map them to { label, url } objects. The response never exposes
 * the local filesystem path, only the GitHub blob URL and basename label.
 */
function buildDocLinks(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return [];
  const links = [];
  const seen = new Set();
  for (const artifactPath of artifacts) {
    if (typeof artifactPath !== 'string') continue;
    if (!artifactPath.startsWith(`${HOME_LAB_ROOT}/`)) continue;
    const abs = resolve(artifactPath);
    const rel = relative(HOME_LAB_ROOT, abs);
    if (rel.startsWith('..') || rel.startsWith('/') || rel === '') continue;
    const repoPath = rel.split(sep).join('/');
    if (!isCommittedHomeLabPath(repoPath)) continue;
    const url = `${GITHUB_BASE}/${repoPath}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const label = abs.split(sep).pop();
    links.push({ label, url });
  }
  return links;
}

function normalizeRepoDocPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\0')) return null;
  const normalized = normalize(trimmed).split(sep).join('/');
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  if (extname(normalized).toLowerCase() !== '.md') return null;
  if (!isCommittedHomeLabPath(normalized)) return null;
  return normalized;
}

function loadEpicDocsIndex(indexPath = DEFAULT_EPIC_DOCS_INDEX) {
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    const entries = Array.isArray(parsed?.documents) ? parsed.documents : [];
    return entries.map((entry) => ({
      id: entry?.id,
      title: entry?.title,
      category: entry?.category ?? 'Completed Epics',
      path: entry?.path,
      epic_id: entry?.epic_id
    }));
  } catch {
    return [];
  }
}

function defaultDocsManifest() {
  return [...DEFAULT_DOCS_MANIFEST];
}

function docsManifestFromOption(value) {
  return Array.isArray(value) ? value : defaultDocsManifest();
}

function approvedEpicDocs(epicDocsIndexPath = DEFAULT_EPIC_DOCS_INDEX) {
  return approvedDocs(loadEpicDocsIndex(epicDocsIndexPath));
}

function approvedReadableDocs(manifest, epicDocsIndexPath) {
  return [...approvedDocs(manifest), ...approvedEpicDocs(epicDocsIndexPath)];
}

function safeDocMetadata(value, maxLength = 80) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const textValue = String(value).trim();
  if (!textValue || textValue.length > maxLength || isForbiddenRuntimeValue(textValue)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\s&/().:_-]{0,79}$/u.test(textValue)) return null;
  return textValue;
}

function approvedDocs(manifest, epicDocsIndexPath) {
  const documents = [];
  const seenIds = new Set();
  for (const entry of docsManifestFromOption(manifest, epicDocsIndexPath)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!DOC_ID_PATTERN.test(id) || seenIds.has(id)) continue;
    const path = normalizeRepoDocPath(entry.path);
    if (!path) continue;
    const title = typeof entry.title === 'string' && entry.title.trim()
      ? entry.title.trim().slice(0, 120)
      : path.split('/').pop();
    seenIds.add(id);
    const doc = { id, title, path };
    const category = safeDocMetadata(entry.category ?? entry.group);
    if (category) doc.category = category;
    if (typeof entry.epic_id === 'string' && TASK_ID_PATTERN.test(entry.epic_id)) {
      doc.epic_id = entry.epic_id;
    }
    documents.push(doc);
  }
  return documents;
}

async function assertRuntimeDocAvailable(doc, repoDocsRoot) {
  const docsRoot = resolve(repoDocsRoot);
  const absolutePath = resolve(docsRoot, doc.path);
  const relativePath = relative(docsRoot, absolutePath);
  if (relativePath.startsWith('..') || relativePath.startsWith('/') || relativePath === '') {
    const error = new Error('Document is outside the approved repository root');
    error.statusCode = 404;
    throw error;
  }
  const info = await stat(absolutePath);
  if (!info.isFile() || info.size > DOC_CONTENT_MAX_BYTES) {
    const error = new Error('Document is unavailable');
    error.statusCode = 404;
    throw error;
  }
  return absolutePath;
}

async function availableDocs(manifest, repoDocsRoot, epicDocsIndexPath) {
  const documents = [];
  for (const doc of approvedDocs(manifest)) {
    try {
      await assertRuntimeDocAvailable(doc, repoDocsRoot);
      documents.push(doc);
    } catch {
      // The container may carry a narrower /app/repo-docs tree than the source checkout.
      // Do not advertise a doc id unless /api/docs/:id can actually serve it.
    }
  }
  return documents;
}

async function availableReadableDocs(manifest, repoDocsRoot, epicDocsIndexPath) {
  const documents = [];
  for (const doc of approvedReadableDocs(manifest, epicDocsIndexPath)) {
    try {
      await assertRuntimeDocAvailable(doc, repoDocsRoot);
      documents.push(doc);
    } catch {
      // Keep broken or uncopied runtime docs out of generated doc links.
    }
  }
  return documents;
}

async function readApprovedDoc(doc, repoDocsRoot) {
  const absolutePath = await assertRuntimeDocAvailable(doc, repoDocsRoot);
  const content = await readFile(absolutePath, 'utf8');
  return sanitizeRuntimeDocContent(content);
}

function sanitizeRuntimeDocContent(content) {
  return String(content)
    .split(/\r?\n/)
    .filter((line) => !RUNTIME_DOC_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim();
}


const DEFAULT_WRITING_POSTS_FILE = resolve(__dirname, '..', 'data', 'writing-posts.json');
const WRITING_POST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const WRITING_STATUS_VALUES = new Set(['draft', 'published', 'archived']);
const WRITING_STATUS_FILTERS = new Set(['all', 'draft', 'published', 'archived']);
const WRITING_BODY_MAX_CHARS = 40 * 1024;
const WRITING_TAG_MAX_COUNT = 12;
const WRITING_ATTACHMENT_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain']);
const WRITING_ATTACHMENT_URL_PATTERN = /^\/assets\/writing\/[a-z0-9][a-z0-9._/-]{0,180}$/i;
const WRITING_SCHEMA_VERSION = 'writing-post/v2';
const WRITING_EMBED_ALIGN_VALUES = new Set(['none', 'left', 'right', 'center']);
const WRITING_EMBED_WIDTH_VALUES = new Set(['full', 'wide', 'half', 'third']);
const WRITING_EMBED_TYPES = new Set(['image', 'video']);

function stripUnsafeMarkdown(value) {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, (char) => (char === '\n' || char === '\r' || char === '\t') ? char : '')
    .slice(0, WRITING_BODY_MAX_CHARS)
    .trim();
}

function normalizeWritingTag(value) {
  const text = safeText(value, null, 40);
  if (!text || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(text)) return null;
  return text;
}

function parseWritingEmbedKeyValues(rawBlock) {
  const values = new Map();
  for (const line of String(rawBlock ?? '').split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_-]{0,30})\s*:\s*(.*)$/i.exec(line.trim());
    if (!match) continue;
    values.set(match[1].toLowerCase(), safeText(match[2], '', 600));
  }
  return values;
}

function safeWritingEmbedAssetUrl(value) {
  const url = safeText(value, null, 220);
  if (!url || !WRITING_ATTACHMENT_URL_PATTERN.test(url) || url.includes('..') || url.includes('\\')) return null;
  return url;
}

function writingEmbedWarningMarkdown() {
  return ['```embed', 'type: warning', 'message: Unsupported or unsafe embed omitted.', '```'].join('\n');
}

function sanitizeWritingEmbedBlock(rawBlock) {
  const values = parseWritingEmbedKeyValues(rawBlock);
  const type = values.get('type');
  if (!WRITING_EMBED_TYPES.has(type)) return writingEmbedWarningMarkdown();
  const src = safeWritingEmbedAssetUrl(values.get('src'));
  if (!src) return writingEmbedWarningMarkdown();
  const alt = safeText(values.get('alt'), '', 220);
  if (type === 'image' && !alt) return writingEmbedWarningMarkdown();
  const align = WRITING_EMBED_ALIGN_VALUES.has(values.get('align')) ? values.get('align') : 'none';
  const width = WRITING_EMBED_WIDTH_VALUES.has(values.get('width')) ? values.get('width') : 'full';
  const caption = safeText(values.get('caption'), '', 500);
  const lines = ['```embed', `type: ${type}`, `src: ${src}`, `alt: ${alt}`, `align: ${align}`, `width: ${width}`];
  if (caption) lines.push(`caption: ${caption}`);
  lines.push('```');
  return lines.join('\n');
}

function sanitizeWritingRichMarkdown(value) {
  const markdown = stripUnsafeMarkdown(value);
  const lines = markdown.split(/\r?\n/);
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const fence = /^```\s*([a-z0-9_-]*)\s*$/i.exec(lines[index].trim());
    if (!fence || fence[1].toLowerCase() !== 'embed') {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const blockLines = [];
    index += 1;
    while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
      blockLines.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) index += 1;
    output.push(sanitizeWritingEmbedBlock(blockLines.join('\n')));
  }
  return output.join('\n').trim().slice(0, WRITING_BODY_MAX_CHARS);
}

function writingPreview(markdown) {
  return sanitizeWritingRichMarkdown(markdown)
    .replace(/```embed[\s\S]*?```/g, ' media embed ')
    .replace(/[`*_#>\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function sanitizeWritingAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return null;
  const id = safeText(attachment.id, null, 80);
  const displayName = safeText(attachment.display_name ?? attachment.name, null, 120);
  const contentType = safeText(attachment.content_type, null, 80);
  const size = safeInteger(attachment.size);
  const url = safeText(attachment.url, null, 220);
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id)) return null;
  if (!displayName || displayName.includes('/') || displayName.includes('\\') || displayName.includes('..')) return null;
  if (!contentType || !WRITING_ATTACHMENT_CONTENT_TYPES.has(contentType.toLowerCase())) return null;
  if (!Number.isInteger(size) || size < 0 || size > 25 * 1024 * 1024) return null;
  if (!url || !WRITING_ATTACHMENT_URL_PATTERN.test(url) || url.includes('..')) return null;
  return { id, display_name: displayName, content_type: contentType.toLowerCase(), size, url };
}

function sanitizeWritingPost(rawPost) {
  if (!rawPost || typeof rawPost !== 'object' || Array.isArray(rawPost)) return null;
  const postId = safeText(rawPost.post_id ?? rawPost.id, null, 80);
  if (!postId || !WRITING_POST_ID_PATTERN.test(postId)) return null;
  const title = safeText(rawPost.title, 'Untitled draft', 160);
  const status = WRITING_STATUS_VALUES.has(rawPost.status) ? rawPost.status : 'draft';
  const body = sanitizeWritingRichMarkdown(rawPost.body_markdown ?? rawPost.body ?? rawPost.text ?? '');
  const tags = [];
  for (const rawTag of Array.isArray(rawPost.tags) ? rawPost.tags : []) {
    const tag = normalizeWritingTag(rawTag);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= WRITING_TAG_MAX_COUNT) break;
  }
  const attachments = (Array.isArray(rawPost.attachments) ? rawPost.attachments : [])
    .map(sanitizeWritingAttachment)
    .filter(Boolean)
    .slice(0, 12);
  return {
    post_id: postId,
    schema_version: WRITING_SCHEMA_VERSION,
    title,
    status,
    tags,
    preview: writingPreview(body),
    body_markdown: body,
    attachments,
    created_at: safeIsoDate(rawPost.created_at),
    updated_at: safeIsoDate(rawPost.updated_at),
    published_at: status === 'published' ? safeIsoDate(rawPost.published_at ?? rawPost.updated_at) : null,
    storage: 'dashboard writing store'
  };
}

function writingStorageUnavailable() {
  const error = new Error('Writing storage is unavailable');
  error.code = 'writing_storage_unavailable';
  return error;
}

async function loadWritingPosts(writingPostsFile) {
  let fileStats;
  try {
    fileStats = await lstat(writingPostsFile);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw writingStorageUnavailable();
  }
  if (!fileStats.isFile()) throw writingStorageUnavailable();

  let parsed;
  try {
    parsed = JSON.parse(await readFile(writingPostsFile, 'utf8'));
  } catch {
    throw writingStorageUnavailable();
  }
  const entries = Array.isArray(parsed?.posts) ? parsed.posts : (Array.isArray(parsed) ? parsed : []);
  return entries.map(sanitizeWritingPost).filter(Boolean).sort((left, right) => String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? '')));
}

function writingCounts(posts) {
  return {
    all: posts.length,
    draft: posts.filter((post) => post.status === 'draft').length,
    published: posts.filter((post) => post.status === 'published').length,
    archived: posts.filter((post) => post.status === 'archived').length
  };
}

function writingListCard(post) {
  const { body_markdown, attachments, ...card } = post;
  return { ...card, attachment_count: attachments.length };
}


function safePublicWritingError(err) {
  if (err?.code === 'validation_failed') {
    return { statusCode: 400, payload: { error: 'validation_failed', message: 'Writing post validation failed' } };
  }
  if (err?.code === 'unsupported_media_type') {
    return { statusCode: 415, payload: { error: 'unsupported_media_type', message: 'Expected application/json request body' } };
  }
  if (err?.code === 'request_body_too_large') {
    return { statusCode: 413, payload: { error: 'request_body_too_large', message: 'Request body is too large' } };
  }
  if (err?.code === 'invalid_json') {
    return { statusCode: 400, payload: { error: 'invalid_request_body', message: 'Invalid JSON request body' } };
  }
  return { statusCode: 503, payload: { error: 'writing_storage_unavailable', message: 'Writing storage is unavailable' } };
}

function validationFailed() {
  const error = new Error('Writing post validation failed');
  error.code = 'validation_failed';
  throw error;
}

function normalizeWritingTagsInput(value) {
  const raw = typeof value === 'string' ? value.split(',') : (Array.isArray(value) ? value : []);
  const tags = [];
  for (const item of raw) {
    const tag = normalizeWritingTag(item);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= WRITING_TAG_MAX_COUNT) break;
  }
  return tags;
}

function slugifyWritingTitle(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || `draft-${Date.now()}`;
}

function uniqueWritingPostId(base, posts) {
  const existing = new Set(posts.map((post) => post.post_id));
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `${base.slice(0, 80 - tail.length)}${tail}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeWritingPayload(body, existingPost = null, now = new Date()) {
  const title = safeText(body.title, null, 160);
  const status = body.status ?? existingPost?.status ?? 'draft';
  if (!title || !WRITING_STATUS_VALUES.has(status)) validationFailed();
  const bodyMarkdown = sanitizeWritingRichMarkdown(body.body_markdown ?? body.body ?? body.text ?? existingPost?.body_markdown ?? '');
  if (!bodyMarkdown) validationFailed();
  const nowIso = now.toISOString();
  const previousStatus = existingPost?.status;
  const publishedAt = status === 'published'
    ? (existingPost?.published_at ?? (previousStatus === 'published' ? existingPost?.updated_at : null) ?? nowIso)
    : null;
  return {
    ...(existingPost ?? {}),
    schema_version: WRITING_SCHEMA_VERSION,
    title,
    status,
    tags: normalizeWritingTagsInput(body.tags ?? existingPost?.tags ?? []),
    body_markdown: bodyMarkdown,
    attachments: Array.isArray(existingPost?.attachments) ? existingPost.attachments : [],
    created_at: existingPost?.created_at ?? nowIso,
    updated_at: nowIso,
    published_at: publishedAt
  };
}

async function writeWritingPostsFile(writingPostsFile, posts) {
  await mkdir(dirname(writingPostsFile), { recursive: true });
  const temp = join(dirname(writingPostsFile), `.${basename(writingPostsFile)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify({ posts }, null, 2)}\n`, 'utf8');
  await chmod(temp, 0o640);
  await rename(temp, writingPostsFile);
}

async function createWritingPost({ writingPostsFile, body }) {
  const posts = await loadWritingPosts(writingPostsFile);
  const now = new Date();
  const post = sanitizeWritingPost({
    post_id: uniqueWritingPostId(slugifyWritingTitle(body.title), posts),
    ...normalizeWritingPayload(body, null, now)
  });
  if (!post) validationFailed();
  await writeWritingPostsFile(writingPostsFile, [post, ...posts]);
  return { statusCode: 201, payload: { post, mode: 'read-write', storage: 'json file' } };
}

async function updateWritingPost({ writingPostsFile, postId, body }) {
  if (!WRITING_POST_ID_PATTERN.test(postId)) {
    return { statusCode: 404, payload: { error: 'writing_post_not_found', message: 'Writing post was not found' } };
  }
  const posts = await loadWritingPosts(writingPostsFile);
  const index = posts.findIndex((post) => post.post_id === postId);
  if (index === -1) return { statusCode: 404, payload: { error: 'writing_post_not_found', message: 'Writing post was not found' } };
  const post = sanitizeWritingPost({ post_id: postId, ...normalizeWritingPayload(body, posts[index]) });
  if (!post) validationFailed();
  posts[index] = post;
  await writeWritingPostsFile(writingPostsFile, posts);
  return { statusCode: 200, payload: { post, mode: 'read-write', storage: 'json file' } };
}

async function deleteWritingPost({ writingPostsFile, postId }) {
  if (!WRITING_POST_ID_PATTERN.test(postId)) {
    return { statusCode: 404, payload: { error: 'writing_post_not_found', message: 'Writing post was not found' } };
  }
  const posts = await loadWritingPosts(writingPostsFile);
  const index = posts.findIndex((post) => post.post_id === postId);
  if (index === -1) return { statusCode: 404, payload: { error: 'writing_post_not_found', message: 'Writing post was not found' } };
  const [deleted] = posts.splice(index, 1);
  await writeWritingPostsFile(writingPostsFile, posts);
  return { statusCode: 200, payload: { deleted: writingListCard(deleted), mode: 'read-write' } };
}

async function readWritingPosts({ writingPostsFile, searchParams }) {
  const status = searchParams.get('status') ?? 'all';
  if (!WRITING_STATUS_FILTERS.has(status)) {
    return { statusCode: 400, payload: { error: 'invalid_writing_status_filter', message: 'Writing status must be one of all, draft, published, or archived' } };
  }
  try {
    const posts = await loadWritingPosts(writingPostsFile);
    const filtered = status === 'all' ? posts : posts.filter((post) => post.status === status);
    return {
      statusCode: 200,
      payload: {
        posts: filtered.map(writingListCard),
        status,
        counts: writingCounts(posts),
        mode: 'read-only',
        storage: 'committed fixture'
      }
    };
  } catch (err) {
    return safePublicWritingError(err);
  }
}

async function readWritingPost({ writingPostsFile, postId }) {
  if (!WRITING_POST_ID_PATTERN.test(postId)) {
    return { statusCode: 404, payload: { error: 'writing_post_not_found' } };
  }
  try {
    const posts = await loadWritingPosts(writingPostsFile);
    const post = posts.find((candidate) => candidate.post_id === postId);
    if (!post) return { statusCode: 404, payload: { error: 'writing_post_not_found', message: 'Writing post was not found' } };
    return { statusCode: 200, payload: { post, mode: 'read-only' } };
  } catch (err) {
    return safePublicWritingError(err);
  }
}

const DEFAULT_DATASETS_ROOT = resolve(__dirname, '..', 'datasets');
const DEFAULT_DATASET_REGISTRY = [
  {
    dataset_id: 'aseprite',
    display_name: 'Aseprite command pairs',
    description: 'Small source/instruction/output examples for Aseprite workflow curation.',
    schema_version: 'source-instruction-output/v1',
    mode: 'read-only',
    file: 'aseprite.jsonl'
  }
];
const DATASET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATASET_SCHEMA_VERSION_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,79}$/i;
const DATASET_TEXT_MAX_CHARS = 12 * 1024;
const DATASET_DEFAULT_LIMIT = 20;
const DATASET_MAX_LIMIT = 100;

function normalizeDatasetFile(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\0')) return null;
  const normalized = normalize(trimmed).split(sep).join('/');
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  if (normalized.includes('/') || normalized.includes('..')) return null;
  if (normalized.startsWith('.') || extname(normalized).toLowerCase() !== '.jsonl') return null;
  return normalized;
}

function datasetRegistryEntries(registry, datasetsRoot) {
  const root = resolve(datasetsRoot);
  const rawEntries = Array.isArray(registry) ? registry : DEFAULT_DATASET_REGISTRY;
  const entries = [];
  const seen = new Set();
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const datasetId = safeText(raw.dataset_id ?? raw.id, null, 64);
    if (!datasetId || !DATASET_ID_PATTERN.test(datasetId) || seen.has(datasetId)) continue;
    const file = normalizeDatasetFile(raw.file ?? raw.path ?? raw.source);
    if (!file) continue;
    const absolutePath = resolve(root, file);
    const relativePath = relative(root, absolutePath);
    if (relativePath.startsWith('..') || relativePath.startsWith('/') || relativePath === '') continue;
    const schemaVersion = safeText(raw.schema_version, 'source-instruction-output/v1', 80);
    if (!schemaVersion || !DATASET_SCHEMA_VERSION_PATTERN.test(schemaVersion)) continue;
    seen.add(datasetId);
    entries.push({
      dataset_id: datasetId,
      display_name: safeText(raw.display_name ?? raw.title, datasetId, 120),
      description: safeText(raw.description, 'Curated source/instruction/output examples.', 280),
      schema_version: schemaVersion,
      mode: 'read-only',
      absolutePath
    });
  }
  return entries;
}

function publicDataset(dataset, extra = {}) {
  return {
    dataset_id: dataset.dataset_id,
    display_name: dataset.display_name,
    description: dataset.description,
    schema_version: dataset.schema_version,
    mode: dataset.mode,
    storage: 'committed fixture',
    fields: ['source', 'instruction', 'output'],
    ...extra
  };
}

function datasetTextField(value) {
  const text = safeText(value, null, DATASET_TEXT_MAX_CHARS);
  return text && text.length <= DATASET_TEXT_MAX_CHARS ? text : null;
}

function sanitizeDatasetRecord(raw, lineNumber) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = datasetTextField(raw.source);
  const instruction = datasetTextField(raw.instruction);
  const output = datasetTextField(raw.output);
  if (!source || !instruction || !output) return null;
  return { line_number: lineNumber, source, instruction, output };
}

async function loadDatasetRecords(dataset) {
  const records = [];
  let invalidLineCount = 0;
  const content = await readFile(dataset.absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const record = sanitizeDatasetRecord(JSON.parse(line), index + 1);
      if (!record) {
        invalidLineCount += 1;
      } else {
        records.push(record);
      }
    } catch {
      invalidLineCount += 1;
    }
  }
  return { records, invalidLineCount };
}

function parseDatasetPagination(searchParams) {
  const limit = searchParams.get('limit') ?? String(DATASET_DEFAULT_LIMIT);
  const offset = searchParams.get('offset') ?? '0';
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > DATASET_MAX_LIMIT) {
    return { error: 'invalid_dataset_pagination', message: `Dataset limit must be between 1 and ${DATASET_MAX_LIMIT}` };
  }
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 10000) {
    return { error: 'invalid_dataset_pagination', message: 'Dataset offset must be between 0 and 10000' };
  }
  return { limit: parsedLimit, offset: parsedOffset };
}

async function readDatasetList({ datasetRegistry, datasetsRoot }) {
  const datasets = [];
  for (const dataset of datasetRegistryEntries(datasetRegistry, datasetsRoot)) {
    try {
      const loaded = await loadDatasetRecords(dataset);
      datasets.push(publicDataset(dataset, {
        record_count: loaded.records.length,
        invalid_line_count: loaded.invalidLineCount
      }));
    } catch {
      datasets.push(publicDataset(dataset, {
        record_count: null,
        unavailable: true
      }));
    }
  }
  return { statusCode: 200, payload: { datasets, mode: 'read-only', storage: 'committed fixture' } };
}

async function readDatasetRecords({ datasetRegistry, datasetsRoot, datasetId, searchParams }) {
  if (!DATASET_ID_PATTERN.test(datasetId)) {
    return { statusCode: 404, payload: { error: 'dataset_not_found' } };
  }
  const dataset = datasetRegistryEntries(datasetRegistry, datasetsRoot).find((entry) => entry.dataset_id === datasetId);
  if (!dataset) return { statusCode: 404, payload: { error: 'dataset_not_found', message: 'Dataset was not found' } };
  const pagination = parseDatasetPagination(searchParams);
  if (pagination.error) return { statusCode: 400, payload: pagination };
  try {
    const loaded = await loadDatasetRecords(dataset);
    if (loaded.invalidLineCount > 0) {
      return {
        statusCode: 422,
        payload: {
          error: 'invalid_dataset_jsonl',
          message: 'Dataset contains invalid JSONL records and was not served.',
          invalid_line_count: loaded.invalidLineCount
        }
      };
    }
    const page = loaded.records.slice(pagination.offset, pagination.offset + pagination.limit);
    const nextOffset = pagination.offset + page.length < loaded.records.length ? pagination.offset + page.length : null;
    const previousOffset = pagination.offset > 0 ? Math.max(0, pagination.offset - pagination.limit) : null;
    return {
      statusCode: 200,
      payload: {
        dataset: publicDataset(dataset, { record_count: loaded.records.length }),
        records: page,
        pagination: { ...pagination, total: loaded.records.length, next_offset: nextOffset, previous_offset: previousOffset },
        mode: 'read-only'
      }
    };
  } catch {
    return { statusCode: 404, payload: { error: 'dataset_not_found', message: 'Dataset records are unavailable' } };
  }
}



const INVESTMENT_SCREENER_DISCLAIMER = 'Informational screener output only; not financial advice or a trading recommendation.';
const INVESTMENT_SCREENER_DEFAULT_PAGE_SIZE = 25;
const INVESTMENT_SCREENER_MAX_PAGE_SIZE = 100;
const INVESTMENT_SCREENER_MAX_CANDIDATES = 500;
const INVESTMENT_SCREENER_REPORT_MAX_BYTES = 96 * 1024;
const INVESTMENT_SCREENER_REPORT_MAX_CHARS = 48 * 1024;
const INVESTMENT_SCREENER_DOC_LINKS = [
  { label: 'Investment screener product guide', url: '/api/docs/investment-screener-overview', doc_id: 'investment-screener-overview' },
  { label: 'Interpreting screener results', url: '/api/docs/investment-screener-interpreting-results', doc_id: 'investment-screener-interpreting-results' },
  { label: 'Investment screener operations', url: '/api/docs/investment-screener-operations-limitations', doc_id: 'investment-screener-operations-limitations' }
];
const INVESTMENT_SCREENER_MODE_VALUES = new Set(['fixture', 'live', 'asx-yahoo-timeseries', 'us-eodhd-fundamentals', 'nasdaq-eodhd-fundamentals', 'unknown']);
const INVESTMENT_SCREENER_FILTERABLE_FIELDS = new Set(['market', 'exchange', 'region', 'sector', 'industry']);
const INVESTMENT_SCREENER_UNAVAILABLE_FIELDS = new Set([]);
const INVESTMENT_SCREENER_METRIC_VALUES = new Set(['composite', 'quality', 'valuation', 'growth', 'graham_safety', 'durability', 'risk_adjustments']);
const INVESTMENT_SCREENER_WEIGHT_VALUES = new Set(['balanced', 'quality', 'valuation', 'growth', 'graham_safety', 'durability', 'risk_adjustments']);
const INVESTMENT_SCREENER_QUERY_KEYS = new Set(['market', 'exchange', 'region', 'sector', 'industry', 'metric', 'weight', 'topN', 'q', 'limit', 'offset']);
const INVESTMENT_SCREENER_ASX_UNIVERSE_FILE = resolve(__dirname, '..', 'investment-screener', 'universe', 'asx-watchlist.json');
const INVESTMENT_SCREENER_NASDAQ_UNIVERSE_FILE = resolve(__dirname, '..', 'investment-screener', 'universe', 'nasdaq-listed-equities.seed.json');
const INVESTMENT_SCREENER_MODE_LABELS = {
  fixture: 'Fixture/sample data',
  'asx-yahoo-timeseries': 'Yahoo Finance ASX bootstrap scrape',
  'us-eodhd-fundamentals': 'EODHD US fundamentals',
  'nasdaq-eodhd-fundamentals': 'EODHD NASDAQ fundamentals',
  live: 'Live scrape/export',
  cached: 'Cached provider data',
  'manual-seed': 'Manual universe seed',
  unknown: 'Unknown source mode'
};

function isForbiddenRuntimeValue(value) {
  if (value === null || value === undefined) return false;
  const text = String(value);
  return RUNTIME_DOC_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(text));
}

function safeText(value, fallback = null, maxLength = 500) {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const text = String(value).trim();
  if (!text || isForbiddenRuntimeValue(text)) return fallback;
  return text.slice(0, maxLength);
}

function safeTextArray(value, maxItems = 12, maxLength = 240) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const item of value) {
    const text = safeText(item, null, maxLength);
    if (text) output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeIsoDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = safeText(value, null, 80);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function safeMode(value) {
  const mode = safeText(value, 'unknown', 40);
  return INVESTMENT_SCREENER_MODE_VALUES.has(mode) ? mode : 'unknown';
}

function modeLabel(mode) {
  return INVESTMENT_SCREENER_MODE_LABELS[mode] ?? INVESTMENT_SCREENER_MODE_LABELS.unknown;
}

function safeMarket(value, fallback = 'ASX') {
  const text = safeText(value, fallback, 20);
  if (!text || !/^[A-Z0-9._-]{1,20}$/i.test(text)) return fallback;
  return text.toUpperCase();
}

function investmentSourceForMarket(market) {
  const safe = safeMarket(market);
  if (safe === 'NASDAQ' || safe === 'US') return 'eodhd';
  return 'yahoo-finance';
}

// GICS-style sector/industry labels are free-text ("Health Care Equipment & Services",
// "Pharmaceuticals, Biotechnology & Life Sciences"). They may contain letters, digits,
// spaces, ampersands, commas, periods, parentheses, apostrophes, and hyphens.
const CLASSIFICATION_VALUE_RE = /^[\p{L}\p{N}][\p{L}\p{N} &(),.'_-]{0,79}$/u;

function safeClassification(value) {
  const text = safeText(value, null, 80);
  if (!text || !CLASSIFICATION_VALUE_RE.test(text)) return null;
  return text;
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null;
}

function parseMaybeJson(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isoDateOnly(value) {
  const iso = safeIsoDate(value);
  return iso ? iso.slice(0, 10) : null;
}

async function configuredInvestmentUniverse(market = 'ASX') {
  const safe = safeMarket(market);
  if (safe === 'ASX') {
    try {
      const parsed = JSON.parse(await readFile(INVESTMENT_SCREENER_ASX_UNIVERSE_FILE, 'utf8'));
      const active = Array.isArray(parsed)
        ? parsed.filter((entry) => entry && entry.active !== false && safeMarket(entry.market, 'ASX') === 'ASX')
        : [];
      return {
        count: active.length,
        label: 'configured ASX bootstrap watchlist',
        status: 'known_sample_universe',
        version: null
      };
    } catch {
      return { count: null, label: 'unknown', status: 'unknown', version: null };
    }
  }
  if (safe === 'NASDAQ') {
    try {
      const parsed = JSON.parse(await readFile(INVESTMENT_SCREENER_NASDAQ_UNIVERSE_FILE, 'utf8'));
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const metadata = parsed?.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata) ? parsed.metadata : {};
      const active = entries.filter((entry) => entry && entry.active !== false && safeMarket(entry.market, 'NASDAQ') === 'NASDAQ');
      const sourceSha = safeText(metadata.source_sha256 ?? active[0]?.source?.sha256, null, 80);
      const retrievedAt = safeText(metadata.source_retrieved_at ?? active[0]?.source?.retrieved_at, null, 40);
      const label = safeText(metadata.denominator_label, 'NASDAQ listed equities (security-type-filtered, reviewed static seed)', 120);
      return {
        count: safeInteger(metadata.normalized_active_count) ?? active.length,
        label,
        status: safeText(metadata.denominator_status, 'complete_security_type_filtered_listing', 80),
        version: [label, sourceSha ? `sha256:${sourceSha}` : null, retrievedAt ? `retrieved_at:${retrievedAt}` : null].filter(Boolean).join(' ')
      };
    } catch {
      return { count: null, label: 'unknown', status: 'unknown', version: null };
    }
  }
  return { count: null, label: 'unknown', status: 'unknown', version: null };
}

function countArtifactCandidates(payload, market) {
  const wanted = safeMarket(market);
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  return candidates.filter((candidate) => !candidate.excluded && safeMarket(candidate.market, wanted) === wanted && safeNumber(candidate.score) !== null).length;
}

function buildCoverageLabel({ usable, denominator, denominatorLabel, mode, percent }) {
  if (denominator === null || denominator === undefined || denominator <= 0) {
    return `Denominator unavailable; showing ${usable ?? 0} scored candidate${usable === 1 ? '' : 's'}.`;
  }
  const percentPart = typeof percent === 'number' && Number.isFinite(percent) ? ` (${Number.isInteger(percent) ? percent : percent.toFixed(1)}%)` : '';
  if (mode === 'fixture') {
    return `${usable} / ${denominator} fixture sample companies scored${percentPart}; not full ASX market coverage`;
  }
  return `${usable} / ${denominator} ${denominatorLabel} companies scored${percentPart}.`;
}

function normalizeCoverageCounts(rawCoverage, fallbackUsable) {
  const denominator = safeInteger(rawCoverage?.denominator);
  const staleValue = rawCoverage?.stale ?? rawCoverage?.freshness?.stale;
  const counts = {
    usable: safeInteger(rawCoverage?.usable) ?? fallbackUsable,
    scraped: safeInteger(rawCoverage?.scraped),
    scored: safeInteger(rawCoverage?.scored),
    excluded: safeInteger(rawCoverage?.excluded) ?? 0,
    failed: safeInteger(rawCoverage?.failed),
    stale: typeof staleValue === 'boolean' ? staleValue : (safeInteger(staleValue) === null ? null : safeInteger(staleValue) > 0),
    missing_required_fields: safeInteger(rawCoverage?.missing_required_fields)
  };
  let inconsistent = false;
  if (denominator !== null && denominator > 0) {
    for (const key of ['usable', 'scraped', 'scored', 'excluded', 'failed', 'missing_required_fields']) {
      if (counts[key] !== null && counts[key] > denominator) {
        counts[key] = denominator;
        inconsistent = true;
      }
    }
  }
  return { denominator, counts, inconsistent };
}


function hoursBetweenDates(later, earlier) {
  if (!later || !earlier) return null;
  return Number(((later.getTime() - earlier.getTime()) / 36e5).toFixed(1));
}

function daysBetweenDates(later, earlier) {
  if (!later || !earlier) return null;
  return Math.floor((later.getTime() - earlier.getTime()) / 864e5);
}

function parsedDateOrNull(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = safeText(value, null, 80);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function freshnessFromTimestamps({ generatedAt, latestRetrievedAt, dataAsOf, fixture = false, now = new Date(), thresholds = {} }) {
  const maxGeneratedAgeHours = safeNumber(thresholds.max_generated_age_hours) ?? 26;
  const maxSourceAgeHours = safeNumber(thresholds.max_source_age_hours) ?? 26;
  const maxDataAsOfAgeDays = safeNumber(thresholds.max_data_as_of_age_days) ?? 370;
  const generatedDate = parsedDateOrNull(generatedAt);
  const latestRetrievedDate = parsedDateOrNull(latestRetrievedAt);
  const dataAsOfDate = parsedDateOrNull(dataAsOf);
  const generatedAgeHours = hoursBetweenDates(now, generatedDate);
  const latestRetrievedAgeHours = hoursBetweenDates(now, latestRetrievedDate);
  const dataAsOfAgeDays = daysBetweenDates(now, dataAsOfDate);
  const warnings = [];
  if (generatedAgeHours !== null && generatedAgeHours > maxGeneratedAgeHours) warnings.push(`Generated artifact is ${generatedAgeHours}h old, older than ${maxGeneratedAgeHours}h freshness threshold.`);
  if (latestRetrievedAgeHours !== null && latestRetrievedAgeHours > maxSourceAgeHours) warnings.push(`Latest provider retrieval is ${latestRetrievedAgeHours}h old, older than ${maxSourceAgeHours}h freshness threshold.`);
  if (dataAsOfAgeDays !== null && dataAsOfAgeDays > maxDataAsOfAgeDays) warnings.push(`Source data_as_of is ${dataAsOfAgeDays}d old, older than ${maxDataAsOfAgeDays}d freshness threshold.`);
  if (!latestRetrievedAt && !fixture) warnings.push('No provider retrieved_at timestamp is available for this non-fixture run.');
  return {
    freshness: {
      generated_at: safeIsoDate(generatedAt),
      generated_age_hours: generatedAgeHours,
      latest_retrieved_at: safeIsoDate(latestRetrievedAt),
      latest_retrieved_age_hours: latestRetrievedAgeHours,
      data_as_of: isoDateOnly(dataAsOf),
      data_as_of_age_days: dataAsOfAgeDays,
      stale: warnings.length > 0,
      stale_thresholds: {
        max_generated_age_hours: maxGeneratedAgeHours,
        max_source_age_hours: maxSourceAgeHours,
        max_data_as_of_age_days: maxDataAsOfAgeDays
      }
    },
    warnings
  };
}

function sanitizeFreshness(rawFreshness = {}) {
  if (!rawFreshness || typeof rawFreshness !== 'object' || Array.isArray(rawFreshness)) return null;
  const thresholds = rawFreshness.stale_thresholds && typeof rawFreshness.stale_thresholds === 'object' && !Array.isArray(rawFreshness.stale_thresholds)
    ? {
        max_generated_age_hours: safeNumber(rawFreshness.stale_thresholds.max_generated_age_hours),
        max_source_age_hours: safeNumber(rawFreshness.stale_thresholds.max_source_age_hours),
        max_data_as_of_age_days: safeNumber(rawFreshness.stale_thresholds.max_data_as_of_age_days)
      }
    : null;
  return {
    generated_at: safeIsoDate(rawFreshness.generated_at),
    generated_age_hours: safeNumber(rawFreshness.generated_age_hours),
    latest_retrieved_at: safeIsoDate(rawFreshness.latest_retrieved_at),
    latest_retrieved_age_hours: safeNumber(rawFreshness.latest_retrieved_age_hours),
    data_as_of: isoDateOnly(rawFreshness.data_as_of),
    data_as_of_age_days: safeInteger(rawFreshness.data_as_of_age_days),
    stale: rawFreshness.stale === true,
    ...(thresholds ? { stale_thresholds: thresholds } : {})
  };
}

function finalizeCoverage({ market, mode, rawCoverage = {}, fallbackUsable = 0, denominatorOverride = null, denominatorLabelOverride = null, denominatorStatusOverride = null, window = null, caveats = [], alternateDenominators = [] }) {
  const normalized = normalizeCoverageCounts(rawCoverage, fallbackUsable);
  const denominator = denominatorOverride ?? normalized.denominator;
  const denominatorLabel = denominatorLabelOverride ?? safeText(rawCoverage?.denominator_label, denominator === null ? 'unknown' : 'configured ASX bootstrap watchlist', 120);
  const denominatorStatus = denominatorStatusOverride ?? safeText(rawCoverage?.denominator_status, denominator === null ? 'unknown' : 'known_sample_universe', 80);
  const counts = { ...normalized.counts };
  let coverageInconsistent = normalized.inconsistent;
  if (denominator !== null && denominator > 0) {
    for (const key of ['usable', 'scraped', 'scored', 'excluded', 'failed', 'stale', 'missing_required_fields']) {
      if (counts[key] !== null && counts[key] > denominator) {
        counts[key] = denominator;
        coverageInconsistent = true;
      }
    }
  }
  const usable = counts.usable ?? 0;
  const percent = denominator && denominator > 0 ? Math.min(100, Number(((usable / denominator) * 100).toFixed(1))) : null;
  const outputCaveats = safeTextArray(caveats.length ? caveats : rawCoverage?.caveats, 8, 240);
  const freshness = sanitizeFreshness(rawCoverage?.freshness);
  const warnings = safeTextArray(rawCoverage?.warnings, 12, 240);
  if (coverageInconsistent) outputCaveats.push('Coverage counts exceeded the denominator and were clamped for display.');
  if (mode === 'fixture' && !outputCaveats.some((item) => /fixture|sample/i.test(item))) {
    outputCaveats.push('Coverage is against the fixture sample universe, not all ASX-listed companies.');
  }
  if (denominator === null && !outputCaveats.some((item) => /denominator/i.test(item))) {
    outputCaveats.push('Coverage denominator unavailable; showing scored rows only.');
  }
  return {
    market: safeMarket(market),
    denominator,
    denominator_label: denominatorLabel,
    denominator_status: denominatorStatus,
    usable,
    scraped: counts.scraped,
    scored: counts.scored,
    excluded: counts.excluded,
    failed: counts.failed,
    stale: counts.stale,
    missing_required_fields: counts.missing_required_fields,
    percent,
    coverage_label: buildCoverageLabel({ usable, denominator, denominatorLabel, mode, percent }),
    window,
    caveats: outputCaveats,
    ...(freshness ? { freshness } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(coverageInconsistent ? { coverage_inconsistent: true } : {}),
    ...(alternateDenominators.length ? { alternate_denominators: alternateDenominators } : {})
  };
}

function sourceSummaryFromArtifact(source, fileMtime) {
  const mode = safeMode(source?.mode);
  const summary = source?.source_summary && typeof source.source_summary === 'object' && !Array.isArray(source.source_summary)
    ? source.source_summary
    : {};
  const providers = safeTextArray(summary.providers, 8, 80);
  const sourceFamilies = safeTextArray(summary.source_families, 8, 80);
  return {
    mode,
    mode_label: modeLabel(mode),
    providers: providers.length ? providers : (mode === 'fixture' ? ['fixture'] : []),
    source_families: sourceFamilies.length ? sourceFamilies : providers,
    universe_source: safeText(summary.universe_source, mode === 'fixture' ? 'fixture sample universe' : 'unknown', 120),
    universe_version: safeText(summary.universe_version, null, 120),
    latest_retrieved_at: safeIsoDate(summary.latest_retrieved_at),
    latest_hydrated_at: safeIsoDate(summary.latest_hydrated_at) ?? safeIsoDate(source?.generated_at) ?? fileMtime?.toISOString?.() ?? null,
    data_as_of: isoDateOnly(summary.data_as_of ?? source?.data_as_of),
    provenance_rows: safeInteger(summary.provenance_rows),
    provenance_fields: safeInteger(summary.provenance_fields),
    caveats: safeTextArray(summary.caveats, 8, 240)
  };
}

async function coverageFromArtifact(raw, fileMtime, market = 'ASX') {
  const source = normalizeInvestmentRankedPayload(raw);
  const safe = sanitizeInvestmentRankedPayload(source, fileMtime);
  const selectedMarket = safeMarket(market);
  const summary = sourceSummaryFromArtifact(source, fileMtime);
  const fallbackUsable = countArtifactCandidates(safe, selectedMarket);
  let denominatorOverride = null;
  let denominatorLabelOverride = null;
  let denominatorStatusOverride = null;
  const alternateDenominators = [];
  const configuredUniverse = await configuredInvestmentUniverse(selectedMarket);
  if (summary.mode === 'fixture') {
    denominatorOverride = fallbackUsable;
    denominatorLabelOverride = 'fixture sample universe';
    denominatorStatusOverride = 'sample';
    if (configuredUniverse.count !== null && configuredUniverse.count !== denominatorOverride) {
      const alternatePercent = configuredUniverse.count > 0 ? Number(((fallbackUsable / configuredUniverse.count) * 100).toFixed(1)) : null;
      alternateDenominators.push({
        denominator: configuredUniverse.count,
        denominator_label: configuredUniverse.label,
        usable: Math.min(fallbackUsable, configuredUniverse.count),
        percent: alternatePercent === null ? null : Math.min(100, alternatePercent)
      });
    }
    summary.caveats.push('Fixture/sample data only — not a real ASX scrape/backfill.');
  } else if (!source.coverage && configuredUniverse.count !== null) {
    denominatorOverride = configuredUniverse.count;
    denominatorLabelOverride = configuredUniverse.label;
    denominatorStatusOverride = configuredUniverse.status;
  }
  const coverage = finalizeCoverage({
    market: selectedMarket,
    mode: summary.mode,
    rawCoverage: source.coverage,
    fallbackUsable,
    denominatorOverride,
    denominatorLabelOverride,
    denominatorStatusOverride,
    window: {
      run_key: safeText(source?.run_key, null, 160),
      mode: summary.mode,
      completed_at: safeIsoDate(source?.completed_at ?? source?.generated_at) ?? fileMtime?.toISOString?.() ?? null
    },
    caveats: [
      ...(safeTextArray(source.coverage?.caveats, 8, 240)),
      'Postgres coverage history unavailable; coverage inferred from sanitized ranked artifact.'
    ],
    alternateDenominators
  });
  return {
    market: selectedMarket,
    status: 'degraded',
    source: 'ranked_artifact',
    generated_at: safeIsoDate(source?.generated_at) ?? fileMtime?.toISOString?.() ?? new Date().toISOString(),
    source_summary: summary,
    coverage
  };
}

async function coverageFromPostgres(pool, market = 'ASX') {
  if (!pool || typeof pool.query !== 'function') return null;
  const selectedMarket = safeMarket(market);
  const result = await pool.query(`WITH latest_run AS (
      SELECT *
      FROM investment_screener_runs
      WHERE market = $1 AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, id DESC
      LIMIT 1
    ), scored AS (
      SELECT
        count(DISTINCT s.company_id) FILTER (WHERE s.excluded = false AND s.composite_score IS NOT NULL) AS usable,
        count(DISTINCT s.company_id) AS scored,
        count(DISTINCT s.company_id) FILTER (WHERE s.excluded = true) AS excluded
      FROM investment_screener_scores s
      JOIN latest_run r ON r.id = s.run_id
    ), observed AS (
      SELECT
        count(DISTINCT o.company_id) AS scraped,
        max(o.created_at) AS latest_observed_at,
        max(o.data_as_of) AS data_as_of,
        count(DISTINCT o.company_id) FILTER (WHERE jsonb_array_length(coalesce(o.missing_fields, '[]'::jsonb)) > 0) AS missing_required_fields
      FROM investment_screener_observations o
      JOIN latest_run r ON r.id = o.run_id
    ), provenance AS (
      SELECT
        count(*) AS provenance_rows,
        count(DISTINCT field_name) AS provenance_fields,
        array_remove(array_agg(DISTINCT source_family), NULL) AS source_families,
        max(retrieved_at) AS latest_retrieved_at,
        max(data_as_of) AS latest_provenance_data_as_of
      FROM investment_screener_provenance p
      JOIN latest_run r ON r.id = p.run_id
    )
    SELECT
      r.run_key, r.mode, r.market, r.started_at, r.completed_at, r.universe_version, r.source_mix,
      r.metadata, r.universe_metadata, r.provider_failures,
      scored.usable, scored.scored, scored.excluded,
      observed.scraped, observed.latest_observed_at, observed.data_as_of, observed.missing_required_fields,
      provenance.provenance_rows, provenance.provenance_fields, provenance.source_families,
      provenance.latest_retrieved_at, provenance.latest_provenance_data_as_of
    FROM latest_run r, scored, observed, provenance`, [selectedMarket]);
  const row = result?.rows?.[0];
  if (!row) return null;
  const mode = safeMode(row.mode);
  const configuredUniverse = await configuredInvestmentUniverse(selectedMarket);
  const sourceMix = parseMaybeJson(row.source_mix, {});
  const runMetadata = parseMaybeJson(row.metadata, {});
  const universeMetadata = parseMaybeJson(row.universe_metadata, {});
  const providerFailures = parseMaybeJson(row.provider_failures, []);
  const sourceFamilies = safeTextArray(row.source_families, 8, 80);
  const providers = safeTextArray(sourceMix?.providers, 8, 80);
  const denominator = mode === 'fixture'
    ? (Array.isArray(sourceMix?.universe) ? sourceMix.universe.length : safeInteger(row.usable))
    : (safeInteger(universeMetadata.denominator)
      ?? safeInteger(universeMetadata.selected_count)
      ?? safeInteger(universeMetadata.normalized_active_count)
      ?? safeInteger(universeMetadata.full_count)
      ?? safeInteger(universeMetadata.count)
      ?? safeInteger(sourceMix?.denominator)
      ?? configuredUniverse.count);
  const denominatorLabel = mode === 'fixture'
    ? 'fixture sample universe'
    : (safeText(universeMetadata.denominator_label ?? runMetadata.denominator_label, configuredUniverse.label, 120));
  const denominatorStatus = mode === 'fixture'
    ? 'sample'
    : (safeText(universeMetadata.denominator_status ?? runMetadata.denominator_status, configuredUniverse.status, 80));
  const providerFailureCount = Array.isArray(providerFailures) ? providerFailures.length : (safeInteger(providerFailures) ?? 0);
  const postgresFreshness = freshnessFromTimestamps({
    generatedAt: row.completed_at,
    latestRetrievedAt: row.latest_retrieved_at,
    dataAsOf: row.data_as_of ?? row.latest_provenance_data_as_of,
    fixture: mode === 'fixture'
  });
  const staleCount = postgresFreshness.freshness.stale ? (safeInteger(row.scraped) ?? safeInteger(row.usable) ?? 1) : 0;
  const coverage = finalizeCoverage({
    market: selectedMarket,
    mode,
    rawCoverage: {
      denominator,
      denominator_label: denominatorLabel,
      denominator_status: denominatorStatus,
      usable: row.usable,
      scraped: row.scraped,
      scored: row.scored,
      excluded: row.excluded,
      failed: providerFailureCount,
      stale: staleCount,
      missing_required_fields: row.missing_required_fields,
      freshness: postgresFreshness.freshness,
      warnings: postgresFreshness.warnings,
      caveats: mode === 'fixture'
        ? ['Coverage is against the fixture sample universe, not all ASX-listed companies.']
        : [
            denominatorStatus === 'complete_security_type_filtered_listing'
              ? 'Coverage denominator is a reviewed security-type-filtered full listing; excluded security types are not counted as companies.'
              : (denominatorStatus === 'complete_exchange_listing'
                ? 'Coverage denominator is the reviewed full exchange listing.'
                : (selectedMarket === 'ASX'
                  ? 'Coverage is for the configured bootstrap watchlist, not the full ASX exchange.'
                  : 'Coverage denominator comes from the latest reviewed market universe metadata.')),
            providerFailureCount > 0 ? `${providerFailureCount} provider failure${providerFailureCount === 1 ? '' : 's'} reported for the latest run.` : null,
            safeInteger(row.excluded) > 0 ? `${safeInteger(row.excluded)} scored row${safeInteger(row.excluded) === 1 ? '' : 's'} excluded from usable coverage.` : null
          ].filter(Boolean)
    },
    fallbackUsable: safeInteger(row.usable) ?? 0,
    window: {
      run_key: safeText(row.run_key, null, 180),
      mode,
      started_at: safeIsoDate(row.started_at),
      completed_at: safeIsoDate(row.completed_at)
    }
  });
  return {
    market: selectedMarket,
    status: 'ok',
    source: 'postgres',
    generated_at: new Date().toISOString(),
    source_summary: {
      mode,
      mode_label: modeLabel(mode),
      providers: providers.length ? providers : sourceFamilies,
      source_families: sourceFamilies,
      universe_source: denominatorLabel,
      universe_version: safeText(row.universe_version, configuredUniverse.version, 120),
      latest_retrieved_at: safeIsoDate(row.latest_retrieved_at),
      latest_hydrated_at: safeIsoDate(row.latest_observed_at ?? row.completed_at),
      data_as_of: isoDateOnly(row.data_as_of ?? row.latest_provenance_data_as_of),
      provenance_rows: safeInteger(row.provenance_rows),
      provenance_fields: safeInteger(row.provenance_fields),
      caveats: mode === 'asx-yahoo-timeseries'
        ? ['Yahoo Finance public endpoints are unofficial; verify against ASX announcements/company reports before acting.']
        : []
    },
    coverage
  };
}

async function createInvestmentScreenerHistoryPool(connectionString) {
  if (!connectionString) return null;
  const { Pool } = await import('pg');
  return new Pool({ connectionString, ssl: process.env.PGSSLMODE === 'disable' ? false : undefined });
}

function safeSubScores(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, rawScore] of Object.entries(value)) {
    const safeKey = safeText(key, null, 80);
    if (!safeKey || !/^[a-z0-9][a-z0-9_. -]{0,79}$/i.test(safeKey) || isForbiddenRuntimeValue(safeKey) || /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)/i.test(safeKey)) continue;
    const score = safeNumber(rawScore);
    if (score !== null) output[safeKey] = score;
  }
  return output;
}

function sanitizeInvestmentCandidate(candidate, index = 0) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const ticker = safeText(candidate.ticker, null, 24);
  const name = safeText(candidate.name, null, 160);
  if (!ticker && !name) return null;
  const rank = safeNumber(candidate.rank);
  const score = safeNumber(candidate.score) ?? safeNumber(candidate.composite_score);
  const output = {
    rank: rank ?? index + 1,
    ticker: ticker ?? 'UNKNOWN',
    name: name ?? ticker ?? 'Unknown candidate',
    market: safeText(candidate.market, null, 80),
    currency: safeText(candidate.currency, null, 16),
    sector: safeClassification(candidate.sector),
    industry: safeClassification(candidate.industry),
    score,
    sub_scores: safeSubScores(candidate.sub_scores),
    missing_penalty_points: safeNumber(candidate.missing_penalty_points),
    risk_flags: safeTextArray(candidate.risk_flags),
    caveats: safeTextArray(candidate.caveats),
    score_caps: safeScoreCaps(candidate.score_caps),
    sanitized_provenance_summary: safeText(candidate.sanitized_provenance_summary, null, 300)
  };
  const exchange = safeText(candidate.exchange, null, 32);
  const region = safeText(candidate.region, null, 32);
  if (exchange) output.exchange = exchange;
  if (region) output.region = region;
  return output;
}

function safeScoreCaps(value) {
  if (Array.isArray(value)) return safeTextArray(value);
  if (!value || typeof value !== 'object') return [];
  return safeTextArray(Object.entries(value).map(([key, rawValue]) => `${key}: ${rawValue}`));
}

function normalizeInvestmentRankedPayload(raw) {
  if (Array.isArray(raw)) {
    return {
      mode: 'unknown',
      generated_at: null,
      data_as_of: null,
      limitations: [],
      candidates: raw.filter((candidate) => candidate && typeof candidate === 'object' && !candidate.excluded),
      excluded: raw.filter((candidate) => candidate && typeof candidate === 'object' && candidate.excluded)
    };
  }
  if (raw && typeof raw === 'object') return raw;
  return {};
}

function sanitizeInvestmentRankedPayload(raw, fileMtime) {
  const source = normalizeInvestmentRankedPayload(raw);
  const candidates = Array.isArray(source.candidates)
    ? source.candidates.map((candidate, index) => sanitizeInvestmentCandidate(candidate, index)).filter(Boolean).slice(0, INVESTMENT_SCREENER_MAX_CANDIDATES)
    : [];
  const excluded = Array.isArray(source.excluded)
    ? source.excluded.map((candidate, index) => sanitizeInvestmentCandidate(candidate, index)).filter(Boolean).slice(0, INVESTMENT_SCREENER_MAX_CANDIDATES)
    : [];
  return {
    mode: safeMode(source.mode),
    generated_at: safeIsoDate(source.generated_at) ?? fileMtime?.toISOString?.() ?? null,
    data_as_of: safeIsoDate(source.data_as_of),
    disclaimer: INVESTMENT_SCREENER_DISCLAIMER,
    limitations: safeTextArray(source.limitations, 12, 300),
    candidates,
    excluded,
    doc_links: INVESTMENT_SCREENER_DOC_LINKS
  };
}

function investmentFilterError(error, message) {
  return { statusCode: 400, payload: { error, message } };
}

function readInvestmentFilterParams(searchParams) {
  const applied = {};
  if (!searchParams || [...searchParams.keys()].length === 0) return { applied, active: false };

  for (const key of searchParams.keys()) {
    if (!INVESTMENT_SCREENER_QUERY_KEYS.has(key)) {
      return investmentFilterError('unsupported_investment_screener_filter', 'This investment screener filter is not supported by the dashboard.');
    }
  }

  for (const field of INVESTMENT_SCREENER_FILTERABLE_FIELDS) {
    const rawValue = searchParams.get(field);
    if (!rawValue || !rawValue.trim()) {
      if (searchParams.has(field) && String(rawValue ?? '').trim()) {
        return investmentFilterError('invalid_investment_screener_filter', 'Investment screener filter values must use plain labels.');
      }
      continue;
    }
    if (field === 'market' || field === 'exchange' || field === 'region') {
      const value = safeText(rawValue, null, 80);
      if (!value || !/^[a-z0-9][a-z0-9 ._-]{0,79}$/i.test(value)) {
        return investmentFilterError('invalid_investment_screener_filter', `Investment screener ${field} values must use plain labels.`);
      }
      applied[field] = value.toUpperCase();
      continue;
    }
    // sector / industry: repeated-parameter multi-select. Each occurrence is one
    // classification label (searchParams.getAll returns an array, so no delimiter
    // parsing — labels may legitimately contain commas). An invalid label fails
    // the whole request.
    const rawValues = searchParams.getAll(field);
    if (rawValues.length === 0) {
      return investmentFilterError('invalid_investment_screener_filter', `Investment screener ${field} filter values must use plain labels.`);
    }
    const cleaned = [];
    for (const rawValue of rawValues) {
      const validated = safeClassification(rawValue);
      if (!validated) {
        return investmentFilterError('invalid_investment_screener_filter', `Investment screener ${field} filter values must use plain labels.`);
      }
      cleaned.push(validated);
    }
    applied[field] = cleaned;
  }

  const metric = safeText(searchParams.get('metric'), null, 40);
  if (metric) {
    if (!INVESTMENT_SCREENER_METRIC_VALUES.has(metric)) {
      return investmentFilterError('invalid_investment_screener_filter', 'Investment screener metric must be one of the supported public score fields.');
    }
    if (metric !== 'composite') applied.metric = metric;
  }

  const weight = safeText(searchParams.get('weight'), null, 40);
  if (weight) {
    if (!INVESTMENT_SCREENER_WEIGHT_VALUES.has(weight)) {
      return investmentFilterError('invalid_investment_screener_filter', 'Investment screener weight preset is not supported.');
    }
    if (weight !== 'balanced') applied.weight = weight;
  }

  const q = safeText(searchParams.get('q'), null, 120);
  if (q) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._&'()-]{0,119}$/u.test(q)) {
      return investmentFilterError('invalid_investment_screener_filter', 'Investment screener search must use plain company or ticker text.');
    }
    applied.q = q;
  } else if (searchParams.has('q') && String(searchParams.get('q') ?? '').trim()) {
    return investmentFilterError('invalid_investment_screener_filter', 'Investment screener search must use plain company or ticker text.');
  }

  const topNRaw = searchParams.get('topN');
  if (topNRaw !== null && topNRaw !== '') {
    const topN = Number(topNRaw);
    if (!Number.isInteger(topN) || topN < 1 || topN > INVESTMENT_SCREENER_MAX_PAGE_SIZE) {
      return investmentFilterError('invalid_investment_screener_filter', `topN must be an integer from 1 to ${INVESTMENT_SCREENER_MAX_PAGE_SIZE}.`);
    }
    applied.topN = topN;
  }

  const limitRaw = searchParams.get('limit');
  if (limitRaw !== null && limitRaw !== '') {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > INVESTMENT_SCREENER_MAX_PAGE_SIZE) {
      return investmentFilterError('invalid_investment_screener_filter', `limit must be an integer from 1 to ${INVESTMENT_SCREENER_MAX_PAGE_SIZE}.`);
    }
    applied.limit = limit;
  }

  const offsetRaw = searchParams.get('offset');
  if (offsetRaw !== null && offsetRaw !== '') {
    const offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
      return investmentFilterError('invalid_investment_screener_filter', 'offset must be a non-negative integer.');
    }
    applied.offset = offset;
  }

  return { applied, active: Object.keys(applied).length > 0 || [...searchParams.keys()].length > 0 };
}

function searchInvestmentCandidates(candidates, query) {
  if (!query) return candidates;
  const needle = query.toLowerCase();
  return candidates.filter((candidate) => [candidate.ticker, candidate.name, candidate.market, candidate.exchange, candidate.region, candidate.currency, candidate.sector, candidate.industry]
    .some((value) => String(value ?? '').toLowerCase().includes(needle)));
}

function matchClassification(candidate, field, wanted) {
  if (!Array.isArray(wanted) || wanted.length === 0) return true;
  const actual = String(candidate?.[field] ?? '').trim().toLowerCase();
  if (!actual) return false;
  return wanted.some((entry) => String(entry).trim().toLowerCase() === actual);
}

function distinctPlainValues(candidates, field) {
  const values = new Set();
  for (const candidate of candidates) {
    const value = candidate?.[field];
    if (typeof value === 'string' && value.trim()) values.add(value.trim().toUpperCase());
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

function distinctClassifications(candidates, field) {
  const values = new Set();
  for (const candidate of candidates) {
    const value = candidate?.[field];
    if (typeof value === 'string' && value.trim()) values.add(value.trim());
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

function investmentPagination(total, limit, offset) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, INVESTMENT_SCREENER_MAX_PAGE_SIZE) : INVESTMENT_SCREENER_DEFAULT_PAGE_SIZE;
  const safeOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const nextOffset = safeOffset + safeLimit < total ? safeOffset + safeLimit : null;
  const previousOffset = safeOffset > 0 ? Math.max(0, safeOffset - safeLimit) : null;
  return {
    limit: safeLimit,
    offset: safeOffset,
    total,
    has_more: nextOffset !== null,
    next_offset: nextOffset,
    previous_offset: previousOffset
  };
}

function applyInvestmentScreenerFilters(payload, searchParams) {
  const parsed = readInvestmentFilterParams(searchParams);
  if (parsed.statusCode) return parsed;
  const allCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (!parsed.active) {
    return {
      statusCode: 200,
      payload: {
        ...payload,
        available_facets: {
          exchanges: distinctPlainValues(allCandidates, 'exchange'),
          regions: distinctPlainValues(allCandidates, 'region'),
          sectors: distinctClassifications(allCandidates, 'sector'),
          industries: distinctClassifications(allCandidates, 'industry')
        }
      }
    };
  }

  const { applied } = parsed;
  let candidates = [...payload.candidates];
  const messages = [];

  if (applied.market) {
    const wanted = applied.market.toLowerCase();
    candidates = candidates.filter((candidate) => String(candidate.market ?? '').toLowerCase() === wanted);
  }
  if (applied.exchange) {
    const wanted = applied.exchange.toLowerCase();
    candidates = candidates.filter((candidate) => String(candidate.exchange ?? '').toLowerCase() === wanted);
  }
  if (applied.region) {
    const wanted = applied.region.toLowerCase();
    candidates = candidates.filter((candidate) => String(candidate.region ?? '').toLowerCase() === wanted);
  }

  if (applied.sector) {
    candidates = candidates.filter((candidate) => matchClassification(candidate, 'sector', applied.sector));
  }
  if (applied.industry) {
    candidates = candidates.filter((candidate) => matchClassification(candidate, 'industry', applied.industry));
  }

  candidates = searchInvestmentCandidates(candidates, applied.q);

  const sortMetric = applied.metric ?? (applied.weight && applied.weight !== 'balanced' ? applied.weight : null);
  if (sortMetric) {
    candidates.sort((left, right) => {
      const leftScore = safeNumber(left.sub_scores?.[sortMetric]) ?? Number.NEGATIVE_INFINITY;
      const rightScore = safeNumber(right.sub_scores?.[sortMetric]) ?? Number.NEGATIVE_INFINITY;
      return rightScore - leftScore || (safeNumber(left.rank) ?? 0) - (safeNumber(right.rank) ?? 0);
    });
  }

  const total = candidates.length;
  const limit = applied.limit ?? applied.topN ?? INVESTMENT_SCREENER_DEFAULT_PAGE_SIZE;
  const offset = applied.offset ?? 0;

  // Facets are computed against the full (pre-pagination) filtered candidate set so
  // the sector/industry dropdowns reflect what remains selectable after other filters.
  const available_facets = {
    exchanges: distinctPlainValues(candidates, 'exchange'),
    regions: distinctPlainValues(candidates, 'region'),
    sectors: distinctClassifications(candidates, 'sector'),
    industries: distinctClassifications(candidates, 'industry')
  };

  const pagination = investmentPagination(total, limit, offset);
  candidates = candidates.slice(pagination.offset, pagination.offset + pagination.limit);
  if (candidates.length === 0) {
    messages.push('No candidates match the selected investment screener filters. Try clearing one filter or waiting for richer ranked data.');
  } else {
    messages.push(`Showing ${candidates.length} of ${total} candidate${total === 1 ? '' : 's'} after the selected filters.`);
  }

  return {
    statusCode: 200,
    payload: {
      ...payload,
      candidates,
      applied_filters: applied,
      available_facets,
      total_candidates: total,
      displayed_count: candidates.length,
      pagination,
      messages
    }
  };
}

async function readLatestInvestmentScreenerManifestSafe(dataRoot) {
  try {
    return await readLatestInvestmentScreenerManifest({ dataRoot, market: 'ASX', source: 'yahoo-finance' });
  } catch {
    return null;
  }
}

async function readCanonicalInvestmentScreenerCoverageSafe(dataRoot) {
  try {
    const coveragePath = join(dataRoot, 'investment-screener', 'exports', 'dashboard', 'market=ASX', 'latest_coverage.json');
    const info = await stat(coveragePath);
    if (!info.isFile()) return null;
    return JSON.parse(await readFile(coveragePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readInvestmentScreenerReport(reportFile, dataRoot) {
  if (!reportFile && !dataRoot) {
    return { statusCode: 503, payload: { error: 'investment_screener_not_configured', message: 'Investment screener report file is not configured' } };
  }

  // Prefer the canonical non-fixture dashboard export generated by the publisher,
  // which carries live mode/data provenance. The legacy runtime-cache report file is
  // a fixture stub that must never be presented as "live".
  if (dataRoot) {
    try {
      const canonicalPath = join(dataRoot, 'investment-screener', 'exports', 'dashboard', 'market=ASX', 'latest_report.txt');
      const canonicalInfo = await stat(canonicalPath);
      if (canonicalInfo.isFile()) {
        const canonicalContent = sanitizeRuntimeDocContent(await readFile(canonicalPath, 'utf8')).slice(0, INVESTMENT_SCREENER_REPORT_MAX_CHARS);
        const manifest = await readLatestInvestmentScreenerManifestSafe(dataRoot);
        const canonicalCoverage = await readCanonicalInvestmentScreenerCoverageSafe(dataRoot);
        return {
          statusCode: 200,
          payload: {
            mode: safeMode(manifest?.mode ?? canonicalCoverage?.source_summary?.mode),
            generated_at: safeIsoDate(manifest?.generated_at ?? manifest?.completed_at ?? canonicalCoverage?.generated_at) ?? canonicalInfo.mtime.toISOString(),
            data_as_of: isoDateOnly(manifest?.data_as_of ?? canonicalCoverage?.source_summary?.data_as_of ?? canonicalCoverage?.coverage?.freshness?.data_as_of),
            disclaimer: INVESTMENT_SCREENER_DISCLAIMER,
            content: canonicalContent,
            doc_links: INVESTMENT_SCREENER_DOC_LINKS
          }
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  if (!reportFile) {
    return { statusCode: 404, payload: { error: 'report_not_found', message: 'No investment screener report has been generated yet' } };
  }
  try {
    const info = await stat(reportFile);
    if (!info.isFile()) {
      return { statusCode: 404, payload: { error: 'report_not_found', message: 'No investment screener report has been generated yet' } };
    }
    if (info.size > INVESTMENT_SCREENER_REPORT_MAX_BYTES) {
      return { statusCode: 502, payload: { error: 'report_read_error', message: 'Investment screener report is too large for dashboard display' } };
    }
    const rawContent = await readFile(reportFile, 'utf8');
    const content = sanitizeRuntimeDocContent(rawContent).slice(0, INVESTMENT_SCREENER_REPORT_MAX_CHARS);
    // Legacy runtime-cache report file is a fixture artifact: surface it truthfully,
    // never as "live", so stale fixture content is never presented as live provider data.
    const fixture = /\(fixture\)/i.test(content) || /fixture/i.test(content);
    return {
      statusCode: 200,
      payload: {
        mode: fixture ? 'fixture' : 'unknown',
        generated_at: info.mtime.toISOString(),
        data_as_of: null,
        disclaimer: INVESTMENT_SCREENER_DISCLAIMER,
        content,
        doc_links: INVESTMENT_SCREENER_DOC_LINKS
      }
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { statusCode: 404, payload: { error: 'report_not_found', message: 'No investment screener report has been generated yet' } };
    }
    return { statusCode: 502, payload: { error: 'report_read_error', message: 'Unable to read investment screener report' } };
  }
}

function payloadFromDuckDbSummary(summary) {
  return {
    mode: safeMode(summary?.source_summary?.mode),
    generated_at: safeIsoDate(summary?.generated_at),
    data_as_of: safeIsoDate(summary?.source_summary?.data_as_of),
    disclaimer: INVESTMENT_SCREENER_DISCLAIMER,
    limitations: [],
    candidates: Array.isArray(summary?.ranked_candidates)
      ? summary.ranked_candidates.map((candidate, index) => sanitizeInvestmentCandidate(candidate, index)).filter(Boolean)
      : [],
    excluded: [],
    doc_links: INVESTMENT_SCREENER_DOC_LINKS,
    source_summary: {
      mode: safeMode(summary?.source_summary?.mode),
      mode_label: modeLabel(safeMode(summary?.source_summary?.mode)),
      providers: safeTextArray(summary?.source_summary?.providers, 8, 80),
      source_families: safeTextArray(summary?.source_summary?.source_families, 8, 80),
      universe_source: safeText(summary?.source_summary?.universe_source, 'unknown', 120),
      universe_version: safeText(summary?.source_summary?.universe_version, null, 120),
      latest_retrieved_at: safeIsoDate(summary?.source_summary?.latest_retrieved_at),
      latest_hydrated_at: safeIsoDate(summary?.generated_at),
      data_as_of: isoDateOnly(summary?.source_summary?.data_as_of),
      provenance_rows: safeInteger(summary?.source_summary?.provenance_rows),
      provenance_fields: safeInteger(summary?.source_summary?.provenance_fields),
      caveats: safeTextArray(summary?.source_summary?.caveats, 8, 240)
    },
    coverage: finalizeCoverage({
      market: summary?.market ?? 'ASX',
      mode: safeMode(summary?.source_summary?.mode),
      rawCoverage: summary?.coverage,
      fallbackUsable: Array.isArray(summary?.ranked_candidates) ? summary.ranked_candidates.length : 0
    })
  };
}

async function coverageFromDuckDbDataRoot(dataRoot, market = 'ASX') {
  if (!dataRoot) return null;
  const summary = await buildInvestmentScreenerDuckDbSummary({ dataRoot, market: safeMarket(market), source: investmentSourceForMarket(market) });
  const payload = payloadFromDuckDbSummary(summary);
  return {
    market: payload.coverage.market,
    status: 'ok',
    source: 'duckdb',
    generated_at: payload.generated_at,
    source_summary: payload.source_summary,
    coverage: payload.coverage
  };
}

async function rankedFromDuckDbDataRoot(dataRoot, searchParams = null) {
  if (!dataRoot) return null;
  const market = safeMarket(searchParams?.get?.('market') ?? 'ASX');
  const summary = await buildInvestmentScreenerDuckDbSummary({ dataRoot, market, source: investmentSourceForMarket(market) });
  return applyInvestmentScreenerFilters(payloadFromDuckDbSummary(summary), searchParams);
}

async function readInvestmentScreenerCoverage({ rankedFile, historyPool, dataRoot = null, searchParams = null }) {
  const market = safeMarket(searchParams?.get?.('market') ?? 'ASX');
  try {
    const postgresCoverage = await coverageFromPostgres(historyPool, market);
    if (postgresCoverage) return { statusCode: 200, payload: postgresCoverage };
  } catch {
    // Fall back to sanitized artifact metadata. Runtime DB failures are not public API data.
  }

  try {
    const duckDbCoverage = await coverageFromDuckDbDataRoot(dataRoot, market);
    if (duckDbCoverage) return { statusCode: 200, payload: duckDbCoverage };
  } catch {
    // Fall back to legacy ranked artifact. DuckDB rebuild diagnostics are not browser data.
  }

  if (!rankedFile) {
    return { statusCode: 503, payload: { error: 'investment_screener_not_configured', message: 'Investment screener ranked output file is not configured and coverage history is unavailable' } };
  }
  try {
    const info = await stat(rankedFile);
    if (!info.isFile()) {
      return { statusCode: 404, payload: { error: 'coverage_not_found', message: 'No investment screener coverage source has been generated yet' } };
    }
    const parsed = JSON.parse(await readFile(rankedFile, 'utf8'));
    return { statusCode: 200, payload: await coverageFromArtifact(parsed, info.mtime, market) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { statusCode: 404, payload: { error: 'coverage_not_found', message: 'No investment screener coverage source has been generated yet' } };
    }
    return { statusCode: 502, payload: { error: 'report_read_error', message: 'Unable to read investment screener coverage source' } };
  }
}

async function readInvestmentScreenerRanked({ rankedFile, historyPool, dataRoot = null, searchParams = null }) {
  if (dataRoot) {
    try {
      const duckDbResult = await rankedFromDuckDbDataRoot(dataRoot, searchParams);
      if (duckDbResult) return duckDbResult;
    } catch {
      // Continue to the sanitized legacy-file response; never leak DuckDB/NAS path diagnostics.
    }
  }
  if (!rankedFile) {
    return { statusCode: 503, payload: { error: 'investment_screener_not_configured', message: 'Investment screener ranked output file is not configured' } };
  }
  try {
    const info = await stat(rankedFile);
    if (!info.isFile()) {
      return { statusCode: 404, payload: { error: 'report_not_found', message: 'No investment screener ranked output has been generated yet' } };
    }
    const rawContent = await readFile(rankedFile, 'utf8');
    const parsed = JSON.parse(rawContent);
    const coverageResult = await readInvestmentScreenerCoverage({ rankedFile, historyPool, dataRoot, searchParams });
    const payload = sanitizeInvestmentRankedPayload(parsed, info.mtime);
    const enriched = coverageResult.statusCode === 200
      ? { ...payload, source_summary: coverageResult.payload.source_summary, coverage: coverageResult.payload.coverage }
      : payload;
    return applyInvestmentScreenerFilters(enriched, searchParams);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { statusCode: 404, payload: { error: 'report_not_found', message: 'No investment screener ranked output has been generated yet' } };
    }
    return { statusCode: 502, payload: { error: 'report_read_error', message: 'Unable to read investment screener ranked output' } };
  }
}

async function readInvestmentScreenerCompany({ dataRoot = null, ticker, searchParams = null }) {
  if (!dataRoot) {
    return { statusCode: 503, payload: { error: 'investment_screener_not_configured', message: 'Investment screener data root is not configured' } };
  }
  try {
    const detail = await readInvestmentScreenerCompanyDetail({
      dataRoot,
      ticker,
      market: safeMarket(searchParams?.get?.('market') ?? 'ASX'),
      source: investmentSourceForMarket(safeMarket(searchParams?.get?.('market') ?? 'ASX'))
    });
    return { statusCode: 200, payload: detail };
  } catch (err) {
    if (err?.code === 'invalid_ticker') {
      return { statusCode: 400, payload: { error: 'invalid_investment_screener_ticker', message: 'Investment screener ticker must be a plain market symbol.' } };
    }
    if (err?.code === 'not_found') {
      return { statusCode: 404, payload: { error: 'investment_screener_company_not_found', message: 'No company detail is available for that ticker in the latest screener artifacts.' } };
    }
    if (err?.code === 'not_configured') {
      return { statusCode: 503, payload: { error: 'investment_screener_not_configured', message: 'Investment screener data root is not configured' } };
    }
    return { statusCode: 502, payload: { error: 'investment_screener_company_read_error', message: 'Unable to read investment screener company detail' } };
  }
}

function getRunMetadataRows(dbPath, taskId) {
  return queryKanbanDb(
    dbPath,
    `SELECT profile, metadata FROM task_runs
     WHERE task_id = ${sqlString(taskId)}
       AND metadata IS NOT NULL
     ORDER BY id ASC`
  );
}

function getTaskRowsByIds(dbPath, taskIds) {
  const ids = uniqueTaskIds(taskIds);
  if (ids.length === 0) return [];
  const idsClause = ids.map(sqlString).join(',');
  const rows = queryKanbanDb(
    dbPath,
    `SELECT id, title, assignee, status, completed_at
     FROM tasks
     WHERE id IN (${idsClause})`
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => rowById.get(id)).filter(Boolean);
}

function getLinkedDependencyIds(dbPath, taskId) {
  return queryKanbanDb(
    dbPath,
    `WITH RECURSIVE deps(id, depth) AS (
       SELECT tl.parent_id, 1
       FROM task_links tl
       WHERE tl.child_id = ${sqlString(taskId)}
       UNION
       SELECT tl.parent_id, deps.depth + 1
       FROM task_links tl
       JOIN deps ON deps.id = tl.child_id
       WHERE deps.depth < 24
     )
     SELECT id FROM deps ORDER BY depth ASC, id ASC`
  ).map((row) => row.id);
}

function getLinkedDescendantIds(dbPath, taskId) {
  return queryKanbanDb(
    dbPath,
    `WITH RECURSIVE descendants(id, depth) AS (
       SELECT tl.child_id, 1
       FROM task_links tl
       WHERE tl.parent_id = ${sqlString(taskId)}
       UNION
       SELECT tl.child_id, descendants.depth + 1
       FROM task_links tl
       JOIN descendants ON descendants.id = tl.parent_id
       WHERE descendants.depth < 24
     )
     SELECT id FROM descendants ORDER BY depth ASC, id ASC`
  ).map((row) => row.id);
}

function epicSubtaskIds(dbPath, epic, metadataRows) {
  const graphIds = metadataTaskGraphIds(metadataRows);
  const childTaskIds = metadataChildTaskIds(metadataRows);
  const dependencyIds = getLinkedDependencyIds(dbPath, epic.id);
  if (metadataHasTaskGraph(metadataRows)) {
    return uniqueTaskIds([
      ...graphIds,
      ...getLinkedDescendantIds(dbPath, epic.id),
      ...dependencyIds,
      ...childTaskIds
    ], epic.id);
  }
  return uniqueTaskIds([...dependencyIds, ...childTaskIds], epic.id);
}

function latestCompletedAtForGraph(dbPath, epic, subtaskIds) {
  const subtasks = getTaskRowsByIds(dbPath, subtaskIds);
  let latest = Number(epic.completed_at ?? 0);
  for (const task of subtasks) {
    const completed = Number(task.completed_at ?? 0);
    if (Number.isFinite(completed) && completed > latest) latest = completed;
  }
  return latest;
}

function buildDashboardDocLink(doc) {
  return {
    label: doc.title ?? doc.id,
    url: `/api/docs/${encodeURIComponent(doc.id)}`,
    doc_id: doc.id
  };
}

/**
 * Build the epics response payload from the kanban DB.
 */
function getEpics(dbPath, docs = []) {
  const epicRows = queryKanbanDb(
    dbPath,
    `SELECT DISTINCT t.id, t.title, t.completed_at,
       CASE WHEN EXISTS (
         SELECT 1 FROM task_events te
         WHERE te.task_id = t.id AND te.kind = 'decomposed'
       ) THEN 1 ELSE 0 END AS has_decomposed_event,
       CASE WHEN EXISTS (
         SELECT 1 FROM task_runs tr
         WHERE tr.task_id = t.id
           AND tr.metadata IS NOT NULL
           AND json_valid(tr.metadata)
           AND json_type(tr.metadata, '$.task_graph') = 'object'
       ) THEN 1 ELSE 0 END AS has_task_graph
     FROM tasks t
     WHERE t.status = 'done'
       AND (
         EXISTS (
           SELECT 1 FROM task_events te
           WHERE te.task_id = t.id AND te.kind = 'decomposed'
         )
         OR EXISTS (
           SELECT 1 FROM task_runs tr
           WHERE tr.task_id = t.id
             AND tr.metadata IS NOT NULL
             AND json_valid(tr.metadata)
             AND json_type(tr.metadata, '$.task_graph') = 'object'
         )
         OR (
           EXISTS (SELECT 1 FROM task_links tl WHERE tl.child_id = t.id)
           AND NOT EXISTS (SELECT 1 FROM task_links tl WHERE tl.parent_id = t.id)
         )
       )
     ORDER BY t.completed_at DESC`
  );

  const epicCandidates = [];
  const graphSubtaskIds = new Set();
  for (const epic of epicRows) {
    const epicMetadataRows = getRunMetadataRows(dbPath, epic.id);
    const subtaskIds = epicSubtaskIds(dbPath, epic, epicMetadataRows);
    if (metadataHasTaskGraph(epicMetadataRows)) {
      for (const id of subtaskIds) graphSubtaskIds.add(id);
    }
    epicCandidates.push({ epic, epicMetadataRows, subtaskIds });
  }

  const docsByEpicId = new Map();
  for (const doc of docs) {
    if (doc?.epic_id && !docsByEpicId.has(doc.epic_id)) docsByEpicId.set(doc.epic_id, doc);
  }

  const epics = [];
  for (const candidate of epicCandidates) {
    const { epic, epicMetadataRows, subtaskIds } = candidate;
    if (!Number(epic.has_decomposed_event) && !Number(epic.has_task_graph) && graphSubtaskIds.has(epic.id)) {
      continue;
    }

    const subtasks = getTaskRowsByIds(dbPath, subtaskIds);
    const artifacts = [];
    for (const child of subtasks) {
      artifacts.push(...scribeMetadataArtifacts(child, getRunMetadataRows(dbPath, child.id)));
    }
    const dashboardDoc = docsByEpicId.get(epic.id);
    const docLinks = dashboardDoc ? [buildDashboardDocLink(dashboardDoc)] : [];
    docLinks.push(...buildDocLinks(artifacts));

    epics.push({
      id: epic.id,
      title: epic.title,
      completed_at: epic.completed_at ? new Date(epic.completed_at * 1000).toISOString() : null,
      subtasks: subtasks.map(({ id, title, assignee, status }) => ({ id, title, assignee, status })),
      doc_links: docLinks,
      _sort_completed_at: latestCompletedAtForGraph(dbPath, epic, subtaskIds)
    });
  }

  epics.sort((a, b) => b._sort_completed_at - a._sort_completed_at || String(a.id).localeCompare(String(b.id)));
  return epics.map(({ _sort_completed_at, ...epic }) => epic);
}



const UNIFIED_INBOX_CONNECTOR_STATES = new Set(['ok', 'healthy', 'up', 'configured', 'pending_credentials', 'not_configured', 'planned', 'excluded', 'error', 'down', 'stale', 'unknown']);

function sanitizeUnifiedInboxText(value, fallback = null, maxLength = 240) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/bearer|token|password|api[_-]?key|body_text|message_body|content|\/root\/|\/mnt\/nas|\/tmp\/|stderr|DATABASE_URL/i.test(trimmed)) {
    return fallback;
  }
  return trimmed.slice(0, maxLength);
}

function sanitizeUnifiedInboxState(value, fallback = 'unknown') {
  const state = sanitizeUnifiedInboxText(value, fallback, 64);
  return UNIFIED_INBOX_CONNECTOR_STATES.has(state) ? state : fallback;
}

function sanitizeUnifiedInboxTimestamp(value) {
  const textValue = sanitizeUnifiedInboxText(value, null, 80);
  if (!textValue) return null;
  const time = Date.parse(textValue);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function sanitizeUnifiedInboxConnector(connector = {}, fallback = {}) {
  const source = sanitizeUnifiedInboxText(connector.source ?? fallback.id ?? fallback.source, null, 80);
  const id = sanitizeUnifiedInboxText(connector.id ?? source, source, 80);
  const accountRef = sanitizeUnifiedInboxText(connector.account_ref ?? connector.accountRef, null, 120);
  return {
    id,
    source,
    label: sanitizeUnifiedInboxText(connector.label ?? fallback.label ?? source ?? id, 'Connector', 120),
    ...(accountRef ? { account_ref: accountRef } : {}),
    state: sanitizeUnifiedInboxState(connector.state ?? fallback.state, 'pending_credentials'),
    checked_at: sanitizeUnifiedInboxTimestamp(connector.checked_at),
    last_success_at: sanitizeUnifiedInboxTimestamp(connector.last_success_at),
    last_error_code: sanitizeUnifiedInboxText(connector.last_error_code, null, 80),
    detail: sanitizeUnifiedInboxText(connector.detail ?? fallback.detail, 'Connector status has not been published yet.', 240)
  };
}

function sanitizeUnifiedInboxStatus(raw = {}, config = {}) {
  const rawService = raw.service && typeof raw.service === 'object' ? raw.service : {};
  const rawSnapshots = raw.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots : {};
  const rawConnectors = Array.isArray(raw.connectors) ? raw.connectors : [];
  const fallbackConnectors = Array.isArray(config.expectedConnectors) ? config.expectedConnectors : [];
  const connectors = rawConnectors.length > 0
    ? rawConnectors.map((connector) => sanitizeUnifiedInboxConnector(connector)).filter((connector) => connector.id || connector.source)
    : fallbackConnectors.map((connector) => sanitizeUnifiedInboxConnector({}, connector));
  const exclusions = Array.isArray(raw.exclusions)
    ? raw.exclusions.map((entry) => ({
      source: sanitizeUnifiedInboxText(entry?.source, 'connector', 80),
      state: sanitizeUnifiedInboxState(entry?.state, 'excluded'),
      reason: sanitizeUnifiedInboxText(entry?.reason, null, 160)
    })).slice(0, 20)
    : [];
  const messageCount = Number(raw.message_count ?? 0);
  return {
    enabled: config.enabled !== false,
    service: {
      name: sanitizeUnifiedInboxText(rawService.name, 'unified-inbox', 80),
      mode: sanitizeUnifiedInboxText(rawService.mode, 'read_only', 40),
      status: sanitizeUnifiedInboxState(rawService.status, 'unknown')
    },
    connectors,
    message_count: Number.isInteger(messageCount) && messageCount >= 0 ? messageCount : 0,
    snapshots: {
      latest_batch_id: sanitizeUnifiedInboxText(rawSnapshots.latest_batch_id, null, 120),
      batch_id: sanitizeUnifiedInboxText(rawSnapshots.batch_id, null, 120),
      record_count: Number.isInteger(Number(rawSnapshots.record_count)) && Number(rawSnapshots.record_count) >= 0 ? Number(rawSnapshots.record_count) : 0,
      min_sent_at: sanitizeUnifiedInboxTimestamp(rawSnapshots.min_sent_at),
      max_sent_at: sanitizeUnifiedInboxTimestamp(rawSnapshots.max_sent_at),
      copy_status: sanitizeUnifiedInboxText(rawSnapshots.copy_status, null, 80),
      placements: {
        local_closed_snapshot: rawSnapshots.placements?.local_closed_snapshot === true,
        nas_snapshot: rawSnapshots.placements?.nas_snapshot === true,
        manifest: rawSnapshots.placements?.manifest === true
      }
    },
    exclusions,
    generatedAt: new Date().toISOString(),
    cacheStatus: 'fresh'
  };
}

async function readUnifiedInboxStatus({ config, statusUrl, fetchImpl = globalThis.fetch }) {
  if (!config?.enabled || !statusUrl) {
    return {
      statusCode: 200,
      payload: {
        enabled: false,
        service: { name: 'unified-inbox', mode: 'read_only', status: 'not_configured' },
        connectors: Array.isArray(config?.expectedConnectors) ? config.expectedConnectors.map((connector) => sanitizeUnifiedInboxConnector({}, connector)) : [],
        message_count: 0,
        snapshots: { latest_batch_id: null, batch_id: null, record_count: 0, min_sent_at: null, max_sent_at: null, copy_status: null, placements: { local_closed_snapshot: false, nas_snapshot: false, manifest: false } },
        exclusions: [],
        generatedAt: new Date().toISOString(),
        cacheStatus: 'not_configured',
        message: 'Unified Inbox backend status URL is not configured; showing pending connector setup.'
      }
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 1000);
  try {
    const response = await fetchImpl(statusUrl, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
    if (!response.ok) {
      return {
        statusCode: 200,
        payload: { ...sanitizeUnifiedInboxStatus({}, config), cacheStatus: 'backend_unavailable', service: { name: 'unified-inbox', mode: 'read_only', status: 'down' }, message: `Unified Inbox backend status returned HTTP ${response.status}.` }
      };
    }
    const raw = await response.json();
    return { statusCode: 200, payload: sanitizeUnifiedInboxStatus(raw, config) };
  } catch (err) {
    return {
      statusCode: 200,
      payload: { ...sanitizeUnifiedInboxStatus({}, config), cacheStatus: err?.name === 'AbortError' ? 'timeout' : 'read_error', service: { name: 'unified-inbox', mode: 'read_only', status: 'down' }, message: err?.name === 'AbortError' ? 'Unified Inbox backend status probe timed out.' : 'Unified Inbox backend status is unavailable.' }
    };
  } finally {
    clearTimeout(timeout);
  }
}

const MOBILE_RUNTIME_STATES = new Set(['not_running', 'booting', 'running', 'unknown']);
const MOBILE_CACHE_STATUSES = new Set(['fresh', 'not_configured', 'missing', 'malformed', 'read_error']);

function sanitizeMobileText(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/bearer|token|password|api[_-]?key|\/root\/|\/mnt\/nas|stderr|DATABASE_URL/i.test(trimmed)) {
    return fallback;
  }
  return trimmed.slice(0, 240);
}

function sanitizeMobileRuntime(rawRuntime = {}, fallbackRuntime = {}) {
  const rawState = sanitizeMobileText(rawRuntime.state, fallbackRuntime.state ?? 'unknown');
  const state = MOBILE_RUNTIME_STATES.has(rawState) ? rawState : 'unknown';
  const rawDevice = sanitizeMobileText(rawRuntime.adbDeviceId ?? rawRuntime.deviceId, fallbackRuntime.adbDeviceId ?? null);
  const adbDeviceId = rawDevice && (/^emulator-[0-9]{4,5}$/.test(rawDevice) || /^[A-Za-z0-9._:-]{3,64}$/.test(rawDevice))
    ? rawDevice
    : null;
  return {
    state,
    adbDeviceId,
    bootCompleted: rawRuntime.bootCompleted === true,
    detail: sanitizeMobileText(rawRuntime.detail, fallbackRuntime.detail ?? 'No emulator runtime detail has been published.')
  };
}

function sanitizeIsoTimestamp(value) {
  const textValue = sanitizeMobileText(value, null);
  if (!textValue) return null;
  const time = Date.parse(textValue);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function mobileWorkflowPayload({ config, statusFilePayload = null, cacheStatus, message, fileMtimeMs = null }) {
  if (!config?.enabled) {
    return {
      enabled: false,
      title: config?.title ?? 'Flutter mobile workflow',
      cacheStatus: 'not_configured',
      message: 'Flutter mobile workflow overview is not configured on this dashboard.'
    };
  }

  const runtime = sanitizeMobileRuntime(statusFilePayload?.runtime, config.runtime ?? {});
  const generatedAt = sanitizeIsoTimestamp(statusFilePayload?.generatedAt) ?? (fileMtimeMs ? new Date(fileMtimeMs).toISOString() : null);
  return {
    enabled: true,
    title: config.title,
    host: config.host,
    components: config.components,
    runtime,
    lastSuccessfulCycleAt: sanitizeIsoTimestamp(statusFilePayload?.lastSuccessfulCycleAt) ?? config.lastSuccessfulCycleAt ?? null,
    viewer: config.viewer,
    generatedAt,
    cacheStatus: MOBILE_CACHE_STATUSES.has(cacheStatus) ? cacheStatus : 'read_error',
    message: sanitizeMobileText(message, null)
  };
}

async function readMobileWorkflowStatus({ config, statusFile }) {
  if (!statusFile) {
    return {
      statusCode: 200,
      payload: mobileWorkflowPayload({
        config,
        cacheStatus: 'not_configured',
        message: 'No mobile workflow status cache is configured; showing the last reviewed desired state.'
      })
    };
  }

  try {
    const info = await stat(statusFile);
    if (!info.isFile()) {
      return {
        statusCode: 200,
        payload: mobileWorkflowPayload({
          config,
          cacheStatus: 'missing',
          message: 'Mobile workflow status cache is not a regular file; showing the last reviewed desired state.'
        })
      };
    }
    const parsed = JSON.parse(await readFile(statusFile, 'utf8'));
    return {
      statusCode: 200,
      payload: mobileWorkflowPayload({ config, statusFilePayload: parsed, cacheStatus: 'fresh', fileMtimeMs: info.mtimeMs })
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        statusCode: 200,
        payload: mobileWorkflowPayload({
          config,
          cacheStatus: 'missing',
          message: 'No mobile workflow status cache has been published yet; no emulator is assumed to be running.'
        })
      };
    }
    if (err instanceof SyntaxError) {
      return {
        statusCode: 502,
        payload: mobileWorkflowPayload({
          config,
          cacheStatus: 'malformed',
          message: 'Mobile workflow status cache is malformed; dashboard is using the last reviewed desired state.'
        })
      };
    }
    return {
      statusCode: 502,
      payload: mobileWorkflowPayload({
        config,
        cacheStatus: 'read_error',
        message: 'Unable to read mobile workflow status cache; dashboard is using the last reviewed desired state.'
      })
    };
  }
}

export async function createApp(options = {}) {
  const config = await loadConfig({ configPath: options.configPath });
  const authMode = options.authMode ?? process.env.DASHBOARD_AUTH_MODE ?? 'reverse-proxy';
  const proxyUserHeader = options.proxyUserHeader ?? process.env.DASHBOARD_PROXY_USER_HEADER ?? 'x-forwarded-user';
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const allowDisabledAuth = options.allowDisabledAuth ?? process.env.DASHBOARD_ALLOW_DISABLED_AUTH === 'true';
  const finnickReportFile = Object.prototype.hasOwnProperty.call(options, 'finnickReportFile')
    ? options.finnickReportFile
    : (process.env.FINNICK_REPORT_FILE ?? null);
  const homelabHealthReportFile = Object.prototype.hasOwnProperty.call(options, 'homelabHealthReportFile')
    ? options.homelabHealthReportFile
    : (process.env.HOMELAB_HEALTH_REPORT_FILE ?? null);
  const mobileWorkflowStatusFile = Object.prototype.hasOwnProperty.call(options, 'mobileWorkflowStatusFile')
    ? options.mobileWorkflowStatusFile
    : (process.env.MOBILE_WORKFLOW_STATUS_FILE ?? null);
  const mobileViewerUpstreamUrl = Object.prototype.hasOwnProperty.call(options, 'mobileViewerUpstreamUrl')
    ? options.mobileViewerUpstreamUrl
    : (process.env.MOBILE_VIEWER_UPSTREAM_URL ?? 'http://192.168.0.20:6080');
  const mobileViewerToken = Object.prototype.hasOwnProperty.call(options, 'mobileViewerToken')
    ? options.mobileViewerToken
    : (process.env.MOBILE_VIEWER_NOVNC_TOKEN ?? readOptionalSecretFile(process.env.MOBILE_VIEWER_NOVNC_TOKEN_FILE ?? '/run/secrets/mobile-viewer-novnc-token'));
  const unifiedInboxStatusUrl = Object.prototype.hasOwnProperty.call(options, 'unifiedInboxStatusUrl')
    ? options.unifiedInboxStatusUrl
    : (process.env.UNIFIED_INBOX_STATUS_URL ?? config.unifiedInbox?.statusUrl ?? null);
  const dashboardFetchImpl = options.fetchImpl ?? globalThis.fetch;
  const investmentScreenerReportFile = Object.prototype.hasOwnProperty.call(options, 'investmentScreenerReportFile')
    ? options.investmentScreenerReportFile
    : (process.env.INVESTMENT_SCREENER_REPORT_FILE ?? null);
  const investmentScreenerRankedFile = Object.prototype.hasOwnProperty.call(options, 'investmentScreenerRankedFile')
    ? options.investmentScreenerRankedFile
    : (process.env.INVESTMENT_SCREENER_RANKED_FILE ?? null);
  const investmentScreenerDataRoot = Object.prototype.hasOwnProperty.call(options, 'investmentScreenerDataRoot')
    ? options.investmentScreenerDataRoot
    : (process.env.INVESTMENT_SCREENER_DATA_ROOT ?? process.env.SCREENER_DATA_ROOT ?? null);
  const investmentScreenerHistoryPool = Object.prototype.hasOwnProperty.call(options, 'investmentScreenerHistoryPool')
    ? options.investmentScreenerHistoryPool
    : await createInvestmentScreenerHistoryPool(process.env.INVESTMENT_SCREENER_DATABASE_URL ?? null);
  const kanbanDbPath = Object.prototype.hasOwnProperty.call(options, 'kanbanDbPath')
    ? options.kanbanDbPath
    : resolveKanbanDbPath(undefined);
  const kanbanMutationsEnabled = Object.prototype.hasOwnProperty.call(options, 'kanbanMutationsEnabled')
    ? options.kanbanMutationsEnabled === true
    : process.env.KANBAN_MUTATIONS_ENABLED === 'true';
  const kanbanCommandPath = options.kanbanCommandPath ?? process.env.KANBAN_COMMAND_PATH ?? 'hermes';
  const kanbanCommandHealthArgs = Object.prototype.hasOwnProperty.call(options, 'kanbanCommandHealthArgs')
    ? parseKanbanCommandHealthArgs(options.kanbanCommandHealthArgs)
    : parseKanbanCommandHealthArgs(process.env.KANBAN_COMMAND_HEALTH_ARGS);
  const docsManifest = Object.prototype.hasOwnProperty.call(options, 'docsManifest')
    ? options.docsManifest
    : null;
  const epicDocsIndexPath = options.epicDocsIndexPath ?? process.env.EPIC_DOCS_INDEX_PATH ?? DEFAULT_EPIC_DOCS_INDEX;
  const repoDocsRoot = options.repoDocsRoot ?? process.env.REPO_DOCS_ROOT ?? DEFAULT_REPO_DOCS_ROOT;
  const writingPostsFile = Object.prototype.hasOwnProperty.call(options, 'writingPostsFile')
    ? options.writingPostsFile
    : (process.env.WRITING_POSTS_FILE ?? DEFAULT_WRITING_POSTS_FILE);
  const datasetsRoot = Object.prototype.hasOwnProperty.call(options, 'datasetsRoot')
    ? options.datasetsRoot
    : (process.env.DATASETS_ROOT ?? DEFAULT_DATASETS_ROOT);
  const datasetRegistry = Object.prototype.hasOwnProperty.call(options, 'datasetRegistry')
    ? options.datasetRegistry
    : DEFAULT_DATASET_REGISTRY;
  const personalDataDatabaseUrl = Object.prototype.hasOwnProperty.call(options, 'personalDataDatabaseUrl')
    ? options.personalDataDatabaseUrl
    : (process.env.PERSONAL_DASHBOARD_DATABASE_URL ?? null);
  const personalDataPostgresPool = Object.prototype.hasOwnProperty.call(options, 'personalDataPostgresPool')
    ? options.personalDataPostgresPool
    : null;
  assertSafeAuth({ authMode, nodeEnv, allowDisabledAuth });

  const personalDataState = createPersonalDataState({
    postgresConnectionString: personalDataDatabaseUrl,
    postgresPool: personalDataPostgresPool,
    postgresSsl: process.env.PGSSLMODE === 'disable' ? false : undefined
  });

  const statusService = new StatusService({
    checks: config.statusChecks,
    ttlMs: options.statusCacheTtlMs ?? Number(process.env.DASHBOARD_STATUS_CACHE_TTL_MS ?? 30_000),
    timeoutMs: options.statusProbeTimeoutMs ?? Number(process.env.DASHBOARD_STATUS_PROBE_TIMEOUT_MS ?? 2500),
    fetchImpl: dashboardFetchImpl
  });

  const dashboardApp = async function dashboardApp(request, response) {
    const url = new URL(request.url, 'http://dashboard.local');

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json(response, 200, { status: 'ok' });
    }

    if (url.pathname === MOBILE_VIEWER_PREFIX || url.pathname.startsWith(`${MOBILE_VIEWER_PREFIX}/`)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return text(response, 405, 'Method not allowed');
      }
      return proxyMobileViewerHttp(request, response, {
        authMode,
        proxyUserHeader,
        upstreamUrl: mobileViewerUpstreamUrl
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!isAuthorized(request, { authMode, proxyUserHeader })) {
        return json(response, 401, { error: 'unauthorized' });
      }

      if (request.method === 'GET' && url.pathname === '/api/config/public') {
        return json(response, 200, toPublicConfig(config));
      }

      if (request.method === 'GET' && url.pathname === '/api/status') {
        return json(response, 200, await statusService.getStatus());
      }

      if (request.method === 'GET' && url.pathname === '/api/mobile-workflow/status') {
        const result = await readMobileWorkflowStatus({ config: config.mobileWorkflow, statusFile: mobileWorkflowStatusFile });
        return json(response, result.statusCode, result.payload);
      }

      if (request.method === 'GET' && url.pathname === '/api/unified-inbox/status') {
        const result = await readUnifiedInboxStatus({ config: config.unifiedInbox, statusUrl: unifiedInboxStatusUrl, fetchImpl: dashboardFetchImpl });
        return json(response, result.statusCode, result.payload);
      }

      if (request.method === 'GET' && url.pathname === '/api/finnick/report') {
        if (!finnickReportFile) {
          return json(response, 503, { error: 'finnick_not_configured', message: 'FINNICK_REPORT_FILE is not set' });
        }
        try {
          const info = await stat(finnickReportFile);
          if (!info.isFile()) {
            return json(response, 404, { error: 'report_not_found', message: 'Finnick report path is not a regular file' });
          }
          const content = await readFile(finnickReportFile, 'utf8');
          return json(response, 200, { content: content.trim() });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return json(response, 404, { error: 'report_not_found', message: 'No Finnick report has been generated yet' });
          }
          return json(response, 502, { error: 'report_read_error', message: 'Unable to read Finnick report' });
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/homelab/health') {
        if (!homelabHealthReportFile) {
          return json(response, 503, { error: 'not_configured', message: 'HOMELAB_HEALTH_REPORT_FILE is not set' });
        }
        try {
          const info = await stat(homelabHealthReportFile);
          if (!info.isFile()) {
            return json(response, 404, { error: 'not_found', message: 'No report yet — check back after the 08:00 AEST cron runs.' });
          }
          const fetched_at = new Date().toISOString();
          const age_hours = (Date.now() - info.mtimeMs) / 3_600_000;
          const raw = await readFile(homelabHealthReportFile, 'utf8');
          const content = raw.trim();
          if (!content) {
            return json(response, 200, {
              state: 'empty',
              content: '',
              generated_at: null,
              fetched_at,
              alert_count: null,
              age_hours: Math.round(age_hours * 10) / 10
            });
          }
          // Parse generated_at from first line: "Homelab health report - <ISO8601>"
          const firstLine = content.split('\n')[0] ?? '';
          const genMatch = firstLine.match(/Homelab health report\s*-\s*(\S+)/i);
          const generated_at = genMatch ? genMatch[1] : null;
          // Parse alert_count from Summary section: "- Alerts: N"
          const alertMatch = content.match(/^\s*-\s*Alerts:\s*(\d+)/m);
          const alert_count = alertMatch ? parseInt(alertMatch[1], 10) : null;
          const stale = age_hours >= 26;
          const degraded = !stale && typeof alert_count === 'number' && alert_count > 0;
          const state = stale ? 'stale' : degraded ? 'degraded' : 'ok';
          return json(response, 200, {
            state,
            content,
            generated_at,
            fetched_at,
            alert_count,
            age_hours: Math.round(age_hours * 10) / 10
          });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return json(response, 404, { error: 'not_found', message: 'No report yet — check back after the 08:00 AEST cron runs.' });
          }
          return json(response, 502, { error: 'read_error', message: 'Unable to read homelab health report.' });
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/investment-screener/report') {
        const result = await readInvestmentScreenerReport(investmentScreenerReportFile, investmentScreenerDataRoot);
        return json(response, result.statusCode, result.payload);
      }

      if (request.method === 'GET' && url.pathname === '/api/investment-screener/coverage') {
        const result = await readInvestmentScreenerCoverage({ rankedFile: investmentScreenerRankedFile, historyPool: investmentScreenerHistoryPool, dataRoot: investmentScreenerDataRoot, searchParams: url.searchParams });
        return json(response, result.statusCode, result.payload);
      }

      if (request.method === 'GET' && url.pathname === '/api/investment-screener/ranked') {
        const result = await readInvestmentScreenerRanked({ rankedFile: investmentScreenerRankedFile, historyPool: investmentScreenerHistoryPool, dataRoot: investmentScreenerDataRoot, searchParams: url.searchParams });
        return json(response, result.statusCode, result.payload);
      }

      const investmentCompanyMatch = /^\/api\/investment-screener\/company\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && investmentCompanyMatch) {
        const ticker = decodePathSegment(investmentCompanyMatch[1]);
        if (ticker === null) {
          return json(response, 400, { error: 'invalid_investment_screener_ticker', message: 'Investment screener ticker is not valid.' });
        }
        const result = await readInvestmentScreenerCompany({ dataRoot: investmentScreenerDataRoot, ticker, searchParams: url.searchParams });
        return json(response, result.statusCode, result.payload);
      }

      if (url.pathname === '/api/writing/posts') {
        if (request.method === 'GET') {
          const result = await readWritingPosts({ writingPostsFile, searchParams: url.searchParams });
          return json(response, result.statusCode, result.payload);
        }
        if (request.method === 'POST') {
          try {
            const body = await readJsonBody(request, MAX_WRITING_BODY_BYTES);
            const result = await createWritingPost({ writingPostsFile, body });
            return json(response, result.statusCode, result.payload);
          } catch (err) {
            const result = safePublicWritingError(err);
            return json(response, result.statusCode, result.payload);
          }
        }
        return json(response, 405, { error: 'method_not_allowed' });
      }

      const writingPostMatch = /^\/api\/writing\/posts\/([^/]+)$/.exec(url.pathname);
      if (writingPostMatch) {
        const postId = decodePathSegment(writingPostMatch[1]);
        if (postId === null) {
          return json(response, 400, { error: 'invalid_writing_post_id', message: 'Writing post id is not valid.' });
        }
        if (request.method === 'GET') {
          const result = await readWritingPost({ writingPostsFile, postId });
          return json(response, result.statusCode, result.payload);
        }
        if (request.method === 'PATCH') {
          try {
            const body = await readJsonBody(request, MAX_WRITING_BODY_BYTES);
            const result = await updateWritingPost({ writingPostsFile, postId, body });
            return json(response, result.statusCode, result.payload);
          } catch (err) {
            const result = safePublicWritingError(err);
            return json(response, result.statusCode, result.payload);
          }
        }
        if (request.method === 'DELETE') {
          try {
            const result = await deleteWritingPost({ writingPostsFile, postId });
            return json(response, result.statusCode, result.payload);
          } catch (err) {
            const result = safePublicWritingError(err);
            return json(response, result.statusCode, result.payload);
          }
        }
        return json(response, 405, { error: 'method_not_allowed' });
      }

      if (url.pathname === '/api/datasets') {
        if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' });
        const result = await readDatasetList({ datasetRegistry, datasetsRoot });
        return json(response, result.statusCode, result.payload);
      }

      const datasetRecordsMatch = /^\/api\/datasets\/([^/]+)\/records$/.exec(url.pathname);
      if (datasetRecordsMatch) {
        if (request.method === 'POST') {
          return json(response, 405, {
            error: 'dataset_append_disabled',
            message: 'Dataset append/create are deferred until storage, locking, backups, and restore behavior are reviewed.'
          });
        }
        if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' });
        const result = await readDatasetRecords({ datasetRegistry, datasetsRoot, datasetId: decodeURIComponent(datasetRecordsMatch[1]), searchParams: url.searchParams });
        return json(response, result.statusCode, result.payload);
      }

      const diaryEntryMatch = /^\/api\/diary\/entries\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === '/api/diary/entries' || diaryEntryMatch) {
        const personalData = await personalDataState.getStore();
        if (!personalData.configured) {
          return json(response, 503, personalDataNotConfiguredPayload());
        }
        if (personalData.unavailable || !personalData.store) {
          return json(response, 503, personalDataUnavailablePayload());
        }

        if (request.method === 'GET' && url.pathname === '/api/diary/entries') {
          try {
            const params = parseDiaryListParams(url.searchParams);
            return json(response, 200, { entries: await personalData.store.listDiaryEntries(params), ...params });
          } catch (err) {
            const result = safePublicDiaryError(err);
            return json(response, result.statusCode, result.payload);
          }
        }

        if (request.method === 'POST' && url.pathname === '/api/diary/entries') {
          try {
            const body = await readJsonBody(request, MAX_DIARY_BODY_BYTES);
            const entry = await personalData.store.createDiaryEntry(body);
            return json(response, 201, { entry });
          } catch (err) {
            const result = safePublicDiaryError(err);
            return json(response, result.statusCode, result.payload);
          }
        }

        if (request.method === 'GET' && diaryEntryMatch) {
          try {
            const entry = await personalData.store.getDiaryEntry(decodeURIComponent(diaryEntryMatch[1]));
            if (!entry) return json(response, 404, { error: 'diary_entry_not_found', message: 'Diary entry was not found' });
            return json(response, 200, { entry });
          } catch (err) {
            const result = safePublicDiaryError(err);
            return json(response, result.statusCode, result.payload);
          }
        }

        return json(response, 405, { error: 'method_not_allowed' });
      }


      const goalMatch = /^\/api\/goals\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === '/api/goals' || goalMatch) {
        const personalData = await personalDataState.getStore();
        if (!personalData.configured) {
          return json(response, 503, personalDataNotConfiguredPayload());
        }
        if (personalData.unavailable || !personalData.store) {
          return json(response, 503, personalDataUnavailablePayload());
        }

        if (request.method === 'GET' && url.pathname === '/api/goals') {
          try {
            const params = parseGoalListParams(url.searchParams);
            return json(response, 200, { goals: await personalData.store.listGoals(params), ...params });
          } catch (err) {
            const result = safePublicGoalError(err);
            return json(response, result.statusCode, result.payload);
          }
        }

        if (request.method === 'POST' && url.pathname === '/api/goals') {
          try {
            const body = await readJsonBody(request, MAX_GOAL_BODY_BYTES);
            const goal = await personalData.store.createGoal(body);
            return json(response, 201, { goal });
          } catch (err) {
            const result = safePublicGoalError(err);
            return json(response, result.statusCode, result.payload);
          }
        }

        if (request.method === 'GET' && goalMatch) {
          try {
            const goal = await personalData.store.getGoal(decodeURIComponent(goalMatch[1]));
            if (!goal) return json(response, 404, { error: 'goal_not_found', message: 'Goal was not found' });
            return json(response, 200, { goal });
          } catch (err) {
            const result = safePublicGoalError(err);
            return json(response, result.statusCode, result.payload);
          }
        }

        if (request.method === 'PATCH' && goalMatch) {
          try {
            const body = await readJsonBody(request, MAX_GOAL_BODY_BYTES);
            const goal = await personalData.store.updateGoal(decodeURIComponent(goalMatch[1]), body);
            if (!goal) return json(response, 404, { error: 'goal_not_found', message: 'Goal was not found' });
            return json(response, 200, { goal });
          } catch (err) {
            const result = safePublicGoalError(err);
            return json(response, result.statusCode, result.payload);
          }
        }

        return json(response, 405, { error: 'method_not_allowed' });
      }

      if (request.method === 'GET' && url.pathname === '/api/docs') {
        return json(response, 200, { documents: await availableDocs(docsManifest, repoDocsRoot, epicDocsIndexPath) });
      }

      const docMatch = /^\/api\/docs\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && docMatch) {
        const docId = decodeURIComponent(docMatch[1]);
        if (!DOC_ID_PATTERN.test(docId)) {
          return json(response, 404, { error: 'document_not_found' });
        }
        const doc = approvedReadableDocs(docsManifest, epicDocsIndexPath).find((candidate) => candidate.id === docId);
        if (!doc) {
          return json(response, 404, { error: 'document_not_found' });
        }
        try {
          const content = await readApprovedDoc(doc, repoDocsRoot);
          return json(response, 200, { ...doc, content });
        } catch {
          return json(response, 404, { error: 'document_not_found' });
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/epics') {
        if (!kanbanDbPath) {
          return json(response, 503, kanbanDbUnavailablePayload());
        }
        try {
          const info = await stat(kanbanDbPath);
          if (!info.isFile()) {
            return json(response, 503, kanbanDbUnavailablePayload());
          }
        } catch {
          return json(response, 503, kanbanDbUnavailablePayload());
        }
        try {
          const docs = await availableReadableDocs(docsManifest, repoDocsRoot, epicDocsIndexPath);
          const epics = getEpics(kanbanDbPath, docs);
          return json(response, 200, { epics });
        } catch {
          return json(response, 503, kanbanDbUnavailablePayload());
        }
      }

      return json(response, 404, { error: 'not_found' });
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      return serveStatic(request, response);
    }

    return json(response, 405, { error: 'method_not_allowed' });
  };

  dashboardApp.handleUpgrade = (request, socket, head) => handleMobileViewerUpgrade(request, socket, head, {
    authMode,
    proxyUserHeader,
    upstreamUrl: mobileViewerUpstreamUrl,
    token: mobileViewerToken
  });

  return dashboardApp;
}

export async function main() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 4322);
  const host = process.env.HOST ?? '0.0.0.0';
  const server = http.createServer(app);
  if (typeof app.handleUpgrade === 'function') {
    server.on('upgrade', app.handleUpgrade);
  }
  server.listen(port, host, () => {
    console.log(`personal-dashboard listening on ${host}:${port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
