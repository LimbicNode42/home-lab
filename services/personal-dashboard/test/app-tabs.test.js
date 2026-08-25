import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('dashboard shell exposes five accessible hash-backed tabs without the old Work tab', () => {
  assert.match(indexSource, /class="tab-list" role="tablist" aria-label="Dashboard sections"/);
  for (const id of ['overview', 'knowledge', 'reports', 'investment-screener', 'diary-goals']) {
    assert.match(indexSource, new RegExp(`id="tab-${id}"[^>]+role="tab"[^>]+href="#${id}"[^>]+aria-controls="panel-${id}"`));
    assert.match(indexSource, new RegExp(`id="panel-${id}"[^>]+class="tab-panel"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-${id}"`));
  }
  assert.doesNotMatch(indexSource, /id="tab-work"/);
  assert.doesNotMatch(indexSource, /id="panel-work"/);
  assert.doesNotMatch(indexSource, /id="kanban-panel"/);
  // Separate diary and goals tabs must no longer exist
  assert.doesNotMatch(indexSource, /id="tab-diary"[^-]/);
  assert.doesNotMatch(indexSource, /id="tab-goals"[^-]/);
});

test('dashboard panels are grouped into overview, knowledge, reports, investment screener, and diary-goals homes', () => {
  assert.match(indexSource, /id="panel-overview"[\s\S]*id="status-list"[\s\S]*id="sections"[\s\S]*id="panel-knowledge"/);
  assert.match(indexSource, /id="panel-knowledge"[\s\S]*id="epics-panel"[\s\S]*id="docs-panel"[\s\S]*id="panel-reports"/);
  assert.match(indexSource, /id="panel-reports"[\s\S]*id="finnick-panel"[\s\S]*id="panel-investment-screener"/);
  assert.doesNotMatch(indexSource, /id="panel-reports"[\s\S]*id="investment-screener-panel"[\s\S]*id="panel-investment-screener"/);
  assert.match(indexSource, /id="panel-investment-screener"[\s\S]*id="investment-screener-panel"[\s\S]*id="panel-diary-goals"/);
  assert.match(indexSource, /id="panel-diary-goals"[\s\S]*id="goals-section"[\s\S]*id="diary-section"/);
});

test('dashboard tabs select data lazily with hash, back/forward, and keyboard support', () => {
  assert.match(appSource, /const TAB_IDS = \['overview', 'knowledge', 'reports', 'investment-screener', 'diary-goals'\]/);
  assert.match(appSource, /const DEFAULT_TAB_ID = 'overview'/);
  assert.match(appSource, /function tabIdFromHash\(hash = window\.location\.hash\)/);
  assert.match(appSource, /window\.history\.pushState\(null, '', `#\$\{nextTabId\}`\)/);
  assert.match(appSource, /window\.addEventListener\('hashchange', async \(\) => \{[\s\S]*const tabId = tabIdFromHash\(\);[\s\S]*if \(tabId\) await selectTab\(tabId, \{ updateHash: false \}\);[\s\S]*\}\)/);
  assert.match(appSource, /event\.key === 'ArrowRight'/);
  assert.match(appSource, /event\.key === 'ArrowLeft'/);
  assert.match(appSource, /event\.key === 'Home'/);
  assert.match(appSource, /event\.key === 'End'/);
});

test('hash redirect: tabIdFromHash returns diary-goals for legacy diary and goals hashes', () => {
  // Source-level check: the redirect logic is in the function body
  assert.match(appSource, /if \(id === 'diary' \|\| id === 'goals'\) return 'diary-goals'/);
});

test('dashboard tabs load the expected existing read-only endpoints without work or embedded kanban APIs', () => {
  assert.match(appSource, /async function loadOverviewData\(\)[\s\S]*getJson\('\/api\/config\/public'\)[\s\S]*refreshStatus\(\)/);
  assert.match(appSource, /tabId === 'overview'[\s\S]*loadOverviewData\(\)/);
  assert.doesNotMatch(appSource, /tabId === 'work'/);
  assert.doesNotMatch(appSource, /refreshKanban\(\)/);
  assert.match(appSource, /tabId === 'knowledge'[\s\S]*refreshEpics\(\)[\s\S]*refreshDocs\(\)/);
  assert.match(appSource, /} else if \(tabId === 'reports'\) \{\n    await refreshFinnick\(\);\n    await refreshHomelabHealth\(\);\n  \} else if \(tabId === 'investment-screener'\) \{\n    await refreshInvestmentScreener\(\);\n  \}/);
  // Merged tab calls both refresh functions
  assert.match(appSource, /tabId === 'diary-goals'[\s\S]*refreshDiaryEntries\(\)[\s\S]*refreshGoals\(\)/);
  // Separate diary/goals tab dispatch no longer exists
  assert.doesNotMatch(appSource, /tabId === 'diary'[^-]/);
  assert.doesNotMatch(appSource, /tabId === 'goals'[^-]/);
  assert.doesNotMatch(appSource, /\/api\/dashboard\/summary/);
});

test('dashboard tab styling is sticky, focus-visible, and horizontally scrollable', () => {
  assert.match(stylesSource, /\.dashboard-tabs\s*\{[\s\S]*position: sticky;[\s\S]*top: 0;/);
  assert.match(stylesSource, /\.tab-list\s*\{[\s\S]*display: flex;[\s\S]*overflow-x: auto;/);
  assert.match(stylesSource, /\.dashboard-tab:focus-visible\s*\{[\s\S]*outline:/);
  assert.match(stylesSource, /\.tab-panel\[hidden\]\s*\{\s*display: none;\s*\}/);
});
