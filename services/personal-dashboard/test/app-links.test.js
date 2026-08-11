import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('dashboard generated links keep noreferrer and noopener protections', () => {
  assert.match(appSource, /section\.links\.map\(\(link\) => el\('a', \{ href: link\.href, text: link\.label, rel: 'noreferrer noopener' \}\)\)/);
  assert.match(appSource, /body\.push\(el\('a', \{ href: check\.displayUrl, text: 'Open', rel: 'noreferrer noopener' \}\)\)/);
});

test('dashboard docs viewer uses manifest ids, not browser-supplied file paths', () => {
  assert.match(appSource, /getJson\('\/api\/docs'\)/);
  assert.match(appSource, /getJson\(`\/api\/docs\/\$\{encodeURIComponent\(doc\.id\)\}`\)/);
  assert.doesNotMatch(appSource, /\/api\/docs\?path=/);
});

test('dashboard investment screener panel fetches ranked output and renders safe public fields', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(indexSource, /id="investment-screener-panel"/);
  assert.match(indexSource, /id="investment-screener-content"/);
  assert.match(indexSource, /id="refresh-investment-screener"/);
  assert.match(appSource, /getJson\(investmentScreenerRequestPath\(\)\)/);
  assert.match(appSource, /renderInvestmentCandidate/);
  assert.match(appSource, /payload\.generated_at/);
  assert.match(appSource, /payload\.data_as_of/);
  assert.match(appSource, /not financial advice/i);
});


test('dashboard investment screener exposes filtering and suggestion-count controls', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of [
    'investment-market-filter',
    'investment-exchange-filter',
    'investment-region-filter',
    'investment-sector-filter',
    'investment-industry-filter',
    'investment-metric-filter',
    'investment-topn-filter'
  ]) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.match(appSource, /function investmentScreenerRequestPath\(\)/);
  assert.match(appSource, /searchParams\.set\('market'/);
  assert.match(appSource, /searchParams\.set\('metric'/);
  assert.match(appSource, /searchParams\.set\('topN'/);
});


test('dashboard investment screener renders filter messages, no-match states, and suggestion limits', () => {
  assert.match(appSource, /payload\.messages/);
  assert.match(appSource, /No candidates match/i);
  assert.match(appSource, /investmentTopNFilter/);
  assert.match(appSource, /candidates\.slice\(0, suggestionLimit\)/);
});
