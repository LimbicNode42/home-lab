import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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


test('POST/PATCH/DELETE /api/writing/posts performs sanitized durable CRUD against the posts file', async () => {
  const writingPostsFile = await writePosts(samplePosts);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({
    configPath,
    writingPostsFile,
    authMode: 'disabled',
    nodeEnv: 'test',
    allowDisabledAuth: true
  });
  const server = await listen(app);

  try {
    const createResponse = await fetch(`${server.baseUrl}/api/writing/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'New modal draft',
        status: 'draft',
        tags: 'modal, dashboard, modal',
        body_markdown: '<script>nope()</script># Modal Draft\n\nSafe body.'
      })
    });
    const createBody = await createResponse.json();
    assert.equal(createResponse.status, 201);
    assert.match(createBody.post.post_id, /^new-modal-draft/);
    assert.equal(createBody.post.title, 'New modal draft');
    assert.equal(createBody.post.storage, 'dashboard writing store');
    assert.deepEqual(createBody.post.tags, ['modal', 'dashboard']);
    assert.equal(createBody.post.body_markdown.includes('<script'), false);

    const patchResponse = await fetch(`${server.baseUrl}/api/writing/posts/${createBody.post.post_id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Updated modal draft', status: 'published', tags: ['published'], body_markdown: 'Published body.' })
    });
    const patchBody = await patchResponse.json();
    assert.equal(patchResponse.status, 200);
    assert.equal(patchBody.post.title, 'Updated modal draft');
    assert.equal(patchBody.post.status, 'published');
    assert.equal(patchBody.post.storage, 'dashboard writing store');
    assert.ok(patchBody.post.published_at, 'published posts receive a published_at timestamp');

    const listResponse = await fetch(`${server.baseUrl}/api/writing/posts?status=published`);
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.ok(listBody.posts.some((post) => post.post_id === createBody.post.post_id));
    assert.equal(JSON.stringify(listBody).includes('body_markdown'), false, 'list cards still omit full bodies');

    const storedAfterPatch = JSON.parse(await readFile(writingPostsFile, 'utf8'));
    assert.equal(storedAfterPatch.posts.some((post) => post.post_id === createBody.post.post_id && post.title === 'Updated modal draft'), true);

    const deleteResponse = await fetch(`${server.baseUrl}/api/writing/posts/${createBody.post.post_id}`, { method: 'DELETE' });
    const deleteBody = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleteBody.deleted.post_id, createBody.post.post_id);

    const missingResponse = await fetch(`${server.baseUrl}/api/writing/posts/${createBody.post.post_id}`);
    assert.equal(missingResponse.status, 404);
    const storedAfterDelete = JSON.parse(await readFile(writingPostsFile, 'utf8'));
    assert.equal(storedAfterDelete.posts.some((post) => post.post_id === createBody.post.post_id), false);
    assert.equal(storedAfterDelete.posts.some((post) => post.post_id === 'draft-dashboard-ideas'), true, 'existing posts are preserved');
  } finally {
    await server.close();
  }
});

test('writing CRUD rejects invalid bodies with sanitized API errors', async () => {
  const app = await appWithPosts();
  const server = await listen(app);

  try {
    const invalidCreate = await fetch(`${server.baseUrl}/api/writing/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ', status: 'deleted', body_markdown: '' })
    });
    const invalidCreateBody = await invalidCreate.json();
    assert.equal(invalidCreate.status, 400);
    assert.equal(invalidCreateBody.error, 'validation_failed');

    const invalidJson = await fetch(`${server.baseUrl}/api/writing/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json'
    });
    const invalidJsonBody = await invalidJson.json();
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJsonBody.error, 'invalid_request_body');

    const serialized = JSON.stringify(invalidCreateBody) + JSON.stringify(invalidJsonBody);
    for (const forbidden of ['/root', '/mnt/nas', 'stderr', 'DATABASE_URL', 'TOKEN']) {
      assert.equal(serialized.includes(forbidden), false, `writing error leaked ${forbidden}`);
    }
  } finally {
    await server.close();
  }
});


function assertSanitizedStorageUnavailable(responseBody) {
  assert.equal(responseBody.error, 'writing_storage_unavailable');
  const serialized = JSON.stringify(responseBody);
  for (const forbidden of ['/root', '/tmp', 'posts.json', '{not json', 'SyntaxError', 'stack', 'stderr', 'DATABASE_URL', 'TOKEN']) {
    assert.equal(serialized.includes(forbidden), false, `writing storage error leaked ${forbidden}`);
  }
}

test('POST /api/writing/posts does not clobber an existing corrupt writing store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-writing-corrupt-'));
  const writingPostsFile = join(dir, 'posts.json');
  const corruptStore = '{not json';
  await writeFile(writingPostsFile, corruptStore, 'utf8');
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, writingPostsFile, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/writing/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should not overwrite', status: 'draft', body_markdown: 'Keep old bytes.' })
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assertSanitizedStorageUnavailable(body);
    assert.equal(await readFile(writingPostsFile, 'utf8'), corruptStore);
  } finally {
    await server.close();
  }
});

test('PATCH /api/writing/posts/:id does not convert a corrupt writing store into not-found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-writing-corrupt-'));
  const writingPostsFile = join(dir, 'posts.json');
  const corruptStore = '{not json';
  await writeFile(writingPostsFile, corruptStore, 'utf8');
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, writingPostsFile, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/writing/posts/draft-dashboard-ideas`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should not overwrite', status: 'draft', body_markdown: 'Keep old bytes.' })
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assertSanitizedStorageUnavailable(body);
    assert.equal(await readFile(writingPostsFile, 'utf8'), corruptStore);
  } finally {
    await server.close();
  }
});

test('DELETE /api/writing/posts/:id does not convert a corrupt writing store into not-found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-writing-corrupt-'));
  const writingPostsFile = join(dir, 'posts.json');
  const corruptStore = '{not json';
  await writeFile(writingPostsFile, corruptStore, 'utf8');
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, writingPostsFile, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/writing/posts/draft-dashboard-ideas`, { method: 'DELETE' });
    const body = await response.json();

    assert.equal(response.status, 503);
    assertSanitizedStorageUnavailable(body);
    assert.equal(await readFile(writingPostsFile, 'utf8'), corruptStore);
  } finally {
    await server.close();
  }
});

test('POST /api/writing/posts rejects a non-regular writing store without overwriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-writing-nonfile-'));
  const writingPostsFile = join(dir, 'posts.json');
  await mkdir(writingPostsFile);
  const configPath = await writeConfig(basicConfig);
  const app = await createApp({ configPath, writingPostsFile, authMode: 'disabled', nodeEnv: 'test', allowDisabledAuth: true });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/writing/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should not overwrite', status: 'draft', body_markdown: 'Keep directory.' })
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assertSanitizedStorageUnavailable(body);
    assert.equal((await stat(writingPostsFile)).isDirectory(), true);
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

test('Blog and Drafts lives outside Knowledge with CRUD modal controls and safe rendering', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const dockerfileSource = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(indexSource, /id="tab-blog-drafts"/);
  assert.match(indexSource, /id="panel-blog-drafts"[\s\S]*id="writing-panel"/);
  const knowledgePanel = indexSource.slice(indexSource.indexOf('id="panel-knowledge"'), indexSource.indexOf('id="panel-blog-drafts"'));
  assert.doesNotMatch(knowledgePanel, /id="writing-panel"/);
  assert.match(indexSource, /id="new-writing-post"/);
  assert.match(indexSource, /id="writing-editor-modal"/);
  assert.match(indexSource, /id="writing-editor-form"/);
  assert.match(indexSource, /id="delete-writing-post"/);
  assert.doesNotMatch(indexSource, /Read-only writing surface/i);
  assert.match(appSource, /const writingPostsList = document\.querySelector\('#writing-posts-list'\)/);
  assert.match(appSource, /function openWritingEditor/);
  assert.match(appSource, /postJson\('\/api\/writing\/posts'/);
  assert.match(appSource, /patchJson\(`\/api\/writing\/posts\/\$\{encodeURIComponent\(currentWritingPostId\)\}`/);
  assert.match(appSource, /deleteJson\(`\/api\/writing\/posts\/\$\{encodeURIComponent\(currentWritingPostId\)\}`/);
  assert.match(appSource, /renderMarkdownDocument\(post\.body_markdown/);
  assert.match(dockerfileSource, /COPY data \.\/data/);
  assert.match(stylesSource, /\.writing-editor-dialog/);
  assert.match(stylesSource, /\.danger-button/);
  assert.doesNotMatch(appSource, /writing[\s\S]{0,80}innerHTML\s*=/i);
});
