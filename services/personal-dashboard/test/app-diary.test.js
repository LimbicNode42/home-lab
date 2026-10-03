import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
test('diary section is a read-only Obsidian summary mirror inside the merged panel', () => {
  assert.match(indexSource, /id="panel-diary-goals"[^>]+class="tab-panel"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-diary-goals"/);
  assert.match(indexSource, /id="obsidian-summary-panel"/);
  assert.match(indexSource, /id="diary-entry-list"/);
  assert.match(indexSource, /Read-only mirror of Obsidian summary output/);
  assert.doesNotMatch(indexSource, /id="diary-entry-form"|id="diary-entry-body"|Save diary entry/);
  assert.doesNotMatch(indexSource, /id="tab-diary"[^-]|id="panel-diary"[^-]/);
});
test('diary frontend reads authenticated Obsidian summary API only', () => {
  assert.match(appSource, /const TAB_IDS = \['overview', 'knowledge', 'blog-drafts', 'reports', 'investment-screener', 'diary-goals'\]/);
  assert.match(appSource, /getJson\('\/api\/obsidian\/summary'\)/);
  assert.doesNotMatch(appSource, /postJson\('\/api\/diary\/entries'|\/api\/diary\/entries\/\$\{/);
});
