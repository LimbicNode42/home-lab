import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildInvestmentScreenerDuckDbSummary,
  publishInvestmentScreenerRun,
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
    { ticker: 'CSL.AX', field_name: 'revenue', value: 16000000000, source_family: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:35.000Z', data_as_of: '2026-06-30' }
  ],
  scores: [
    { rank: 1, ticker: 'BHP.AX', name: 'BHP Group', market: 'ASX', currency: 'AUD', composite_score: 91.4, sub_scores: { quality: 22, valuation: 19 }, excluded: false },
    { rank: 2, ticker: 'CSL.AX', name: 'CSL Limited', market: 'ASX', currency: 'AUD', composite_score: 89.1, sub_scores: { quality: 24, valuation: 14 }, excluded: false },
    { rank: 3, ticker: 'CBA.AX', name: 'Commonwealth Bank', market: 'ASX', currency: 'AUD', composite_score: null, excluded: true, exclusion_reason: 'missing required valuation fields' }
  ],
  provenance: [
    { ticker: 'BHP.AX', field_name: 'revenue', source_family: 'yahoo-finance', provider: 'yahoo-finance', retrieved_at: '2026-08-23T10:00:30.000Z', data_as_of: '2026-06-30' },
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
