import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import parquet from 'parquetjs-lite';
import { DuckDBInstance } from '@duckdb/node-api';

const { ParquetSchema, ParquetWriter } = parquet;

const ROOT_DIR = 'investment-screener';
const MANIFEST_SCHEMA_VERSION = 'investment-screener-run-manifest/v1';
const LATEST_SCHEMA_VERSION = 'investment-screener-latest-pointer/v1';
const DASHBOARD_SCHEMA_VERSION = 'investment-screener-dashboard-export/v1';
const SAFE_SLUG = /^[A-Za-z0-9._-]{1,80}$/;

const COMPANY_PARQUET_SCHEMA = new ParquetSchema({
  ticker: { type: 'UTF8' },
  name: { type: 'UTF8' },
  market: { type: 'UTF8' },
  currency: { type: 'UTF8', optional: true }
});

const SCORE_PARQUET_SCHEMA = new ParquetSchema({
  rank: { type: 'INT64', optional: true },
  ticker: { type: 'UTF8' },
  name: { type: 'UTF8', optional: true },
  market: { type: 'UTF8' },
  currency: { type: 'UTF8', optional: true },
  composite_score: { type: 'DOUBLE', optional: true },
  sub_scores_json: { type: 'UTF8', optional: true },
  excluded: { type: 'BOOLEAN' },
  exclusion_reason: { type: 'UTF8', optional: true }
});

const PROVENANCE_PARQUET_SCHEMA = new ParquetSchema({
  ticker: { type: 'UTF8' },
  field_name: { type: 'UTF8' },
  source_family: { type: 'UTF8', optional: true },
  provider: { type: 'UTF8', optional: true },
  retrieved_at: { type: 'UTF8', optional: true },
  data_as_of: { type: 'UTF8', optional: true }
});

const OBSERVATION_PARQUET_SCHEMA = new ParquetSchema({
  ticker: { type: 'UTF8' },
  field_name: { type: 'UTF8' },
  value_json: { type: 'UTF8', optional: true },
  source_family: { type: 'UTF8', optional: true },
  retrieved_at: { type: 'UTF8', optional: true },
  data_as_of: { type: 'UTF8', optional: true }
});

function assertSafeSlug(value, name) {
  if (typeof value !== 'string' || !SAFE_SLUG.test(value) || value.includes('..')) {
    throw new Error(`${name} must be a safe slug`);
  }
  return value;
}

function isoDate(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO date`);
  return date.toISOString();
}

function compactTimestamp(value) {
  return isoDate(value, 'completed_at').replace(/:/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function dateOnly(value) {
  return isoDate(value, 'completed_at').slice(0, 10);
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function sha256File(path) {
  return sha256Buffer(await readFile(path));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sanitizeText(value, fallback = null, maxLength = 500) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  if (/\/root\/|\/mnt\/|\/app\/|postgres:\/\/|DATABASE_URL|TOKEN|PASSWORD|SECRET|Authorization:/i.test(text)) return fallback;
  return text.slice(0, maxLength);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeCompany(row, fallbackMarket) {
  const ticker = sanitizeText(row?.ticker, null, 32);
  const name = sanitizeText(row?.name, null, 180);
  if (!ticker) throw new Error('company row requires ticker');
  return {
    ticker,
    name: name ?? ticker,
    market: assertSafeSlug(String(row?.market ?? fallbackMarket).toUpperCase(), 'company market'),
    currency: sanitizeText(row?.currency, null, 16)
  };
}

function sanitizeScore(row, fallbackMarket, index) {
  const ticker = sanitizeText(row?.ticker, null, 32);
  if (!ticker) throw new Error('score row requires ticker');
  const excluded = row?.excluded === true;
  const score = numberOrNull(row?.composite_score ?? row?.score);
  return {
    rank: Number.isInteger(Number(row?.rank)) ? Number(row.rank) : index + 1,
    ticker,
    name: sanitizeText(row?.name, ticker, 180),
    market: assertSafeSlug(String(row?.market ?? fallbackMarket).toUpperCase(), 'score market'),
    currency: sanitizeText(row?.currency, null, 16),
    composite_score: score,
    sub_scores: row?.sub_scores && typeof row.sub_scores === 'object' && !Array.isArray(row.sub_scores) ? row.sub_scores : {},
    excluded,
    exclusion_reason: sanitizeText(row?.exclusion_reason, null, 240)
  };
}

function sanitizeProvenance(row) {
  const ticker = sanitizeText(row?.ticker, null, 32);
  const field = sanitizeText(row?.field_name, null, 80);
  if (!ticker || !field) throw new Error('provenance row requires ticker and field_name');
  return {
    ticker,
    field_name: field,
    source_family: sanitizeText(row?.source_family, null, 80),
    provider: sanitizeText(row?.provider, null, 80),
    retrieved_at: row?.retrieved_at ? isoDate(row.retrieved_at, 'retrieved_at') : null,
    data_as_of: sanitizeText(row?.data_as_of, null, 32)
  };
}

function sanitizeObservation(row) {
  const ticker = sanitizeText(row?.ticker, null, 32);
  const field = sanitizeText(row?.field_name, null, 80);
  if (!ticker || !field) throw new Error('observation row requires ticker and field_name');
  return {
    ticker,
    field_name: field,
    value_json: JSON.stringify(row?.value ?? null),
    source_family: sanitizeText(row?.source_family, null, 80),
    retrieved_at: row?.retrieved_at ? isoDate(row.retrieved_at, 'retrieved_at') : null,
    data_as_of: sanitizeText(row?.data_as_of, null, 32)
  };
}

function sanitizeReasonRows(rows = [], fallbackReason = 'unspecified') {
  return rows.map((row) => ({
    ticker: sanitizeText(row?.ticker, 'UNKNOWN', 32),
    reason: sanitizeText(row?.reason, fallbackReason, 240),
    recoverable: row?.recoverable === true
  }));
}

function normalizeRun(run) {
  const market = assertSafeSlug(String(run?.market ?? 'ASX').toUpperCase(), 'market');
  const source = assertSafeSlug(String(run?.source ?? 'yahoo-finance'), 'source');
  const mode = assertSafeSlug(String(run?.mode ?? 'fixture'), 'mode');
  const completed_at = isoDate(run?.completed_at ?? new Date(), 'completed_at');
  const started_at = isoDate(run?.started_at ?? completed_at, 'started_at');
  const companies = (run?.companies ?? []).map((row) => sanitizeCompany(row, market));
  const scores = (run?.scores ?? []).map((row, index) => sanitizeScore(row, market, index));
  const provenance = (run?.provenance ?? []).map(sanitizeProvenance);
  const observations = (run?.observations ?? []).map(sanitizeObservation);
  const failures = sanitizeReasonRows(run?.failures ?? [], 'scrape or scoring failure');
  const exclusions = sanitizeReasonRows(run?.exclusions ?? scores.filter((score) => score.excluded).map((score) => ({ ticker: score.ticker, reason: score.exclusion_reason })), 'excluded from ranking');
  if (companies.length === 0) throw new Error('at least one company row is required');
  if (scores.length === 0) throw new Error('at least one score row is required');
  const universeCount = Number.isInteger(Number(run?.universe?.count)) ? Number(run.universe.count) : companies.length;
  return {
    market,
    source,
    mode,
    fixture: mode === 'fixture',
    started_at,
    completed_at,
    generated_at: isoDate(run?.generated_at ?? completed_at, 'generated_at'),
    data_as_of: sanitizeText(run?.data_as_of, null, 32),
    universe: {
      source: sanitizeText(run?.universe?.source, mode === 'fixture' ? 'fixture sample universe' : 'configured universe', 120),
      version: sanitizeText(run?.universe?.version, null, 120),
      market,
      count: universeCount,
      complete_exchange_listing: run?.universe?.complete_exchange_listing === true
    },
    companies,
    observations,
    scores,
    provenance,
    failures,
    exclusions
  };
}

function coverageForRun(run) {
  const usable = run.scores.filter((score) => !score.excluded && score.composite_score !== null).length;
  const scored = run.scores.filter((score) => score.composite_score !== null).length;
  const excluded = run.scores.filter((score) => score.excluded).length;
  const denominator = run.universe.count || run.companies.length;
  return {
    denominator,
    denominator_label: run.universe.source,
    denominator_status: run.fixture ? 'sample' : 'known_sample_universe',
    scraped: run.companies.length,
    scored,
    usable,
    excluded,
    failed: run.failures.length,
    stale: 0,
    missing_required_fields: run.exclusions.length,
    percent: denominator > 0 ? Number(((usable / denominator) * 100).toFixed(1)) : null,
    caveats: run.fixture
      ? ['Fixture/sample data only — not a real ASX scrape/backfill.']
      : ['Coverage is for the configured universe, not necessarily the full exchange.']
  };
}

function rankedCandidates(run) {
  return run.scores
    .filter((score) => !score.excluded && score.composite_score !== null)
    .sort((left, right) => right.composite_score - left.composite_score || left.rank - right.rank)
    .map((score, index) => ({
      rank: index + 1,
      ticker: score.ticker,
      name: score.name,
      market: score.market,
      currency: score.currency,
      score: score.composite_score,
      sub_scores: score.sub_scores,
      missing_penalty_points: 0,
      risk_flags: [],
      caveats: [],
      score_caps: [],
      sanitized_provenance_summary: `${run.provenance.filter((row) => row.ticker === score.ticker).length} provenance row(s)`
    }));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonl(path, rows) {
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

async function writeParquet(path, schema, rows) {
  const writer = await ParquetWriter.openFile(schema, path);
  try {
    for (const row of rows) await writer.appendRow(row);
  } finally {
    await writer.close();
  }
}

async function fileArtifact(stageDir, name, publicName, rows) {
  const path = join(stageDir, name);
  const info = await stat(path);
  return [publicName, { path: name, bytes: info.size, rows, sha256: await sha256File(path) }];
}

async function appendFileAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, content, 'utf8');
  await rename(temp, path);
}

function relativeFromStore(dataRoot, path) {
  return relative(join(dataRoot, ROOT_DIR), path).replaceAll('\\', '/');
}

async function preservePreviousLatest(manifestDir) {
  const latest = join(manifestDir, 'latest.json');
  if (!existsSync(latest)) return;
  await writeFileAtomic(join(manifestDir, 'latest.previous.json'), await readFile(latest, 'utf8'));
}

export async function publishInvestmentScreenerRun({ dataRoot, run, now = new Date() }) {
  if (!dataRoot) throw new Error('dataRoot is required');
  const normalized = normalizeRun(run);
  const contentHash = sha256Buffer(Buffer.from(stableJson(normalized))).slice(0, 12);
  const runId = `investment-screener_${normalized.market}_${normalized.mode}_${compactTimestamp(normalized.completed_at)}_${contentHash}`;
  const runDate = dateOnly(normalized.completed_at);
  const runParent = join(dataRoot, ROOT_DIR, 'runs', `market=${normalized.market}`, `source=${normalized.source}`, `mode=${normalized.mode}`, `run_date=${runDate}`);
  const runDir = join(runParent, runId);
  const stageDir = join(runParent, `._STAGED_${runId}_${process.pid}`);
  const manifestDir = join(dataRoot, ROOT_DIR, 'manifests', `market=${normalized.market}`, `source=${normalized.source}`);

  if (existsSync(runDir)) throw new Error(`run already exists: ${runId}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  try {
    const coverage = coverageForRun(normalized);
    const ranked = rankedCandidates(normalized);
    const scoreRows = normalized.scores.map((score) => ({ ...score, sub_scores_json: JSON.stringify(score.sub_scores) }));
    const dashboard = {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      mode: normalized.mode,
      generated_at: normalized.generated_at,
      data_as_of: normalized.data_as_of,
      run_id: runId,
      candidates: ranked,
      excluded: normalized.scores.filter((score) => score.excluded),
      source_summary: {
        mode: normalized.mode,
        providers: [normalized.source],
        source_families: [...new Set(normalized.provenance.map((row) => row.source_family).filter(Boolean))],
        universe_source: normalized.universe.source,
        universe_version: normalized.universe.version,
        latest_retrieved_at: normalized.provenance.map((row) => row.retrieved_at).filter(Boolean).sort().at(-1) ?? null,
        latest_hydrated_at: normalized.completed_at,
        data_as_of: normalized.data_as_of,
        provenance_rows: normalized.provenance.length,
        provenance_fields: new Set(normalized.provenance.map((row) => row.field_name)).size,
        caveats: coverage.caveats
      },
      coverage
    };

    await writeJsonl(join(stageDir, 'companies.jsonl'), normalized.companies);
    await writeParquet(join(stageDir, 'companies.parquet'), COMPANY_PARQUET_SCHEMA, normalized.companies);
    await writeJsonl(join(stageDir, 'observations.jsonl'), normalized.observations);
    await writeParquet(join(stageDir, 'observations.parquet'), OBSERVATION_PARQUET_SCHEMA, normalized.observations);
    await writeJsonl(join(stageDir, 'scores.jsonl'), normalized.scores);
    await writeParquet(join(stageDir, 'scores.parquet'), SCORE_PARQUET_SCHEMA, scoreRows);
    await writeJsonl(join(stageDir, 'provenance.jsonl'), normalized.provenance);
    await writeParquet(join(stageDir, 'provenance.parquet'), PROVENANCE_PARQUET_SCHEMA, normalized.provenance);
    await writeJson(join(stageDir, 'coverage.json'), coverage);
    await writeJsonl(join(stageDir, 'failures.jsonl'), normalized.failures);
    await writeJsonl(join(stageDir, 'exclusions.jsonl'), normalized.exclusions);
    await writeJsonl(join(stageDir, 'ranked_candidates.jsonl'), ranked);
    await writeParquet(join(stageDir, 'ranked_candidates.parquet'), SCORE_PARQUET_SCHEMA, ranked.map((candidate) => ({
      rank: candidate.rank,
      ticker: candidate.ticker,
      name: candidate.name,
      market: candidate.market,
      currency: candidate.currency,
      composite_score: candidate.score,
      sub_scores_json: JSON.stringify(candidate.sub_scores),
      excluded: false,
      exclusion_reason: null
    })));
    await writeJson(join(stageDir, 'latest_ranked.json'), dashboard);

    const artifactEntries = [];
    for (const [name, publicName, rows] of [
      ['companies.jsonl', 'companies_jsonl', normalized.companies.length],
      ['companies.parquet', 'companies_parquet', normalized.companies.length],
      ['observations.jsonl', 'observations_jsonl', normalized.observations.length],
      ['observations.parquet', 'observations_parquet', normalized.observations.length],
      ['scores.jsonl', 'scores_jsonl', normalized.scores.length],
      ['scores.parquet', 'scores_parquet', normalized.scores.length],
      ['provenance.jsonl', 'provenance_jsonl', normalized.provenance.length],
      ['provenance.parquet', 'provenance_parquet', normalized.provenance.length],
      ['coverage.json', 'coverage_json', 1],
      ['failures.jsonl', 'failures_jsonl', normalized.failures.length],
      ['exclusions.jsonl', 'exclusions_jsonl', normalized.exclusions.length],
      ['ranked_candidates.jsonl', 'ranked_candidates_jsonl', ranked.length],
      ['ranked_candidates.parquet', 'ranked_candidates_parquet', ranked.length],
      ['latest_ranked.json', 'latest_ranked_json', 1]
    ]) {
      artifactEntries.push(await fileArtifact(stageDir, name, publicName, rows));
    }
    const artifacts = Object.fromEntries(artifactEntries);
    const checksums = Object.values(artifacts).map((artifact) => `${artifact.sha256}  ${artifact.path}`).sort().join('\n') + '\n';
    await writeFile(join(stageDir, 'checksums.sha256'), checksums, 'utf8');

    const manifest = {
      schema_version: MANIFEST_SCHEMA_VERSION,
      run_id: runId,
      run_key: `investment-screener:${normalized.market}:${normalized.mode}:${normalized.completed_at}:${contentHash}`,
      market: normalized.market,
      source: normalized.source,
      mode: normalized.mode,
      status: 'completed',
      fixture: normalized.fixture,
      started_at: normalized.started_at,
      completed_at: normalized.completed_at,
      generated_at: isoDate(now, 'now'),
      data_as_of: normalized.data_as_of,
      universe: normalized.universe,
      coverage,
      provenance_sources: [...new Set(normalized.provenance.map((row) => row.source_family).filter(Boolean))],
      latest_retrieved_at: normalized.provenance.map((row) => row.retrieved_at).filter(Boolean).sort().at(-1) ?? null,
      artifacts,
      relative_manifest_path: `runs/market=${normalized.market}/source=${normalized.source}/mode=${normalized.mode}/run_date=${runDate}/${runId}/manifest.json`
    };
    await writeJson(join(stageDir, 'manifest.json'), manifest);

    await rename(stageDir, runDir);
    await mkdir(manifestDir, { recursive: true });
    await preservePreviousLatest(manifestDir);
    const latest = {
      schema_version: LATEST_SCHEMA_VERSION,
      market: normalized.market,
      source: normalized.source,
      mode: normalized.mode,
      run_id: runId,
      completed_at: normalized.completed_at,
      run_manifest: manifest.relative_manifest_path,
      coverage: { usable: coverage.usable, denominator: coverage.denominator, percent: coverage.percent },
      published_at: isoDate(now, 'now')
    };
    await writeFileAtomic(join(manifestDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
    await appendFileAtomic(join(manifestDir, 'runs.jsonl'), `${JSON.stringify(latest)}\n`);

    const exportDir = join(dataRoot, ROOT_DIR, 'exports', 'dashboard', `market=${normalized.market}`);
    await writeFileAtomic(join(exportDir, 'latest_ranked.json'), `${JSON.stringify(dashboard, null, 2)}\n`);
    await writeFileAtomic(join(exportDir, 'latest_coverage.json'), `${JSON.stringify({
      market: normalized.market,
      source: 'published-artifact',
      generated_at: normalized.generated_at,
      source_summary: dashboard.source_summary,
      coverage
    }, null, 2)}\n`);
    await writeFileAtomic(join(exportDir, 'latest_report.txt'), `Investment Screener ${normalized.market}\nRun: ${manifest.run_id}\nUsable: ${coverage.usable} / ${coverage.denominator}\n`);

    return { run_id: runId, run_dir: runDir, manifest, latest };
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    throw err;
  }
}

export async function readLatestInvestmentScreenerManifest({ dataRoot, market = 'ASX', source = 'yahoo-finance' }) {
  const safeMarket = assertSafeSlug(String(market).toUpperCase(), 'market');
  const safeSource = assertSafeSlug(String(source), 'source');
  const latestPath = join(dataRoot, ROOT_DIR, 'manifests', `market=${safeMarket}`, `source=${safeSource}`, 'latest.json');
  return JSON.parse(await readFile(latestPath, 'utf8'));
}

async function duckRows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJS();
}

export async function buildInvestmentScreenerDuckDbSummary({ dataRoot, market = 'ASX', source = 'yahoo-finance' }) {
  const safeMarket = assertSafeSlug(String(market).toUpperCase(), 'market');
  const safeSource = assertSafeSlug(String(source), 'source');
  const latest = await readLatestInvestmentScreenerManifest({ dataRoot, market: safeMarket, source: safeSource });
  const manifest = JSON.parse(await readFile(join(dataRoot, ROOT_DIR, latest.run_manifest), 'utf8'));
  const runDir = dirname(join(dataRoot, ROOT_DIR, latest.run_manifest));
  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  try {
    const rankedParquet = join(runDir, manifest.artifacts.ranked_candidates_parquet.path).replaceAll("'", "''");
    await connection.run(`CREATE OR REPLACE TABLE ranked_candidates AS SELECT * FROM read_parquet('${rankedParquet}')`);
    const rankedRows = await duckRows(connection, `
      SELECT rank, ticker, name, market, currency, composite_score AS score, sub_scores_json
      FROM ranked_candidates
      WHERE market = '${safeMarket}' AND excluded = false AND composite_score IS NOT NULL
      ORDER BY composite_score DESC, rank ASC
      LIMIT 100
    `);
    const ranked = rankedRows.map((row) => ({
      rank: Number(row.rank),
      ticker: row.ticker,
      name: row.name,
      market: row.market,
      currency: row.currency,
      score: Number(row.score),
      sub_scores: row.sub_scores_json ? JSON.parse(row.sub_scores_json) : {}
    }));
    const coverage = {
      ...manifest.coverage,
      usable: ranked.length,
      percent: manifest.coverage.denominator > 0 ? Number(((ranked.length / manifest.coverage.denominator) * 100).toFixed(1)) : null
    };
    const summary = {
      schema_version: 'investment-screener-duckdb-summary/v1',
      source: 'duckdb',
      run_id: manifest.run_id,
      market: safeMarket,
      generated_at: new Date().toISOString(),
      source_summary: {
        mode: manifest.mode,
        providers: [manifest.source],
        source_families: [...new Set(manifest.provenance_sources ?? [])],
        latest_retrieved_at: manifest.latest_retrieved_at ?? null,
        universe_source: manifest.universe.source,
        universe_version: manifest.universe.version,
        data_as_of: manifest.data_as_of,
        provenance_rows: manifest.artifacts.provenance_parquet.rows
      },
      coverage,
      ranked_candidates: ranked
    };
    return summary;
  } finally {
    connection.closeSync();
    db.closeSync();
  }
}

export function investmentScreenerStorePaths({ dataRoot, market = 'ASX', source = 'yahoo-finance' }) {
  const safeMarket = assertSafeSlug(String(market).toUpperCase(), 'market');
  const safeSource = assertSafeSlug(String(source), 'source');
  return {
    root: join(dataRoot, ROOT_DIR),
    latest_manifest: join(dataRoot, ROOT_DIR, 'manifests', `market=${safeMarket}`, `source=${safeSource}`, 'latest.json'),
    dashboard_ranked: join(dataRoot, ROOT_DIR, 'exports', 'dashboard', `market=${safeMarket}`, 'latest_ranked.json'),
    dashboard_coverage: join(dataRoot, ROOT_DIR, 'exports', 'dashboard', `market=${safeMarket}`, 'latest_coverage.json')
  };
}
