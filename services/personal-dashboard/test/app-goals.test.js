import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('goals tab has accessible shell, create form, status filter, list, and detail regions', () => {
  assert.match(indexSource, /id="tab-goals"[^>]+role="tab"[^>]+href="#goals"[^>]+aria-controls="panel-goals"/);
  assert.match(indexSource, /id="panel-goals"[^>]+class="tab-panel"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-goals"/);
  for (const id of ['goal-form', 'goal-title', 'goal-description', 'goal-status', 'goal-target-date', 'goal-status-filter', 'goals-list', 'goal-detail']) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(indexSource, /goal[^<]*(delete|purge)/i);
  assert.match(indexSource, /Goals can be created, viewed, and moved between active, paused, completed, and archived states\./);
});

test('goals frontend uses bounded fields and authenticated goal API paths only', () => {
  assert.match(indexSource, /id="goal-title"[^>]+maxlength="160"/);
  assert.match(indexSource, /id="goal-description"[^>]+maxlength="5000"/);
  assert.match(indexSource, /<option value="active">Active<\/option>/);
  assert.match(indexSource, /<option value="archived">Archived<\/option>/);
  assert.match(appSource, /const TAB_IDS = \['overview', 'work', 'knowledge', 'reports', 'investment-screener', 'diary', 'goals'\]/);
  assert.match(appSource, /tabId === 'goals'[\s\S]*refreshGoals\(\)/);
  assert.match(appSource, /postJson\('\/api\/goals'/);
  assert.match(appSource, /patchJson\(`\/api\/goals\/\$\{encodeURIComponent\((goal\.id|currentGoalId)\)\}`/);
  assert.match(appSource, /getJson\(goalsRequestPath\(\)\)/);
  assert.match(appSource, /getJson\(`\/api\/goals\/\$\{encodeURIComponent\(goal\.id\)\}`\)/);
  assert.doesNotMatch(appSource, /DELETE\s*['"]|\/api\/goals\/.*delete|purgeGoal/i);
  assert.doesNotMatch(appSource, /goal[\s\S]{0,80}(assessment|score|LLM)/i);
});
