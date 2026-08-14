import { accessSync, constants, createReadStream, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadConfig, toPublicConfig } from './config.js';
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
  { id: 'investment-screener-overview', title: 'Investment Screener Product Guide', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/README.md' },
  { id: 'investment-screener-cli-generator', title: 'Investment Screener CLI and Generator', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/cli-generator.md' },
  { id: 'investment-screener-dashboard-panel', title: 'Investment Screener Dashboard Panel', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/dashboard-panel.md' },
  { id: 'investment-screener-interpreting-results', title: 'Interpreting Investment Screener Results', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/interpreting-results.md' },
  { id: 'investment-screener-operations-limitations', title: 'Investment Screener Operations and Limitations', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/operations-limitations.md' },
  { id: 'service-catalog', title: 'Service Catalog', category: 'Operations', path: 'docs/service-catalog.md' },
  { id: 'backup-coverage', title: 'Backup Coverage Matrix', category: 'Operations', path: 'docs/backup-coverage-matrix.md' }
];
const DEFAULT_EPIC_DOCS_INDEX = resolve(__dirname, '..', 'docs', 'epics', 'index.json');
const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DOC_CONTENT_MAX_BYTES = 192 * 1024;
const RUNTIME_DOC_FORBIDDEN_PATTERNS = [
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

async function initPersonalDataStore({ postgresConnectionString, postgresPool, postgresSsl } = {}) {
  if (postgresConnectionString || postgresPool) {
    try {
      return { store: await createPostgresPersonalDataStore({ connectionString: postgresConnectionString, pool: postgresPool, ssl: postgresSsl }), unavailable: false, configured: true };
    } catch (err) {
      if (typeof console?.warn === 'function') {
        console.warn('Personal dashboard Postgres data store unavailable', { code: err?.code, name: err?.name });
      }
      return { store: null, unavailable: true, configured: true };
    }
  }
  return { store: null, unavailable: false, configured: false };
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

function defaultDocsManifest(epicDocsIndexPath = DEFAULT_EPIC_DOCS_INDEX) {
  return [...DEFAULT_DOCS_MANIFEST, ...loadEpicDocsIndex(epicDocsIndexPath)];
}

function docsManifestFromOption(value, epicDocsIndexPath) {
  return Array.isArray(value) ? value : defaultDocsManifest(epicDocsIndexPath);
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
  for (const doc of approvedDocs(manifest, epicDocsIndexPath)) {
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


const INVESTMENT_SCREENER_DISCLAIMER = 'Informational screener output only; not financial advice or a trading recommendation.';
const INVESTMENT_SCREENER_CANDIDATE_LIMIT = 25;
const INVESTMENT_SCREENER_REPORT_MAX_BYTES = 96 * 1024;
const INVESTMENT_SCREENER_REPORT_MAX_CHARS = 48 * 1024;
const INVESTMENT_SCREENER_DOC_LINKS = [
  { label: 'Investment screener product guide', url: '/api/docs/investment-screener-overview', doc_id: 'investment-screener-overview' },
  { label: 'Interpreting screener results', url: '/api/docs/investment-screener-interpreting-results', doc_id: 'investment-screener-interpreting-results' },
  { label: 'Investment screener operations', url: '/api/docs/investment-screener-operations-limitations', doc_id: 'investment-screener-operations-limitations' }
];
const INVESTMENT_SCREENER_MODE_VALUES = new Set(['fixture', 'live', 'unknown']);
const INVESTMENT_SCREENER_FILTERABLE_FIELDS = new Set(['market']);
const INVESTMENT_SCREENER_UNAVAILABLE_FIELDS = new Set(['exchange', 'region', 'sector', 'industry']);
const INVESTMENT_SCREENER_METRIC_VALUES = new Set(['composite', 'quality', 'valuation', 'growth', 'graham_safety', 'durability', 'risk_adjustments']);
const INVESTMENT_SCREENER_WEIGHT_VALUES = new Set(['balanced', 'quality', 'valuation', 'growth', 'graham_safety', 'durability', 'risk_adjustments']);
const INVESTMENT_SCREENER_QUERY_KEYS = new Set(['market', 'exchange', 'region', 'sector', 'industry', 'metric', 'weight', 'topN']);

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
  const text = safeText(value, null, 80);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function safeMode(value) {
  const mode = safeText(value, 'unknown', 40);
  return INVESTMENT_SCREENER_MODE_VALUES.has(mode) ? mode : 'unknown';
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
  return {
    rank: rank ?? index + 1,
    ticker: ticker ?? 'UNKNOWN',
    name: name ?? ticker ?? 'Unknown candidate',
    market: safeText(candidate.market, null, 80),
    currency: safeText(candidate.currency, null, 16),
    score,
    sub_scores: safeSubScores(candidate.sub_scores),
    missing_penalty_points: safeNumber(candidate.missing_penalty_points),
    risk_flags: safeTextArray(candidate.risk_flags),
    caveats: safeTextArray(candidate.caveats),
    score_caps: safeScoreCaps(candidate.score_caps),
    sanitized_provenance_summary: safeText(candidate.sanitized_provenance_summary, null, 300)
  };
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
    ? source.candidates.map((candidate, index) => sanitizeInvestmentCandidate(candidate, index)).filter(Boolean).slice(0, INVESTMENT_SCREENER_CANDIDATE_LIMIT)
    : [];
  const excluded = Array.isArray(source.excluded)
    ? source.excluded.map((candidate, index) => sanitizeInvestmentCandidate(candidate, index)).filter(Boolean).slice(0, INVESTMENT_SCREENER_CANDIDATE_LIMIT)
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

  for (const field of INVESTMENT_SCREENER_UNAVAILABLE_FIELDS) {
    const value = searchParams.get(field);
    if (value && value.trim()) {
      return investmentFilterError('unsupported_investment_screener_filter', `${field} filtering is not available in the sanitized ranked output yet.`);
    }
  }

  for (const field of INVESTMENT_SCREENER_FILTERABLE_FIELDS) {
    const value = safeText(searchParams.get(field), null, 80);
    if (value) {
      if (!/^[a-z0-9][a-z0-9 ._-]{0,79}$/i.test(value)) {
        return investmentFilterError('invalid_investment_screener_filter', 'Investment screener filter values must use plain market labels.');
      }
      applied[field] = value;
    } else if (searchParams.has(field) && String(searchParams.get(field) ?? '').trim()) {
      return investmentFilterError('invalid_investment_screener_filter', 'Investment screener filter values must use plain market labels.');
    }
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

  const topNRaw = searchParams.get('topN');
  if (topNRaw !== null && topNRaw !== '') {
    const topN = Number(topNRaw);
    if (!Number.isInteger(topN) || topN < 1 || topN > INVESTMENT_SCREENER_CANDIDATE_LIMIT) {
      return investmentFilterError('invalid_investment_screener_filter', `topN must be an integer from 1 to ${INVESTMENT_SCREENER_CANDIDATE_LIMIT}.`);
    }
    applied.topN = topN;
  }

  return { applied, active: Object.keys(applied).length > 0 || [...searchParams.keys()].length > 0 };
}

function applyInvestmentScreenerFilters(payload, searchParams) {
  const parsed = readInvestmentFilterParams(searchParams);
  if (parsed.statusCode) return parsed;
  if (!parsed.active) return { statusCode: 200, payload };

  const { applied } = parsed;
  let candidates = [...payload.candidates];
  const messages = [];

  if (applied.market) {
    const wanted = applied.market.toLowerCase();
    candidates = candidates.filter((candidate) => String(candidate.market ?? '').toLowerCase() === wanted);
  }

  const sortMetric = applied.metric ?? (applied.weight && applied.weight !== 'balanced' ? applied.weight : null);
  if (sortMetric) {
    candidates.sort((left, right) => {
      const leftScore = safeNumber(left.sub_scores?.[sortMetric]) ?? Number.NEGATIVE_INFINITY;
      const rightScore = safeNumber(right.sub_scores?.[sortMetric]) ?? Number.NEGATIVE_INFINITY;
      return rightScore - leftScore || (safeNumber(left.rank) ?? 0) - (safeNumber(right.rank) ?? 0);
    });
  }

  const topN = applied.topN ?? 6;
  candidates = candidates.slice(0, topN);
  if (candidates.length === 0) {
    messages.push('No candidates match the selected investment screener filters. Try clearing one filter or waiting for richer ranked data.');
  } else {
    messages.push(`Showing ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} after the selected filters.`);
  }

  return {
    statusCode: 200,
    payload: {
      ...payload,
      candidates,
      applied_filters: applied,
      messages
    }
  };
}

async function readInvestmentScreenerReport(reportFile) {
  if (!reportFile) {
    return { statusCode: 503, payload: { error: 'investment_screener_not_configured', message: 'Investment screener report file is not configured' } };
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
    return {
      statusCode: 200,
      payload: {
        mode: 'live',
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

async function readInvestmentScreenerRanked(rankedFile, searchParams = null) {
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
    const payload = sanitizeInvestmentRankedPayload(parsed, info.mtime);
    return applyInvestmentScreenerFilters(payload, searchParams);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { statusCode: 404, payload: { error: 'report_not_found', message: 'No investment screener ranked output has been generated yet' } };
    }
    return { statusCode: 502, payload: { error: 'report_read_error', message: 'Unable to read investment screener ranked output' } };
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

export async function createApp(options = {}) {
  const config = await loadConfig({ configPath: options.configPath });
  const authMode = options.authMode ?? process.env.DASHBOARD_AUTH_MODE ?? 'reverse-proxy';
  const proxyUserHeader = options.proxyUserHeader ?? process.env.DASHBOARD_PROXY_USER_HEADER ?? 'x-forwarded-user';
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const allowDisabledAuth = options.allowDisabledAuth ?? process.env.DASHBOARD_ALLOW_DISABLED_AUTH === 'true';
  const finnickReportFile = Object.prototype.hasOwnProperty.call(options, 'finnickReportFile')
    ? options.finnickReportFile
    : (process.env.FINNICK_REPORT_FILE ?? null);
  const investmentScreenerReportFile = Object.prototype.hasOwnProperty.call(options, 'investmentScreenerReportFile')
    ? options.investmentScreenerReportFile
    : (process.env.INVESTMENT_SCREENER_REPORT_FILE ?? null);
  const investmentScreenerRankedFile = Object.prototype.hasOwnProperty.call(options, 'investmentScreenerRankedFile')
    ? options.investmentScreenerRankedFile
    : (process.env.INVESTMENT_SCREENER_RANKED_FILE ?? null);
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
  const personalDataDatabaseUrl = Object.prototype.hasOwnProperty.call(options, 'personalDataDatabaseUrl')
    ? options.personalDataDatabaseUrl
    : (process.env.PERSONAL_DASHBOARD_DATABASE_URL ?? null);
  const personalDataPostgresPool = Object.prototype.hasOwnProperty.call(options, 'personalDataPostgresPool')
    ? options.personalDataPostgresPool
    : null;
  assertSafeAuth({ authMode, nodeEnv, allowDisabledAuth });

  const personalData = await initPersonalDataStore({
    postgresConnectionString: personalDataDatabaseUrl,
    postgresPool: personalDataPostgresPool,
    postgresSsl: process.env.PGSSLMODE === 'disable' ? false : undefined
  });

  const statusService = new StatusService({
    checks: config.statusChecks,
    ttlMs: options.statusCacheTtlMs ?? Number(process.env.DASHBOARD_STATUS_CACHE_TTL_MS ?? 30_000),
    timeoutMs: options.statusProbeTimeoutMs ?? Number(process.env.DASHBOARD_STATUS_PROBE_TIMEOUT_MS ?? 2500)
  });

  return async function dashboardApp(request, response) {
    const url = new URL(request.url, 'http://dashboard.local');

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json(response, 200, { status: 'ok' });
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

      if (request.method === 'GET' && url.pathname === '/api/investment-screener/report') {
        const result = await readInvestmentScreenerReport(investmentScreenerReportFile);
        return json(response, result.statusCode, result.payload);
      }

      if (request.method === 'GET' && url.pathname === '/api/investment-screener/ranked') {
        const result = await readInvestmentScreenerRanked(investmentScreenerRankedFile, url.searchParams);
        return json(response, result.statusCode, result.payload);
      }

      const diaryEntryMatch = /^\/api\/diary\/entries\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === '/api/diary/entries' || diaryEntryMatch) {
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
        const doc = approvedDocs(docsManifest, epicDocsIndexPath).find((candidate) => candidate.id === docId);
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

      if (request.method === 'GET' && url.pathname === '/api/kanban/board') {
        const availability = kanbanMutationAvailability({
          requested: kanbanMutationsEnabled,
          commandPath: kanbanCommandPath,
          healthArgs: kanbanCommandHealthArgs
        });
        const mutations = { enabled: availability.enabled, supported_statuses: KANBAN_SAFE_MOVE_STATUSES };
        if (!kanbanDbPath) {
          return json(response, 503, kanbanDbUnavailablePayload({ lanes: emptyKanbanLanes(), mutations }));
        }
        try {
          const info = await stat(kanbanDbPath);
          if (!info.isFile()) {
            return json(response, 503, kanbanDbUnavailablePayload({ lanes: emptyKanbanLanes(), mutations }));
          }
        } catch {
          return json(response, 503, kanbanDbUnavailablePayload({ lanes: emptyKanbanLanes(), mutations }));
        }
        try {
          return json(response, 200, { lanes: getKanbanBoard(kanbanDbPath), mutations });
        } catch {
          return json(response, 503, kanbanDbUnavailablePayload({ lanes: emptyKanbanLanes(), mutations }));
        }
      }

      const moveMatch = /^\/api\/kanban\/tasks\/([^/]+)\/move$/.exec(url.pathname);
      if (moveMatch) {
        if (request.method !== 'POST') {
          return json(response, 405, { error: 'method_not_allowed' });
        }

        const taskId = moveMatch[1];
        if (!TASK_ID_PATTERN.test(taskId)) {
          return json(response, 400, { error: 'invalid_task_id', message: 'Task id must match t_[0-9a-f]+' });
        }

        let body;
        try {
          body = await readJsonBody(request);
        } catch (err) {
          return json(response, err.statusCode ?? 400, { error: err.code ?? 'invalid_request', message: err.message });
        }

        const command = commandForKanbanMove(taskId, body);
        if (command.error) {
          return json(response, command.statusCode, { error: command.error, message: command.message });
        }

        const availability = kanbanMutationAvailability({
          requested: kanbanMutationsEnabled,
          commandPath: kanbanCommandPath,
          healthArgs: kanbanCommandHealthArgs
        });
        if (!availability.enabled) {
          return json(response, 503, {
            error: availability.error,
            message: availability.error === 'kanban_mutations_unavailable'
              ? 'Kanban mutations are unavailable for this dashboard. Check server-side command configuration.'
              : 'Kanban mutations are disabled for this dashboard. Set KANBAN_MUTATIONS_ENABLED=true and configure KANBAN_COMMAND_PATH to enable safe CLI-backed moves.'
          });
        }

        try {
          runKanbanCommand(kanbanCommandPath, command.args);
          return json(response, 200, { ok: true, id: taskId, status: body.status });
        } catch (err) {
          logKanbanMutationDiagnostic('command_failed', err);
          return json(response, 502, {
            error: 'kanban_command_failed',
            message: 'Kanban command failed. Check server logs for details.'
          });
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
          const docs = await availableDocs(docsManifest, repoDocsRoot, epicDocsIndexPath);
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
}

export async function main() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 4322);
  const host = process.env.HOST ?? '0.0.0.0';
  http.createServer(app).listen(port, host, () => {
    console.log(`personal-dashboard listening on ${host}:${port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
