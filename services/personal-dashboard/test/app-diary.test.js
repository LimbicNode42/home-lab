import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('diary tab has accessible shell, create form, list, and detail regions', () => {
  assert.match(indexSource, /id="tab-diary"[^>]+role="tab"[^>]+href="#diary"[^>]+aria-controls="panel-diary"/);
  assert.match(indexSource, /id="panel-diary"[^>]+class="tab-panel"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-diary"/);
  for (const id of ['diary-entry-form', 'diary-entry-date', 'diary-entry-title', 'diary-entry-body', 'diary-entry-mood', 'diary-entry-list', 'diary-entry-detail']) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(indexSource, /diary[^<]*(delete|export|purge)/i);
  assert.match(indexSource, /Diary entries can be created and viewed here\. Editing and deleting are not part of this MVP\./);
});

test('diary frontend uses bounded fields and authenticated diary API paths only', () => {
  const diarySource = appSource.slice(appSource.indexOf('function setDiaryMessage'), appSource.indexOf('async function refreshFinnick'));
  assert.match(indexSource, /id="diary-entry-title"[^>]+maxlength="160"/);
  assert.match(indexSource, /id="diary-entry-body"[^>]+maxlength="20000"/);
  assert.match(indexSource, /id="diary-entry-mood"[^>]+maxlength="64"/);
  assert.match(appSource, /const TAB_IDS = \['overview', 'work', 'knowledge', 'reports', 'investment-screener', 'diary', 'goals'\]/);
  assert.match(appSource, /tabId === 'diary'[\s\S]*refreshDiaryEntries\(\)/);
  assert.match(appSource, /tabId === 'goals'[\s\S]*refreshGoals\(\)/);
  assert.match(diarySource, /postJson\('\/api\/diary\/entries'/);
  assert.match(diarySource, /getJson\('\/api\/diary\/entries\?limit=20&offset=0'/);
  assert.match(diarySource, /getJson\(`\/api\/diary\/entries\/\$\{encodeURIComponent\(entry\.id\)\}`\)/);
  assert.doesNotMatch(diarySource, /DELETE\s*['"]|\/api\/diary\/entries\/.*delete|exportDiary|purgeDiary/i);
  assert.doesNotMatch(diarySource, /assessment|score|LLM/i);
});
