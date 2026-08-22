import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-writing-config-'));
  const path = join(dir, 'dashboard.public.json');
  await writeFile(path, JSON.stringify(config), 'utf8');
  return path;
}

async function writePosts(posts) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-writing-posts-'));
  const path = join(dir, 'posts.json');
  await writeFile(path, JSON.stringify({ posts }), 'utf8');
  return path;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose, reject) => server.close((err) => err ? reject(err) : resolveClose()))
  };
}

const basicConfig = {
  title: 'Home Dashboard',
  sections: [],
  statusChecks: []
};

const samplePosts = [
  {
    post_id: 'draft-dashboard-ideas',
    title: 'Dashboard writing ideas',
    status: 'draft',
    tags: ['dashboard', 'drafts'],
    body_markdown: '# Draft notes\n\nKeep this local-first and boring.',
    attachments: [
      { id: 'hero', display_name: 'hero-sketch.png', content_type: 'image/png', size: 2048, url: '/assets/writing/hero-sketch.png', host_path: '/root/should-not-leak.png' }
    ],
    created_at: '2026-08-21T09:00:00.000Z',
    updated_at: '2026-08-22T09:00:00.000Z'
  },
  {
    post_id: 'published-retro',
    title: 'Published retrospective',
    status: 'published',
    tags: ['retro'],
    body_markdown: 'Public-safe summary only.',
    attachments: [],
    created_at: '2026-08-20T09:00:00.000Z',
    updated_at: '2026-08-20T10:00:00.000Z',
    published_at: '2026-08-20T10:00:00.000Z'
  },
  {
    post_id: 'unsafe-markdown',
    title: 'Unsafe markdown sample',
    status: 'draft',
    tags: ['security'],
    body_markdown: '<script>alert(1)</script> [bad](javascript:alert(1)) <img src=x onerror=alert(1)> safe text',
    attachments: [
      { id: 'bad', display_name: '../secret.txt', content_type: 'text/html', size: 999999999, url: 'file:///root/secret.txt', path: '/mnt/nas/private/secret.txt' }
    ],
    created_at: '2026-08-19T09:00:00.000Z',
    updated_at: '2026-08-19T09:00:00.000Z'
  }
];

async function appWithPosts(posts = samplePosts, options = {}) {
  const configPath = await writeConfig(basicConfig);
  const writingPostsFile = await writePosts(posts);
  return createApp({
    configPath,
    writingPostsFile,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true,
    ...options
  });
}

test('GET /api/writing/posts lists sanitized post cards and supports draft/published filters', async () => {
  const app = await appWithPosts();
  const server = await listen(app);

  try {
    const allResponse = await fetch(`${server.baseUrl}/api/writing/posts?status=all`);
    const allBody = await allResponse.json();
    const draftResponse = await fetch(`${server.baseUrl}/api/writing/posts?status=draft`);
    const draftBody = await draftResponse.json();
    const publishedResponse = await fetch(`${server.baseUrl}/api/writing/posts?status=published`);
    const publishedBody = await publishedResponse.json();

    assert.equal(allResponse.status, 200);
    assert.equal(allBody.posts.length, 3);
    assert.deepEqual(allBody.counts, { all: 3, draft: 2, published: 1, archived: 0 });
    assert.equal(draftBody.posts.length, 2);
    assert.ok(draftBody.posts.every((post) => post.status === 'draft'));
    assert.equal(publishedBody.posts.length, 1);
    assert.equal(publishedBody.posts[0].post_id, 'published-retro');
    assert.equal(allBody.posts[0].body_markdown, undefined, 'list cards must not include full markdown bodies');
    assert.match(allBody.posts[0].preview, /Keep this local-first/);
  } finally {
    await server.close();
  }
});

test('GET /api/writing/posts/:id returns sanitized markdown preview data without path or script leaks', async () => {
  const app = await appWithPosts();
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/writing/posts/unsafe-markdown`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.post.post_id, 'unsafe-markdown');
    assert.match(body.post.body_markdown, /safe text/);
    for (const forbidden of ['<script', 'javascript:', 'onerror', '/root', '/mnt/nas', 'file://', '../secret', 'text/html']) {
      assert.equal(serialized.includes(forbidden), false, `writing response leaked ${forbidden}`);
    }
    assert.deepEqual(body.post.attachments, []);
  } finally {
    await server.close();
  }
});

test('GET /api/writing/posts rejects invalid filters and missing post ids safely', async () => {
  const app = await appWithPosts();
  const server = await listen(app);

  try {
    const invalid = await fetch(`${server.baseUrl}/api/writing/posts?status=deleted`);
    const invalidBody = await invalid.json();
    const missing = await fetch(`${server.baseUrl}/api/writing/posts/not-here`);
    const missingBody = await missing.json();

    assert.equal(invalid.status, 400);
    assert.equal(invalidBody.error, 'invalid_writing_status_filter');
    assert.equal(missing.status, 404);
    assert.equal(missingBody.error, 'writing_post_not_found');
  } finally {
    await server.close();
  }
});

test('writing API remains behind dashboard API auth when reverse proxy auth is enabled', async () => {
  const configPath = await writeConfig(basicConfig);
  const writingPostsFile = await writePosts(samplePosts);
  const app = await createApp({ configPath, writingPostsFile, authMode: 'reverse-proxy', proxyUserHeader: 'x-forwarded-user' });
  const server = await listen(app);

  try {
    const unauthorized = await fetch(`${server.baseUrl}/api/writing/posts`);
    const authorized = await fetch(`${server.baseUrl}/api/writing/posts`, { headers: { 'x-forwarded-user': 'ben' } });

    assert.equal(unauthorized.status, 401);
    assert.equal(authorized.status, 200);
  } finally {
    await server.close();
  }
});

test('Knowledge panel exposes a read-only Blog and Drafts surface with safe markdown rendering', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(indexSource, /id="writing-panel"/);
  assert.match(indexSource, /Blog \/ Drafts/);
  assert.match(indexSource, /read-only/i);
  assert.match(appSource, /const writingPostsList = document\.querySelector\('#writing-posts-list'\)/);
  assert.match(appSource, /\/api\/writing\/posts/);
  assert.match(appSource, /renderMarkdownDocument\(post\.body_markdown/);
  assert.doesNotMatch(appSource, /writing[\s\S]{0,80}innerHTML\s*=/i);
});
