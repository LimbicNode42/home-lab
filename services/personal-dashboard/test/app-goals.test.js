import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('goals section has accessible shell, create form, status filter, list, and detail regions inside the merged panel', () => {
  // Goals is now a section inside #panel-diary-goals, not a top-level tab panel
  assert.match(indexSource, /id="panel-diary-goals"[^>]+class="tab-panel"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-diary-goals"/);
  assert.match(indexSource, /id="goals-section"/);
  for (const id of ['goal-form', 'goal-title', 'goal-description', 'goal-status', 'goal-target-date', 'goal-status-filter', 'goals-list', 'goal-detail']) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(indexSource, /goal[^<]*(delete|purge)/i);
  assert.match(indexSource, /Goals can be created, viewed, and moved between active, paused, completed, and archived states\./);
  // Separate top-level goals tab and panel must not exist
  assert.doesNotMatch(indexSource, /id="tab-goals"[^-]/);
  assert.doesNotMatch(indexSource, /id="panel-goals"[^-]/);
});

test('goals frontend uses bounded fields and authenticated goal API paths only', () => {
  assert.match(indexSource, /id="goal-title"[^>]+maxlength="160"/);
  assert.match(indexSource, /id="goal-description"[^>]+maxlength="5000"/);
  assert.match(indexSource, /<option value="active">Active<\/option>/);
  assert.match(indexSource, /<option value="archived">Archived<\/option>/);
  assert.match(appSource, /const TAB_IDS = \['overview', 'knowledge', 'reports', 'investment-screener', 'diary-goals'\]/);
  assert.match(appSource, /tabId === 'diary-goals'[\s\S]*refreshGoals\(\)/);
  assert.match(appSource, /postJson\('\/api\/goals'/);
  assert.match(appSource, /patchJson\(`\/api\/goals\/\$\{encodeURIComponent\((goal\.id|currentGoalId)\)\}`/);
  assert.match(appSource, /getJson\(goalsRequestPath\(\)\)/);
  assert.match(appSource, /getJson\(`\/api\/goals\/\$\{encodeURIComponent\(goal\.id\)\}`\)/);
  assert.doesNotMatch(appSource, /DELETE\s*['"]|\/api\/goals\/.*delete|purgeGoal/i);
  assert.doesNotMatch(appSource, /goal[\s\S]{0,80}(assessment|score|LLM)/i);
});
