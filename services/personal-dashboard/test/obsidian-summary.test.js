import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';

const basicConfig = { title: 'Home Dashboard', sections: [], statusChecks: [] };
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}

test('obsidian summary API requires auth before reading summary output', async () => {
  const app = await createApp({ config: basicConfig, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user', obsidianSummaryRoot: null });
  const server = await listen(app);
  try {
    const unauth = await fetch(`${server.baseUrl}/api/obsidian/summary`);
    assert.equal(unauth.status, 401);
    const authed = await fetch(`${server.baseUrl}/api/obsidian/summary`, { headers: { 'x-forwarded-user': 'ben@example.invalid' } });
    assert.equal(authed.status, 503);
  } finally { await server.close(); }
});

test('obsidian summary API returns sanitized read-only freshness, diary, and goals output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-summary-'));
  await mkdir(join(root, 'meta'), { recursive: true });
  await mkdir(join(root, 'diary'), { recursive: true });
  await mkdir(join(root, 'goals'), { recursive: true });
  await writeFile(join(root, 'meta', 'last-run.json'), JSON.stringify({ kind: 'obsidian-summary', generated_at: new Date().toISOString(), file_count: { diary: 1, goals: 1 }, model: 'fixture-llm', status: 'ok', source: { vault_label: 'obsidian NAS share', livesync_url: 'http://192.168.0.50:5984' } }));
  await writeFile(join(root, 'diary', '2026-10-03.md'), '# Diary summary\n\n- Fake summary only.');
  await writeFile(join(root, 'goals', 'digest.md'), '# Goals digest\n\n- Fake goal summary.');
  const app = await createApp({ config: basicConfig, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true, obsidianSummaryRoot: root });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/obsidian/summary`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.metadata.status, 'ok');
    assert.equal(body.metadata.source.livesync_url, 'http://192.168.0.50:5984');
    assert.equal(body.diary[0].date, '2026-10-03');
    assert.match(body.goals, /Fake goal summary/);
    assert.equal(body.mode, 'read-only');
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
