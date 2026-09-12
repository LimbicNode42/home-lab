import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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
  assert.match(appSource, /searchParams\.set\('limit'/);
});


test('dashboard investment screener exposes selectable sector and industry filters', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(indexSource, /<select id="investment-sector-filter"[^>]*>/);
  assert.match(indexSource, /<select id="investment-industry-filter"[^>]*>/);
  assert.doesNotMatch(indexSource, /id="investment-sector-filter"[^>]*disabled/);
  assert.doesNotMatch(indexSource, /id="investment-industry-filter"[^>]*disabled/);
  assert.match(appSource, /searchParams\.append\('sector'/);
  assert.match(appSource, /searchParams\.append\('industry'/);
  assert.match(appSource, /available_facets/);
});


test('dashboard investment screener exposes exchange and region filters for ASX and NASDAQ', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(indexSource, /<select id="investment-exchange-filter"[^>]*>/);
  assert.match(indexSource, /<select id="investment-region-filter"[^>]*>/);
  assert.doesNotMatch(indexSource, /id="investment-exchange-filter"[^>]*disabled/);
  assert.doesNotMatch(indexSource, /id="investment-region-filter"[^>]*disabled/);
  assert.match(appSource, /const investmentExchangeFilter = document\.querySelector\('#investment-exchange-filter'\)/);
  assert.match(appSource, /const investmentRegionFilter = document\.querySelector\('#investment-region-filter'\)/);
  assert.match(appSource, /searchParams\.set\('exchange'/);
  assert.match(appSource, /searchParams\.set\('region'/);
});


test('dashboard investment screener market selector exposes ASX, NASDAQ, and NYSE without generic US collapse', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(indexSource, /<option value="ASX">Australia \/ ASX<\/option>/);
  assert.match(indexSource, /<option value="NASDAQ">United States \/ NASDAQ<\/option>/);
  assert.match(indexSource, /<option value="NYSE">United States \/ NYSE<\/option>/);
  assert.match(indexSource, /<option value="NYSE">NYSE<\/option>/);
  assert.doesNotMatch(indexSource, /<option value="US">US<\/option>/);
  assert.match(indexSource, /ASX, NASDAQ, and NYSE are separate exchange buckets/i);
  assert.match(indexSource, /security-type-filtered full listed-equity universes/i);
  assert.doesNotMatch(indexSource, /NASDAQ-100 constituents/i);
});


test('dashboard investment screener renders applied filter state and fixture warning', () => {
  assert.match(appSource, /Applied filters:/);
  assert.match(appSource, /Market: \$\{appliedFilters\.market\}/);
  assert.match(appSource, /Fixture\/sample data only — not full market coverage\./);
});


test('dashboard investment screener renders filter messages, no-match states, and suggestion limits', () => {
  assert.match(appSource, /payload\.messages/);
  assert.match(appSource, /No candidates match/i);
  assert.match(appSource, /investmentTopNFilter/);
  assert.match(appSource, /candidates\.slice\(0, suggestionLimit\)/);
});


test('dashboard investment screener exposes search and pagination controls for broader coverage', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of [
    'investment-search-filter',
    'investment-page-summary',
    'investment-prev-page',
    'investment-next-page'
  ]) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.match(appSource, /searchParams\.set\('q'/);
  assert.match(appSource, /searchParams\.set\('limit'/);
  assert.match(appSource, /searchParams\.set\('offset'/);
  assert.match(appSource, /function updateInvestmentPaginationControls\(/);
  assert.match(appSource, /payload\.pagination/);
});


test('dashboard investment screener request path builds query params without a ReferenceError', () => {
  class FakeNode {
    constructor(value = '') {
      this.value = value;
      this.children = [];
      this.className = '';
      this.textContent = '';
      this.disabled = false;
      this.dataset = {};
      this.classList = { toggle: () => {} };
    }

    addEventListener() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = String(value); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }

  const nodes = new Map([
    ['investment-search-filter', new FakeNode('BHP')],
    ['investment-market-filter', new FakeNode('ASX')],
    ['investment-metric-filter', new FakeNode('quality')],
    ['investment-weight-filter', new FakeNode('balanced')],
    ['investment-topn-filter', new FakeNode('12')],
    ['kanban-panel', new FakeNode()],
    ['toggle-kanban-density', new FakeNode()]
  ]);
  const document = {
    querySelector: (selector) => nodes.get(selector.replace(/^#/, '')) ?? new FakeNode(),
    createElement: () => new FakeNode(),
    createTextNode: (text) => {
      const node = new FakeNode();
      node.textContent = text;
      return node;
    },
    title: ''
  };
  const window = {
    location: { hash: '#investment-screener', origin: 'http://dashboard.local' },
    history: { pushState: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {}
  };
  const context = { document, window, URL, URLSearchParams, fetch: async () => ({ ok: true, json: async () => ({}) }), console, setTimeout, clearTimeout };

  vm.runInNewContext(`${appSource}\nglobalThis.__investmentPath = investmentScreenerRequestPath();`, context);

  assert.equal(context.__investmentPath, '/api/investment-screener/ranked?q=BHP&market=ASX&metric=quality&limit=12');
});


test('dashboard investment screener renders source and coverage panel details', () => {
  assert.match(appSource, /function renderInvestmentSourceCoveragePanel\(/);
  assert.match(appSource, /payload\?\.source_summary/);
  assert.match(appSource, /payload\?\.coverage/);
  assert.match(appSource, /Data source/);
  assert.match(appSource, /Coverage:/);
  assert.match(appSource, /Freshness:/);
  assert.match(appSource, /denominator_label/);
  assert.match(appSource, /humanizeInvestmentDenominatorStatus/);
  assert.match(appSource, /Coverage basis:/);
  assert.match(appSource, /Run results:/);
});


test('dashboard investment screener renders fixture and degraded coverage caveats honestly', () => {
  assert.match(appSource, /Fixture\/sample data/);
  assert.match(appSource, /not full market coverage/);
  assert.match(appSource, /Coverage degraded/);
  assert.match(appSource, /Postgres history is unavailable/);
  assert.match(appSource, /alternate_denominators/);
});

test('dashboard investment screener links candidates to company fundamentals detail states', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(indexSource, /id="investment-company-detail"/);
  assert.match(appSource, /\/api\/investment-screener\/company\/\$\{encodeURIComponent\(ticker\)\}/);
  assert.match(appSource, /renderInvestmentCompanyDetail/);
  assert.match(appSource, /field\.display_value/);
  assert.match(appSource, /field\.display_unit/);
  assert.match(appSource, /Unavailable from current source/);
  assert.match(appSource, /Missing in latest source/);
  assert.match(appSource, /Fundamentals/);
});
