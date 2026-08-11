import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('dashboard tabs do not keep the old global long-page scroll restoration hook', () => {
  assert.doesNotMatch(appSource, /SCROLL_STORAGE_KEY/);
  assert.doesNotMatch(appSource, /sessionStorage\?\.setItem\(SCROLL_STORAGE_KEY/);
  assert.doesNotMatch(appSource, /history\.scrollRestoration\s*=\s*['"]manual['"]/);
  assert.doesNotMatch(appSource, /scheduleDashboardScrollRestore/);
  assert.doesNotMatch(appSource, /restoreDashboardScrollPosition/);
});
