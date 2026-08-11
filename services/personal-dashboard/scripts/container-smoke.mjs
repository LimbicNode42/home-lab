#!/usr/bin/env node

const baseUrl = process.env.DASHBOARD_SMOKE_BASE_URL ?? 'http://127.0.0.1:4322';
const expectedEpicId = process.env.DASHBOARD_SMOKE_EXPECTED_EPIC_ID ?? 't_a1193120';
const proxyUserHeader = process.env.DASHBOARD_SMOKE_PROXY_USER_HEADER;
const proxyUser = process.env.DASHBOARD_SMOKE_PROXY_USER ?? 'smoke-test@example.invalid';

function apiHeaders() {
  return proxyUserHeader ? { [proxyUserHeader]: proxyUser } : {};
}

async function getJson(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...apiHeaders()
    }
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

const health = await fetch(new URL('/healthz', baseUrl));
if (!health.ok) {
  throw new Error(`/healthz failed with HTTP ${health.status}`);
}

const { response, body } = await getJson('/api/epics');
if (response.status !== 200) {
  throw new Error(`/api/epics failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
}
if (!Array.isArray(body?.epics)) {
  throw new Error('/api/epics did not return an epics array');
}
if (!body.epics.some((epic) => epic?.id === expectedEpicId)) {
  throw new Error(`/api/epics did not include expected epic ${expectedEpicId}`);
}

console.log(`container smoke passed: /api/epics includes ${expectedEpicId}`);
