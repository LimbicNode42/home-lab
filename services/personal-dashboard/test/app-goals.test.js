import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
test('goals section is a read-only Obsidian goals digest mirror inside the merged panel', () => {
  assert.match(indexSource, /id="panel-diary-goals"[^>]+class="tab-panel"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-diary-goals"/);
  assert.match(indexSource, /id="goals-list"/);
  assert.match(indexSource, /Goals digest/);
  assert.match(indexSource, /Write diary entries and goals in Obsidian/);
  assert.doesNotMatch(indexSource, /id="goal-form"|id="goal-title"|Save goal/);
  assert.doesNotMatch(indexSource, /id="tab-goals"[^-]|id="panel-goals"[^-]/);
});
test('goals frontend reads authenticated Obsidian summary API only', () => {
  assert.match(appSource, /getJson\('\/api\/obsidian\/summary'\)/);
  assert.doesNotMatch(appSource, /postJson\('\/api\/goals'|patchJson\(`\/api\/goals/);
});
