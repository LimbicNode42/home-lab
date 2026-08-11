import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('dashboard shell exposes five accessible hash-backed tabs', () => {
  assert.match(indexSource, /class="tab-list" role="tablist" aria-label="Dashboard sections"/);
  for (const id of ['overview', 'work', 'knowledge', 'reports', 'diary']) {
    assert.match(indexSource, new RegExp(`id="tab-${id}"[^>]+role="tab"[^>]+href="#${id}"[^>]+aria-controls="panel-${id}"`));
    assert.match(indexSource, new RegExp(`id="panel-${id}"[^>]+class="tab-panel"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-${id}"`));
  }
});

test('dashboard panels are grouped into overview, work, knowledge, reports, and diary homes', () => {
  assert.match(indexSource, /id="panel-overview"[\s\S]*id="status-list"[\s\S]*id="sections"[\s\S]*id="panel-work"/);
  assert.match(indexSource, /id="panel-work"[\s\S]*id="kanban-panel"[\s\S]*id="panel-knowledge"/);
  assert.match(indexSource, /id="panel-knowledge"[\s\S]*id="epics-panel"[\s\S]*id="docs-panel"[\s\S]*id="panel-reports"/);
  assert.match(indexSource, /id="panel-reports"[\s\S]*id="finnick-panel"[\s\S]*id="investment-screener-panel"/);
});

test('dashboard tabs select data lazily with hash, back/forward, and keyboard support', () => {
  assert.match(appSource, /const TAB_IDS = \['overview', 'work', 'knowledge', 'reports', 'diary'\]/);
  assert.match(appSource, /const DEFAULT_TAB_ID = 'overview'/);
  assert.match(appSource, /function tabIdFromHash\(hash = window\.location\.hash\)/);
  assert.match(appSource, /window\.history\.pushState\(null, '', `#\$\{nextTabId\}`\)/);
  assert.match(appSource, /window\.addEventListener\('hashchange', \(\) => \{[\s\S]*const tabId = tabIdFromHash\(\);[\s\S]*if \(tabId\) selectTab\(tabId, \{ updateHash: false \}\);[\s\S]*\}\)/);
  assert.match(appSource, /event\.key === 'ArrowRight'/);
  assert.match(appSource, /event\.key === 'ArrowLeft'/);
  assert.match(appSource, /event\.key === 'Home'/);
  assert.match(appSource, /event\.key === 'End'/);
});

test('dashboard tabs load the expected existing read-only endpoints without new APIs', () => {
  assert.match(appSource, /async function loadOverviewData\(\)[\s\S]*getJson\('\/api\/config\/public'\)[\s\S]*refreshStatus\(\)/);
  assert.match(appSource, /tabId === 'overview'[\s\S]*loadOverviewData\(\)/);
  assert.match(appSource, /tabId === 'work'[\s\S]*refreshKanban\(\)/);
  assert.match(appSource, /tabId === 'knowledge'[\s\S]*refreshEpics\(\)[\s\S]*refreshDocs\(\)/);
  assert.match(appSource, /tabId === 'reports'[\s\S]*refreshFinnick\(\)[\s\S]*refreshInvestmentScreener\(\)/);
  assert.match(appSource, /tabId === 'diary'[\s\S]*refreshDiaryEntries\(\)/);
  assert.doesNotMatch(appSource, /\/api\/dashboard\/summary/);
});

test('dashboard tab styling is sticky, focus-visible, and horizontally scrollable', () => {
  assert.match(stylesSource, /\.dashboard-tabs\s*\{[\s\S]*position: sticky;[\s\S]*top: 0;/);
  assert.match(stylesSource, /\.tab-list\s*\{[\s\S]*display: flex;[\s\S]*overflow-x: auto;/);
  assert.match(stylesSource, /\.dashboard-tab:focus-visible\s*\{[\s\S]*outline:/);
  assert.match(stylesSource, /\.tab-panel\[hidden\]\s*\{\s*display: none;\s*\}/);
});
