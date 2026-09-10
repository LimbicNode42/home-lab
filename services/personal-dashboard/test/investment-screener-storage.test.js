import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

import {
  buildInvestmentScreenerDuckDbSummary,
  publishInvestmentScreenerRun,
  readInvestmentScreenerCompanyDetail,
  readLatestInvestmentScreenerManifest
} from '../src/investment-screener-storage.js';

const baseRun = {
  market: 'ASX',
  source: 'yahoo-finance',
  mode: 'fixture',
  started_at: '2026-08-23T09:00:00.000Z',
  completed_at: '2026-08-23T09:01:00.000Z',
  data_as_of: '2026-08-22',
  universe: {
    source: 'configured ASX bootstrap watchlist',
    version: 'sha256:test-universe',
    market: 'ASX',
    count: 3,
    complete_exchange_listing: false
  },
  companies: [
    { ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD' },
    { ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD' },
    { ticker: 'CBA.AX', name: 'Commonwealth Bank', market: 'ASX', currency: 'AUD' }
  ],
  observations: [
    { ticker: 'BHP.AX', field_name: 'revenue', value: 100, source_family: 'fixture', retrieved_at: '2026-08-23T09:00:30.000Z', data_as_of: '2026-08-22' }
  ],
  scores: [
    { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', composite_score: 91.4, sub_scores: { quality: 22, valuation: 19 }, excluded: false },
    { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', composite_score: 89.1, sub_scores: { quality: 24, valuation: 14 }, excluded: false },
    { rank: 3, ticker: 'CBA.AX', name: 'Commonwealth Bank', market: 'ASX', currency: 'AUD', composite_score: null, excluded: true, exclusion_reason: 'missing required valuation fields' }
  ],
  provenance: [
    { ticker: 'BHP.AX', field_name: 'revenue', source_family: 'fixture', provider: 'fixture', retrieved_at: '2026-08-23T09:00:30.000Z', data_as_of: '2026-08-22' }
  ],
  failures: [{ ticker: 'CBA.AX', reason: 'missing required valuation fields', recoverable: true }],
  exclusions: [{ ticker: 'CBA.AX', reason: 'missing required valuation fields' }]
};

const nonFixtureRun = {
  ...baseRun,
  source: 'yahoo-finance',
  mode: 'asx-yahoo-timeseries',
  completed_at: '2026-08-23T10:01:00.000Z',
  generated_at: '2026-08-23T10:01:00.000Z',
  data_as_of: '2026-06-30',
  universe: {
    source: 'configured ASX bootstrap watchlist',
    version: 'sha256:watchlist-live-test',
    market: 'ASX',
    count: 3,
    complete_exchange_listing: false
  },
  companies: [
    { ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD' },
    { ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD' },
    { ticker: 'CBA.AX', name: 'Commonwealth Bank', market: 'ASX', currency: 'AUD' }
  ],
  observations: [
    { ticker: 'BHP.AX', field_name: 'revenue', value: 56642000000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:30.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'net_income', value: 7810000000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:31.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'market_cap', value: 225000000000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-08-23' },
    { ticker: 'BHP.AX', field_name: 'pe_ratio', value: 34.4, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-08-23' },
    { ticker: 'BHP.AX', field_name: 'price_to_sales', value: 3.972, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-08-23' },
    { ticker: 'BHP.AX', field_name: 'fcf', value: -1200000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'net_margin', value: 0.167, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'roe', value: 0.203, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'fcf_margin', value: 0, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'revenue_growth', value: -0.125, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'current_ratio', value: 1.88, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'debt_to_assets', value: 0.45, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'total_assets', value: 1200000000000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'dividend_yield', value: null, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:33.000Z', data_as_of: '2026-08-23' },
    { ticker: 'CSL.AX', field_name: 'revenue', value: 16000000000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:35.000Z', data_as_of: '2026-06-30' }
  ],
  scores: [
    { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', composite_score: 91.4, sub_scores: { quality: 22, valuation: 19 }, excluded: false },
    { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', composite_score: 89.1, sub_scores: { quality: 24, valuation: 14 }, excluded: false },
    { rank: 3, ticker: 'CBA.AX', name: 'Commonwealth Bank', market: 'ASX', currency: 'AUD', composite_score: null, excluded: true, exclusion_reason: 'missing required valuation fields' }
  ],
  provenance: [
    { ticker: 'BHP.AX', field_name: 'revenue', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:30.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'net_income', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:31.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'market_cap', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-08-23' },
    { ticker: 'BHP.AX', field_name: 'pe_ratio', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-08-23' },
    { ticker: 'BHP.AX', field_name: 'price_to_sales', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-08-23' },
    { ticker: 'BHP.AX', field_name: 'fcf', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'net_margin', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'roe', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'fcf_margin', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'revenue_growth', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'current_ratio', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'debt_to_assets', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'BHP.AX', field_name: 'total_assets', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:32.000Z', data_as_of: '2026-06-30' },
    { ticker: 'CSL.AX', field_name: 'revenue', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:35.000Z', data_as_of: '2026-06-30' }
  ],
  failures: [{ ticker: 'CBA.AX', reason: 'missing required valuation fields', provider: 'yahoo-finance', source_family: 'yahoo-finance', recoverable: true }],
  exclusions: [{ ticker: 'CBA.AX', reason: 'missing required valuation fields' }]
};

async function snapshotTree(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    paths.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
    if (entry.isDirectory()) {
      paths.push(...await snapshotTree(join(root, entry.name), relativePath));
    }
  }
  return paths;
}

test('publishInvestmentScreenerRun writes immutable NAS-style artifacts, manifest, checksums, and latest pointer', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-storage-'));
  try {
    const result = await publishInvestmentScreenerRun({ dataRoot, run: baseRun, now: new Date('2026-08-23T09:02:00.000Z') });
    assert.match(result.run_id, /^investment-screener_ASX_fixture_2026-08-23T090100Z_[a-f0-9]{12}$/);
    assert.match(result.run_dir, /investment-screener\/runs\/market=ASX\/source=yahoo-finance\/mode=fixture\/run_date=2026-08-23\/investment-screener_ASX_fixture_/);

    for (const name of ['manifest.json', 'companies.jsonl', 'companies.parquet', 'scores.jsonl', 'scores.parquet', 'provenance.jsonl', 'coverage.json', 'failures.jsonl', 'exclusions.jsonl', 'ranked_candidates.jsonl', 'ranked_candidates.parquet', 'latest_ranked.json', 'checksums.sha256']) {
      assert.ok(existsSync(join(result.run_dir, name)), `${name} should exist`);
    }

    const manifest = JSON.parse(await readFile(join(result.run_dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema_version, 'investment-screener-run-manifest/v1');
    assert.equal(manifest.market, 'ASX');
    assert.equal(manifest.fixture, true);
    assert.equal(manifest.coverage.denominator, 3);
    assert.equal(manifest.coverage.usable, 2);
    assert.equal(manifest.coverage.excluded, 1);
    assert.equal(manifest.artifacts.ranked_candidates_parquet.rows, 2);
    assert.match(manifest.artifacts.ranked_candidates_parquet.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(manifest).includes(dataRoot), false, 'public manifest must not leak the NAS mount path');

    const latest = await readLatestInvestmentScreenerManifest({ dataRoot, market: 'ASX', source: 'yahoo-finance' });
    assert.equal(latest.run_id, result.run_id);
    assert.equal(latest.run_manifest, manifest.relative_manifest_path);

    const latestRanked = JSON.parse(await readFile(join(dataRoot, 'investment-screener', 'exports', 'dashboard', 'market=ASX', 'latest_ranked.json'), 'utf8'));
    assert.equal(latestRanked.source_summary.mode, 'fixture');
    assert.equal(latestRanked.coverage.usable, 2);

    const latestCoverage = JSON.parse(await readFile(join(dataRoot, 'investment-screener', 'exports', 'dashboard', 'market=ASX', 'latest_coverage.json'), 'utf8'));
    assert.equal(latestCoverage.source, 'published-artifact');
    assert.equal(latestCoverage.coverage.denominator, 3);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('readInvestmentScreenerCompanyDetail maps latest file-first fundamentals without fabricating missing values', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-company-detail-'));
  try {
    await publishInvestmentScreenerRun({ dataRoot, run: nonFixtureRun, now: new Date('2026-08-23T10:02:00.000Z') });

    const detail = await readInvestmentScreenerCompanyDetail({ dataRoot, ticker: 'bhp.ax', market: 'ASX', source: 'yahoo-finance' });

    assert.equal(detail.ticker, 'BHP.AX');
    assert.equal(detail.identity.name, 'BHP Group');
    assert.deepEqual(detail.identity.unavailable, ['exchange', 'region']);
    assert.equal(detail.valuation.market_cap.value, 225000000000);
    assert.equal(detail.valuation.market_cap.display_value, '225.0B');
    assert.equal(detail.valuation.market_cap.display_unit, 'AUD');
    assert.equal(detail.valuation.market_cap.display_kind, 'currency');
    assert.equal(detail.valuation.pe_ratio.display_value, '34.4x');
    assert.equal(detail.valuation.price_to_sales.display_value, '3.97x');
    assert.equal(detail.quality_growth_safety.fcf.display_value, '-1.2M');
    assert.equal(detail.quality_growth_safety.fcf.display_unit, 'AUD');
    assert.equal(detail.quality_growth_safety.net_margin.display_value, '16.7%');
    assert.equal(detail.quality_growth_safety.roe.display_value, '20.3%');
    assert.equal(detail.quality_growth_safety.fcf_margin.display_value, '0.0%');
    assert.equal(detail.quality_growth_safety.revenue_growth.display_value, '-12.5%');
    assert.equal(detail.quality_growth_safety.current_ratio.display_value, '1.88x');
    assert.equal(detail.quality_growth_safety.debt_to_assets.display_value, '45.0%');
    assert.equal(detail.statements_summary.total_assets.display_value, '1.2T');
    assert.equal(detail.dividends.dividend_yield.display_value, 'Missing');
    assert.equal(detail.earnings.eps.display_value, 'Unavailable');
    assert.equal(detail.statements_summary.revenue.value, 56642000000);
    assert.equal(detail.statements_summary.net_income.value, 7810000000);
    assert.equal(detail.dividends.dividend_yield.state, 'missing');
    assert.equal(detail.dividends.dividend_yield.value, null);
    assert.equal(detail.earnings.eps.state, 'unavailable');
    assert.ok(detail.unavailable_data.some((item) => item.field === 'exchange' && item.state === 'unavailable'));
    assert.equal(detail.freshness.latest_retrieved_at, '2026-08-23T10:00:32.000Z');
    assert.equal(detail.source_notes.providers.includes('yahoo-finance'), true);
    assert.equal(JSON.stringify(detail).includes(dataRoot), false);
    assert.equal(JSON.stringify(detail).includes('DATABASE_URL'), false);

    await assert.rejects(
      () => readInvestmentScreenerCompanyDetail({ dataRoot, ticker: 'UNKNOWN.AX', market: 'ASX', source: 'yahoo-finance' }),
      /company not found/i
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test('readInvestmentScreenerCompanyDetail consumes Python file-first payload with canonical derived fundamentals', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-python-file-first-detail-'));
  try {
    const python = String.raw`
import importlib.util, json, pathlib, sys
module_path = pathlib.Path('investment-screener/screener.py')
spec = importlib.util.spec_from_file_location('asx_screener', module_path)
screener = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = screener
spec.loader.exec_module(screener)
base_provenance = {
    'provider': 'yahoo-finance',
    'source_family': 'yahoo-finance',
    'retrieved_at': '2026-08-23T10:00:30Z',
    'data_as_of': '2026-06-30',
}
ranked = [{
    'rank': 1,
    'ticker': 'BHP.AX',
    'name': 'BHP Group',
    'market': 'ASX',
    'currency': 'AUD',
    'composite_score': 91.4,
    'sub_scores': {'quality': 22, 'valuation': 19, 'growth': 18},
    'fields': {
        'price': {'value': 45.0, 'status': 'present', 'provenance': base_provenance},
        'shares_outstanding': {'value': 5000000000, 'status': 'present', 'provenance': base_provenance},
        'revenue': {'value': 56642000000, 'status': 'present', 'provenance': base_provenance},
        'prior_revenue': {'value': 54000000000, 'status': 'present', 'provenance': base_provenance},
        'net_income': {'value': 7810000000, 'status': 'present', 'provenance': base_provenance},
        'operating_cash_flow': {'value': 18000000000, 'status': 'present', 'provenance': base_provenance},
        'capital_expenditures': {'value': -7600000000, 'status': 'present', 'provenance': base_provenance},
        'total_assets': {'value': 100000000000, 'status': 'present', 'provenance': base_provenance},
        'total_liabilities': {'value': 45000000000, 'status': 'present', 'provenance': base_provenance},
        'current_assets': {'value': 25000000000, 'status': 'present', 'provenance': base_provenance},
        'current_liabilities': {'value': 12000000000, 'status': 'present', 'provenance': base_provenance},
        'market_cap': {'value': 225000000000, 'status': 'present', 'provenance': {'source_fields': ['price', 'shares_outstanding'], 'retrieved_at': ['2026-08-23T10:00:30Z'], 'data_as_of': ['2026-06-30']}},
        'price_to_sales': {'value': 3.972, 'status': 'present', 'provenance': {'source_fields': ['price', 'shares_outstanding', 'revenue'], 'retrieved_at': ['2026-08-23T10:00:30Z'], 'data_as_of': ['2026-06-30']}},
        'fcf': {'value': None, 'status': 'missing', 'provenance': {'source_fields': ['operating_cash_flow', 'capital_expenditures'], 'retrieved_at': ['2026-08-23T10:00:30Z'], 'data_as_of': ['2026-06-30']}},
        'fcf_margin': {'value': None, 'status': 'missing', 'provenance': {'source_fields': ['operating_cash_flow', 'capital_expenditures', 'revenue'], 'retrieved_at': ['2026-08-23T10:00:30Z'], 'data_as_of': ['2026-06-30']}},
        'debt_to_assets': {'value': 0.45, 'status': 'present', 'provenance': {'source_fields': ['total_liabilities', 'total_assets'], 'retrieved_at': ['2026-08-23T10:00:30Z'], 'data_as_of': ['2026-06-30']}},
    },
    'missing_fields': ['fcf', 'fcf_margin'],
}]
payload = screener.build_file_first_run_payload(ranked, source='yahoo-finance', mode='asx-yahoo-timeseries', universe=['BHP.AX'], completed_at='2026-08-23T10:01:00Z')
print(json.dumps(payload, sort_keys=True))
`;
    const { stdout } = await execFileAsync('python3', ['-c', python], { cwd: new URL('..', import.meta.url), maxBuffer: 1024 * 1024 });
    const run = JSON.parse(stdout);
    const published = await publishInvestmentScreenerRun({ dataRoot, run, now: new Date('2026-08-23T10:02:00.000Z') });
    const observations = (await readFile(join(published.run_dir, 'observations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const provenance = (await readFile(join(published.run_dir, 'provenance.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

    assert.ok(observations.some((row) => row.field_name === 'price_to_sales' && row.value_json === '3.972'));
    assert.ok(observations.some((row) => row.field_name === 'fcf' && row.value_json === 'null'));
    assert.ok(provenance.some((row) => row.field_name === 'debt_to_assets' && row.source_family === 'derived'));
    const derivedMarketCap = observations.find((row) => row.field_name === 'market_cap');
    assert.equal(derivedMarketCap.retrieved_at, '2026-08-23T10:00:30.000Z');
    assert.equal(derivedMarketCap.data_as_of, '2026-06-30');
    assert.equal(JSON.stringify(observations).includes("['2026-06"), false);

    const detail = await readInvestmentScreenerCompanyDetail({ dataRoot, ticker: 'BHP.AX', market: 'ASX', source: 'yahoo-finance' });
    assert.equal(detail.valuation.price_to_sales.field, 'price_to_sales');
    assert.equal(detail.valuation.price_to_sales.value, 3.972);
    assert.equal(detail.quality_growth_safety.fcf.field, 'fcf');
    assert.equal(detail.quality_growth_safety.fcf.state, 'missing');
    assert.equal(detail.quality_growth_safety.debt_to_assets.field, 'debt_to_assets');
    assert.equal(detail.quality_growth_safety.debt_to_assets.value, 0.45);
    assert.equal(detail.statements_summary.capital_expenditures.field, 'capital_expenditures');
    assert.equal(detail.statements_summary.capital_expenditures.value, -7600000000);
    assert.equal(detail.earnings.eps.state, 'unavailable');
    assert.equal(detail.unavailable_data.some((item) => item.field === 'price_sales' || item.field === 'free_cash_flow' || item.field === 'debt_assets' || item.field === 'capital_expenditure'), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('publishInvestmentScreenerRun preserves prior latest pointer when validation fails before promote', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-storage-atomic-'));
  try {
    const first = await publishInvestmentScreenerRun({ dataRoot, run: baseRun, now: new Date('2026-08-23T09:02:00.000Z') });
    const before = await readFile(join(dataRoot, 'investment-screener', 'manifests', 'market=ASX', 'source=yahoo-finance', 'latest.json'), 'utf8');

    await assert.rejects(
      () => publishInvestmentScreenerRun({
        dataRoot,
        run: { ...baseRun, scores: [{ ticker: '', name: '', composite_score: 12 }] },
        now: new Date('2026-08-23T09:03:00.000Z')
      }),
      /score row requires ticker/i
    );

    const after = await readFile(join(dataRoot, 'investment-screener', 'manifests', 'market=ASX', 'source=yahoo-finance', 'latest.json'), 'utf8');
    assert.equal(after, before);
    assert.equal((await readLatestInvestmentScreenerManifest({ dataRoot, market: 'ASX', source: 'yahoo-finance' })).run_id, first.run_id);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('buildInvestmentScreenerDuckDbSummary reads ranked and coverage summaries from immutable parquet artifacts without canonical writes', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-duckdb-'));
  try {
    const published = await publishInvestmentScreenerRun({ dataRoot, run: baseRun, now: new Date('2026-08-23T09:02:00.000Z') });
    const before = await snapshotTree(join(dataRoot, 'investment-screener'));
    const summary = await buildInvestmentScreenerDuckDbSummary({ dataRoot, market: 'ASX', source: 'yahoo-finance' });
    const after = await snapshotTree(join(dataRoot, 'investment-screener'));

    assert.equal(summary.source, 'duckdb');
    assert.equal(summary.run_id, published.run_id);
    assert.equal(summary.coverage.usable, 2);
    assert.equal(summary.coverage.denominator, 3);
    assert.equal(summary.coverage.percent, 66.7);
    assert.deepEqual(summary.ranked_candidates.map((candidate) => candidate.ticker), ['BHP.AX', 'CSL.AX']);
    assert.equal(JSON.stringify(summary).includes(dataRoot), false, 'summary must not leak local/NAS paths');
    assert.deepEqual(after, before, 'API/runtime DuckDB reads must not write into canonical investment-screener tree');
    assert.equal(after.some((path) => path.startsWith('duckdb/')), false, 'DuckDB materialization belongs outside API request handling');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test('publishInvestmentScreenerRun uses selected batch size as coverage denominator for partial exchange runs', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-storage-batch-denominator-'));
  try {
    const batchRun = {
      ...nonFixtureRun,
      universe: {
        ...nonFixtureRun.universe,
        source: 'ASX listed companies directory first 200 batch',
        count: 1838,
        complete_exchange_listing: true,
        full_count: 1838,
        selected_count: 200,
        batch_offset: 0,
        batch_end_exclusive: 200
      },
      coverage: {
        denominator_label: 'first 200 active ASX companies from directory',
        denominator_status: 'staged_batch'
      }
    };

    const published = await publishInvestmentScreenerRun({ dataRoot, run: batchRun, now: new Date('2026-08-23T10:02:00.000Z') });
    const latestRanked = JSON.parse(await readFile(join(dataRoot, 'investment-screener', 'exports', 'dashboard', 'market=ASX', 'latest_ranked.json'), 'utf8'));
    const latestCoverage = JSON.parse(await readFile(join(dataRoot, 'investment-screener', 'exports', 'dashboard', 'market=ASX', 'latest_coverage.json'), 'utf8'));

    assert.equal(published.manifest.universe.count, 1838);
    assert.equal(published.manifest.universe.selected_count, 200);
    assert.equal(published.manifest.coverage.denominator, 200);
    assert.equal(published.manifest.coverage.usable, 2);
    assert.equal(published.manifest.coverage.percent, 1);
    assert.equal(published.latest.coverage.denominator, 200);
    assert.equal(latestRanked.coverage.denominator, 200);
    assert.equal(latestRanked.coverage.denominator_status, 'staged_batch');
    assert.equal(latestCoverage.coverage.denominator, 200);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test('publishInvestmentScreenerRun lets validated non-fixture ASX Yahoo runs supersede fixture latest with distinct labels', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-storage-nonfixture-'));
  try {
    const fixture = await publishInvestmentScreenerRun({ dataRoot, run: baseRun, now: new Date('2026-08-23T09:02:00.000Z') });
    const nonFixture = await publishInvestmentScreenerRun({ dataRoot, run: nonFixtureRun, now: new Date('2026-08-23T10:02:00.000Z') });

    const latest = await readLatestInvestmentScreenerManifest({ dataRoot, market: 'ASX', source: 'yahoo-finance' });
    assert.equal(latest.run_id, nonFixture.run_id);
    assert.equal(latest.mode, 'asx-yahoo-timeseries');
    assert.equal(nonFixture.manifest.fixture, false);
    assert.equal(nonFixture.manifest.source, 'yahoo-finance');
    assert.equal(nonFixture.manifest.coverage.denominator_status, 'known_sample_universe');
    assert.deepEqual(nonFixture.manifest.coverage.caveats, ['Coverage is for the configured universe, not necessarily the full exchange.']);
    const failures = (await readFile(join(nonFixture.run_dir, 'failures.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(failures[0].provider, 'yahoo-finance');
    assert.equal(failures[0].source_family, 'yahoo-finance');

    const previousLatest = JSON.parse(await readFile(join(dataRoot, 'investment-screener', 'manifests', 'market=ASX', 'source=yahoo-finance', 'latest.previous.json'), 'utf8'));
    assert.equal(previousLatest.run_id, fixture.run_id);
    assert.equal(previousLatest.mode, 'fixture');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('buildInvestmentScreenerDuckDbSummary preserves manifest coverage counts when ranked rows are API-capped', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-duckdb-capped-coverage-'));
  try {
    const companies = Array.from({ length: 120 }, (_, index) => ({
      ticker: `T${String(index + 1).padStart(3, '0')}.AX`,
      name: `Ticker ${index + 1}`,
      market: 'ASX',
      currency: 'AUD'
    }));
    const scores = companies.map((company, index) => ({
      rank: index + 1,
      ticker: company.ticker,
      name: company.name,
      market: company.market,
      currency: company.currency,
      composite_score: 200 - index,
      sub_scores: { quality: 10 },
      excluded: false
    }));
    const broadRun = {
      ...nonFixtureRun,
      universe: {
        ...nonFixtureRun.universe,
        source: 'ASX listed companies directory first 200 batch',
        count: 1838,
        selected_count: 200,
        full_count: 1838,
        complete_exchange_listing: true
      },
      companies,
      scores,
      observations: [{ ticker: 'T001.AX', field_name: 'revenue', value: 100, source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:30.000Z', data_as_of: '2026-06-30' }],
      provenance: [{ ticker: 'T001.AX', field_name: 'revenue', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:30.000Z', data_as_of: '2026-06-30' }],
      failures: [],
      exclusions: []
    };
    await publishInvestmentScreenerRun({ dataRoot, run: broadRun, now: new Date('2026-08-23T10:02:00.000Z') });

    const summary = await buildInvestmentScreenerDuckDbSummary({ dataRoot, market: 'ASX', source: 'yahoo-finance' });

    assert.equal(summary.ranked_candidates.length, 100, 'ranked payload remains capped for UI/API size');
    assert.equal(summary.coverage.denominator, 200);
    assert.equal(summary.coverage.usable, 120);
    assert.equal(summary.coverage.percent, 60);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test('buildInvestmentScreenerDuckDbSummary reads non-fixture source coverage and provenance without canonical writes', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-duckdb-nonfixture-'));
  try {
    const published = await publishInvestmentScreenerRun({ dataRoot, run: nonFixtureRun, now: new Date('2026-08-23T10:02:00.000Z') });
    const before = existsSync(join(dataRoot, 'investment-screener', 'duckdb')) ? await snapshotTree(join(dataRoot, 'investment-screener', 'duckdb')) : [];
    const summary = await buildInvestmentScreenerDuckDbSummary({ dataRoot, market: 'ASX', source: 'yahoo-finance' });
    const after = existsSync(join(dataRoot, 'investment-screener', 'duckdb')) ? await snapshotTree(join(dataRoot, 'investment-screener', 'duckdb')) : [];

    assert.equal(summary.run_id, published.run_id);
    assert.equal(summary.source_summary.mode, 'asx-yahoo-timeseries');
    assert.deepEqual(summary.source_summary.providers, ['yahoo-finance']);
    assert.deepEqual(summary.source_summary.source_families, ['yahoo-finance']);
    assert.equal(summary.coverage.denominator_status, 'known_sample_universe');
    assert.equal(summary.coverage.usable, 2);
    assert.deepEqual(after, before, 'read-only summary must not create duckdb/materialized/export files under the canonical tree');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test('publishInvestmentScreenerRun adds freshness metadata and stale warnings to manifest and dashboard coverage', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-freshness-'));
  try {
    const staleRun = {
      ...nonFixtureRun,
      completed_at: '2026-08-23T10:01:00.000Z',
      generated_at: '2026-08-23T10:01:00.000Z',
      data_as_of: '2025-06-30',
      provenance: [
        { ticker: 'BHP.AX', field_name: 'revenue', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-20T10:00:30.000Z', data_as_of: '2025-06-30' }
      ]
    };
    const published = await publishInvestmentScreenerRun({ dataRoot, run: staleRun, now: new Date('2026-08-25T10:02:00.000Z') });

    assert.equal(published.manifest.latest_retrieved_at, '2026-08-20T10:00:30.000Z');
    assert.equal(published.manifest.coverage.freshness.latest_retrieved_at, '2026-08-20T10:00:30.000Z');
    assert.equal(published.manifest.coverage.freshness.generated_age_hours, 48);
    assert.equal(published.manifest.coverage.freshness.data_as_of_age_days, 421);
    assert.equal(published.manifest.coverage.freshness.stale, true);
    assert.ok(published.manifest.coverage.warnings.some((warning) => warning.includes('older than 26h')));

    const latestCoverage = JSON.parse(await readFile(join(dataRoot, 'investment-screener', 'exports', 'dashboard', 'market=ASX', 'latest_coverage.json'), 'utf8'));
    assert.equal(latestCoverage.coverage.freshness.stale, true);
    assert.equal(latestCoverage.source_summary.latest_retrieved_at, '2026-08-20T10:00:30.000Z');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('buildInvestmentScreenerDuckDbSummary reconstructs freshness from manifest when coverage.freshness is absent', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-duckdb-freshness-reconstruct-'));
  try {
    // Publish a fresh non-fixture run, then simulate a pre-6227ed2 manifest by
    // stripping the coverage.freshness key (the shape the sentinel found in live data).
    const published = await publishInvestmentScreenerRun({ dataRoot, run: nonFixtureRun, now: new Date('2026-08-23T10:02:00.000Z') });
    const manifestPath = join(published.run_dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.coverage.freshness;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const summary = await buildInvestmentScreenerDuckDbSummary({ dataRoot, market: 'ASX', source: 'yahoo-finance' });

    assert.equal(summary.generated_at, manifest.generated_at, 'generated_at must surface manifest timestamp, not request time');
    assert.ok(summary.coverage.freshness, 'freshness must be reconstructed when absent from manifest coverage');
    assert.equal(summary.coverage.freshness.generated_at, manifest.generated_at);
    assert.equal(summary.coverage.freshness.latest_retrieved_at, '2026-08-23T10:00:35.000Z');
    assert.equal(summary.coverage.freshness.data_as_of, '2026-06-30');
    assert.ok(summary.coverage.freshness.generated_at !== null);
    assert.ok(summary.coverage.freshness.latest_retrieved_at !== null);
    assert.ok(summary.coverage.freshness.data_as_of !== null);
    assert.equal(typeof summary.coverage.freshness.latest_retrieved_age_hours, 'number');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('buildInvestmentScreenerDuckDbSummary marks stale data with stale true and stale warnings', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-duckdb-freshness-stale-'));
  try {
    // Stale run hydrated ~3 days in the past, mirroring the live defect (latest_retrieved_at 3 days old).
    const staleRun = {
      ...nonFixtureRun,
      completed_at: '2026-08-20T10:01:00.000Z',
      generated_at: '2026-08-20T10:01:00.000Z',
      data_as_of: '2026-06-30',
      provenance: nonFixtureRun.provenance.map((row) => ({ ...row, retrieved_at: '2026-08-20T10:00:30.000Z' }))
    };
    await publishInvestmentScreenerRun({ dataRoot, run: staleRun, now: new Date('2026-08-20T10:02:00.000Z') });
    const manifestPath = join(dataRoot, 'investment-screener', 'manifests', 'market=ASX', 'source=yahoo-finance', 'latest.json');
    const latest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const runDir = join(dataRoot, 'investment-screener', dirname(latest.run_manifest));
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
    delete manifest.coverage.freshness;
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const summary = await buildInvestmentScreenerDuckDbSummary({ dataRoot, market: 'ASX', source: 'yahoo-finance' });
    assert.equal(summary.coverage.freshness.stale, true);
    assert.ok(summary.coverage.freshness.latest_retrieved_age_hours > 26);
    assert.ok(summary.coverage.warnings.some((warning) => warning.includes('older than 26h')));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('preflight-investment-screener-artifacts validates canonical latest pointer and checksums', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-preflight-'));
  try {
    const published = await publishInvestmentScreenerRun({ dataRoot, run: nonFixtureRun, now: new Date('2026-08-23T10:02:00.000Z') });
    const { stdout } = await execFileAsync('node', [
      'scripts/preflight-investment-screener-artifacts.mjs',
      '--data-root', dataRoot,
      '--market', 'ASX',
      '--source', 'yahoo-finance',
      '--max-generated-age-hours', '100000'
    ], { cwd: new URL('..', import.meta.url) });
    const report = JSON.parse(stdout);

    assert.equal(report.ok, true);
    assert.equal(report.run_id, published.run_id);
    assert.equal(report.mode, 'asx-yahoo-timeseries');
    assert.equal(report.fixture, false);
    assert.equal(report.coverage.denominator_status, 'known_sample_universe');
    assert.ok(report.required_artifacts.includes('ranked_candidates.parquet'));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test('run-asx-screener-hydration.sh delegates to canonical non-fixture file-first publication workflow', async () => {
  const script = await readFile(new URL('../scripts/run-asx-screener-hydration.sh', import.meta.url), 'utf8');
  const canonicalScript = await readFile(new URL('../scripts/run-investment-screener-hydration.sh', import.meta.url), 'utf8');

  assert.match(script, /--asx-universe-seed/);
  assert.match(script, /run-investment-screener-hydration\.sh/);
  assert.match(canonicalScript, /--file-first-run-json/);
  assert.match(canonicalScript, /publish-investment-screener-run\.mjs/);
  assert.match(canonicalScript, /preflight-investment-screener-artifacts\.mjs/);
  assert.doesNotMatch(script, /--fixture/);
  assert.doesNotMatch(canonicalScript, /--fixture/);
});


test('publishInvestmentScreenerRun round-trips sector and industry through ranked candidates and DuckDB summary', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-sector-roundtrip-'));
  try {
    const classifiedRun = {
      ...nonFixtureRun,
      companies: nonFixtureRun.companies.map((company) => ({
        ...company,
        sector: company.ticker === 'BHP.AX' ? 'Materials' : company.ticker === 'CSL.AX' ? 'Health Care' : 'Financials',
        industry: company.ticker === 'BHP.AX' ? 'Metals & Mining' : company.ticker === 'CSL.AX' ? 'Biotechnology' : 'Banks'
      })),
      scores: nonFixtureRun.scores.map((score) => ({
        ...score,
        sector: score.ticker === 'BHP.AX' ? 'Materials' : score.ticker === 'CSL.AX' ? 'Health Care' : 'Financials',
        industry: score.ticker === 'BHP.AX' ? 'Metals & Mining' : score.ticker === 'CSL.AX' ? 'Biotechnology' : 'Banks'
      }))
    };
    const published = await publishInvestmentScreenerRun({ dataRoot, run: classifiedRun, now: new Date('2026-08-23T10:02:00.000Z') });

    const ranked = (await readFile(join(published.run_dir, 'ranked_candidates.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const bhp = ranked.find((candidate) => candidate.ticker === 'BHP.AX');
    assert.equal(bhp.sector, 'Materials');
    assert.equal(bhp.industry, 'Metals & Mining');
    assert.equal(JSON.stringify(ranked).includes(dataRoot), false, 'ranked candidates must not leak NAS path');

    const summary = await buildInvestmentScreenerDuckDbSummary({ dataRoot, market: 'ASX', source: 'yahoo-finance' });
    const bhpSummary = summary.ranked_candidates.find((candidate) => candidate.ticker === 'BHP.AX');
    assert.equal(bhpSummary.sector, 'Materials');
    assert.equal(bhpSummary.industry, 'Metals & Mining');
    assert.equal(JSON.stringify(summary).includes(dataRoot), false, 'duckdb summary must not leak NAS path');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test('publishInvestmentScreenerRun never invents sector/industry for a name missing classification', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'screener-sector-missing-'));
  try {
    // baseRun company/score rows carry no sector/industry keys.
    const published = await publishInvestmentScreenerRun({ dataRoot, run: nonFixtureRun, now: new Date('2026-08-23T10:02:00.000Z') });

    const ranked = (await readFile(join(published.run_dir, 'ranked_candidates.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    for (const candidate of ranked) {
      assert.equal(candidate.sector, null);
      assert.equal(candidate.industry, null);
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
