import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
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

export async function createApp(options = {}) {
  const config = await loadConfig({ configPath: options.configPath });
  const authMode = options.authMode ?? process.env.DASHBOARD_AUTH_MODE ?? 'reverse-proxy';
  const proxyUserHeader = options.proxyUserHeader ?? process.env.DASHBOARD_PROXY_USER_HEADER ?? 'x-forwarded-user';
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const allowDisabledAuth = options.allowDisabledAuth ?? process.env.DASHBOARD_ALLOW_DISABLED_AUTH === 'true';
  const finnickReportFile = options.finnickReportFile ?? process.env.FINNICK_REPORT_FILE ?? null;
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
