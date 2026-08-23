import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('diary section has accessible shell, create form, list, and detail regions inside the merged panel', () => {
  // Diary is now a section inside #panel-diary-goals, not a top-level tab panel
  assert.match(indexSource, /id="panel-diary-goals"[^>]+class="tab-panel"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-diary-goals"/);
  assert.match(indexSource, /id="diary-section"/);
  for (const id of ['diary-entry-form', 'diary-entry-date', 'diary-entry-title', 'diary-entry-body', 'diary-entry-mood', 'diary-entry-list', 'diary-entry-detail']) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(indexSource, /diary[^<]*(delete|export|purge)/i);
  assert.match(indexSource, /Diary entries can be created and viewed here\. Editing and deleting are not part of this MVP\./);
  // Separate top-level diary tab and panel must not exist
  assert.doesNotMatch(indexSource, /id="tab-diary"[^-]/);
  assert.doesNotMatch(indexSource, /id="panel-diary"[^-]/);
});

test('diary frontend uses bounded fields and authenticated diary API paths only', () => {
  const diarySource = appSource.slice(appSource.indexOf('function setDiaryMessage'), appSource.indexOf('async function refreshFinnick'));
  assert.match(indexSource, /id="diary-entry-title"[^>]+maxlength="160"/);
  assert.match(indexSource, /id="diary-entry-body"[^>]+maxlength="20000"/);
  assert.match(indexSource, /id="diary-entry-mood"[^>]+maxlength="64"/);
  assert.match(appSource, /const TAB_IDS = \['overview', 'work', 'knowledge', 'reports', 'investment-screener', 'diary-goals'\]/);
  assert.match(appSource, /tabId === 'diary-goals'[\s\S]*refreshDiaryEntries\(\)/);
  assert.match(diarySource, /postJson\('\/api\/diary\/entries'/);
  assert.match(diarySource, /getJson\('\/api\/diary\/entries\?limit=20&offset=0'/);
  assert.match(diarySource, /getJson\(`\/api\/diary\/entries\/\$\{encodeURIComponent\(entry\.id\)\}`\)/);
  assert.doesNotMatch(diarySource, /DELETE\s*['"]|\/api\/diary\/entries\/.*delete|exportDiary|purgeDiary/i);
  assert.doesNotMatch(diarySource, /assessment|score|LLM/i);
});
