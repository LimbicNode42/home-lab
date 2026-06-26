import { createReadStream, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadConfig, toPublicConfig } from './config.js';
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
const GITHUB_BASE = 'https://github.com/LimbicNode42/home-lab/blob/master';
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
 * Query the kanban SQLite DB via the sqlite3 CLI and return parsed JSON.
 * Throws if the DB is not readable or the CLI fails.
 */
function queryKanbanDb(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (!output.trim()) return [];
  return JSON.parse(output);
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

function getRunMetadataRows(dbPath, taskId) {
  return queryKanbanDb(
    dbPath,
    `SELECT profile, metadata FROM task_runs
     WHERE task_id = ${sqlString(taskId)}
       AND metadata IS NOT NULL
     ORDER BY id ASC`
  );
}

/**
 * Build the epics response payload from the kanban DB.
 */
function getEpics(dbPath) {
  const epicRows = queryKanbanDb(
    dbPath,
    `SELECT t.id, t.title, t.completed_at
     FROM tasks t
     WHERE t.status = 'done'
       AND EXISTS (
         SELECT 1 FROM task_events te
         WHERE te.task_id = t.id AND te.kind = 'decomposed'
       )
     ORDER BY t.completed_at DESC`
  );

  const epics = [];
  for (const epic of epicRows) {
    const linkedChildren = queryKanbanDb(
      dbPath,
      `SELECT t.id, t.title, t.assignee, t.status
       FROM task_links tl
       JOIN tasks t ON t.id = tl.parent_id
       WHERE tl.child_id = ${sqlString(epic.id)}
       ORDER BY t.id ASC`
    );

    const epicMetadataRows = getRunMetadataRows(dbPath, epic.id);
    const metadataSubtaskIds = metadataChildTaskIds(epicMetadataRows);
    const seenIds = new Set(linkedChildren.map((child) => child.id));
    const subtasks = [...linkedChildren];

    if (metadataSubtaskIds.length > 0) {
      const missingIds = metadataSubtaskIds.filter((id) => !seenIds.has(id));
      if (missingIds.length > 0) {
        const idsClause = missingIds.map(sqlString).join(',');
        const metaChildren = queryKanbanDb(
          dbPath,
          `SELECT id, title, assignee, status
           FROM tasks
           WHERE id IN (${idsClause})
           ORDER BY id ASC`
        );
        for (const child of metaChildren) {
          if (!seenIds.has(child.id)) {
            seenIds.add(child.id);
            subtasks.push(child);
          }
        }
      }
    }

    const artifacts = [];
    for (const child of subtasks) {
      artifacts.push(...scribeMetadataArtifacts(child, getRunMetadataRows(dbPath, child.id)));
    }

    epics.push({
      id: epic.id,
      title: epic.title,
      completed_at: epic.completed_at ? new Date(epic.completed_at * 1000).toISOString() : null,
      subtasks: subtasks.map(({ id, title, assignee, status }) => ({ id, title, assignee, status })),
      doc_links: buildDocLinks(artifacts)
    });
  }

  return epics;
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
  const kanbanDbPath = Object.prototype.hasOwnProperty.call(options, 'kanbanDbPath')
    ? options.kanbanDbPath
    : resolveKanbanDbPath(undefined);
  assertSafeAuth({ authMode, nodeEnv, allowDisabledAuth });

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
          const content = await readFile(finnickReportFile, 'utf8');
          return json(response, 200, { content: content.trim() });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return json(response, 404, { error: 'report_not_found', message: 'No Finnick report has been generated yet' });
          }
          return json(response, 502, { error: 'report_read_error', message: err.message });
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/epics') {
        if (!kanbanDbPath) {
          return json(response, 200, { epics: [] });
        }
        try {
          const info = await stat(kanbanDbPath);
          if (!info.isFile()) {
            return json(response, 200, { epics: [] });
          }
        } catch {
          return json(response, 200, { epics: [] });
        }
        try {
          const epics = getEpics(kanbanDbPath);
          return json(response, 200, { epics });
        } catch {
          return json(response, 200, { epics: [] });
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
