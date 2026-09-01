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
  currency: { type: 'UTF8', optional: true },
  sector: { type: 'UTF8', optional: true },
  industry: { type: 'UTF8', optional: true }
});

const SCORE_PARQUET_SCHEMA = new ParquetSchema({
  rank: { type: 'INT64', optional: true },
  ticker: { type: 'UTF8' },
  name: { type: 'UTF8', optional: true },
  market: { type: 'UTF8' },
  currency: { type: 'UTF8', optional: true },
  sector: { type: 'UTF8', optional: true },
  industry: { type: 'UTF8', optional: true },
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

function sanitizeTextArray(values, maxItems = 12, maxLength = 240) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => sanitizeText(value, null, maxLength)).filter(Boolean).slice(0, maxItems);
}

function sanitizeCompany(row, fallbackMarket) {
  const ticker = sanitizeText(row?.ticker, null, 32);
  const name = sanitizeText(row?.name, null, 180);
  if (!ticker) throw new Error('company row requires ticker');
  return {
    ticker,
    name: name ?? ticker,
    market: assertSafeSlug(String(row?.market ?? fallbackMarket).toUpperCase(), 'company market'),
    currency: sanitizeText(row?.currency, null, 16),
    sector: sanitizeText(row?.sector, null, 80),
    industry: sanitizeText(row?.industry, null, 80)
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
    sector: sanitizeText(row?.sector, null, 80),
    industry: sanitizeText(row?.industry, null, 80),
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
    recoverable: row?.recoverable === true,
    provider: sanitizeText(row?.provider, null, 80),
    source_family: sanitizeText(row?.source_family, row?.provider ?? null, 80),
    failed_at: row?.failed_at ? isoDate(row.failed_at, 'failed_at') : null
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
      version: sanitizeText(run?.universe?.version, null, 240),
      market,
      count: universeCount,
      complete_exchange_listing: run?.universe?.complete_exchange_listing === true,
      full_count: Number.isInteger(Number(run?.universe?.full_count)) ? Number(run.universe.full_count) : null,
      selected_count: Number.isInteger(Number(run?.universe?.selected_count)) ? Number(run.universe.selected_count) : universeCount,
      batch_offset: Number.isInteger(Number(run?.universe?.batch_offset)) ? Number(run.universe.batch_offset) : null,
      batch_end_exclusive: Number.isInteger(Number(run?.universe?.batch_end_exclusive)) ? Number(run.universe.batch_end_exclusive) : null,
      source_row_count: Number.isInteger(Number(run?.universe?.source_row_count)) ? Number(run.universe.source_row_count) : null,
      normalized_active_count: Number.isInteger(Number(run?.universe?.normalized_active_count)) ? Number(run.universe.normalized_active_count) : null,
      source_sha256: sanitizeText(run?.universe?.source_sha256, null, 80),
      source_retrieved_at: sanitizeText(run?.universe?.source_retrieved_at, null, 40)
    },
    companies,
    observations,
    scores,
    provenance,
    failures,
    exclusions,
    coverage: run?.coverage && typeof run.coverage === 'object' && !Array.isArray(run.coverage) ? run.coverage : {}
  };
}

function parseDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hoursBetween(later, earlier) {
  if (!later || !earlier) return null;
  return Number(((later.getTime() - earlier.getTime()) / 36e5).toFixed(1));
}

function daysBetween(later, earlier) {
  if (!later || !earlier) return null;
  return Math.floor((later.getTime() - earlier.getTime()) / 864e5);
}

function freshnessForRun(run, now = new Date()) {
  const latestRetrievedAt = run.provenance.map((row) => row.retrieved_at).filter(Boolean).sort().at(-1) ?? null;
  const generatedAt = parseDateOrNull(run.generated_at);
  const latestRetrievedDate = parseDateOrNull(latestRetrievedAt);
  const dataAsOfDate = parseDateOrNull(run.data_as_of);
  const generatedAgeHours = hoursBetween(now, generatedAt);
  const latestRetrievedAgeHours = hoursBetween(now, latestRetrievedDate);
  const dataAsOfAgeDays = daysBetween(now, dataAsOfDate);
  const maxGeneratedAgeHours = Number.isFinite(Number(run.coverage?.max_generated_age_hours)) ? Number(run.coverage.max_generated_age_hours) : 26;
  const maxSourceAgeHours = Number.isFinite(Number(run.coverage?.max_source_age_hours)) ? Number(run.coverage.max_source_age_hours) : 26;
  const maxDataAsOfAgeDays = Number.isFinite(Number(run.coverage?.max_data_as_of_age_days)) ? Number(run.coverage.max_data_as_of_age_days) : 370;
  const warnings = [];
  if (generatedAgeHours !== null && generatedAgeHours > maxGeneratedAgeHours) warnings.push(`Generated artifact is ${generatedAgeHours}h old, older than ${maxGeneratedAgeHours}h freshness threshold.`);
  if (latestRetrievedAgeHours !== null && latestRetrievedAgeHours > maxSourceAgeHours) warnings.push(`Latest provider retrieval is ${latestRetrievedAgeHours}h old, older than ${maxSourceAgeHours}h freshness threshold.`);
  if (dataAsOfAgeDays !== null && dataAsOfAgeDays > maxDataAsOfAgeDays) warnings.push(`Source data_as_of is ${dataAsOfAgeDays}d old, older than ${maxDataAsOfAgeDays}d freshness threshold.`);
  if (!latestRetrievedAt && !run.fixture) warnings.push('No provider retrieved_at timestamp is available for this non-fixture run.');
  return {
    generated_at: run.generated_at,
    generated_age_hours: generatedAgeHours,
    latest_retrieved_at: latestRetrievedAt,
    latest_retrieved_age_hours: latestRetrievedAgeHours,
    data_as_of: run.data_as_of,
    data_as_of_age_days: dataAsOfAgeDays,
    stale: warnings.length > 0,
    stale_thresholds: {
      max_generated_age_hours: maxGeneratedAgeHours,
      max_source_age_hours: maxSourceAgeHours,
      max_data_as_of_age_days: maxDataAsOfAgeDays
    }
  };
}

// Reconstruct freshness from a published run manifest for artifacts that predate
// the freshness metadata (pre-6227ed2): the manifest carries top-level
// latest_retrieved_at / generated_at / completed_at / data_as_of but no coverage.freshness.
function freshnessFromManifest(manifest, now = new Date()) {
  const latestRetrievedAt = manifest.latest_retrieved_at ?? manifest.coverage?.freshness?.latest_retrieved_at ?? null;
  const generatedAt = manifest.generated_at ?? manifest.completed_at ?? null;
  const dataAsOf = manifest.data_as_of ?? null;
  const generatedDate = parseDateOrNull(generatedAt);
  const latestRetrievedDate = parseDateOrNull(latestRetrievedAt);
  const dataAsOfDate = parseDateOrNull(dataAsOf);
  const generatedAgeHours = hoursBetween(now, generatedDate);
  const latestRetrievedAgeHours = hoursBetween(now, latestRetrievedDate);
  const dataAsOfAgeDays = daysBetween(now, dataAsOfDate);
  const maxGeneratedAgeHours = Number.isFinite(Number(manifest.coverage?.max_generated_age_hours)) ? Number(manifest.coverage.max_generated_age_hours) : 26;
  const maxSourceAgeHours = Number.isFinite(Number(manifest.coverage?.max_source_age_hours)) ? Number(manifest.coverage.max_source_age_hours) : 26;
  const maxDataAsOfAgeDays = Number.isFinite(Number(manifest.coverage?.max_data_as_of_age_days)) ? Number(manifest.coverage.max_data_as_of_age_days) : 370;
  const warnings = [];
  if (generatedAgeHours !== null && generatedAgeHours > maxGeneratedAgeHours) warnings.push(`Generated artifact is ${generatedAgeHours}h old, older than ${maxGeneratedAgeHours}h freshness threshold.`);
  if (latestRetrievedAgeHours !== null && latestRetrievedAgeHours > maxSourceAgeHours) warnings.push(`Latest provider retrieval is ${latestRetrievedAgeHours}h old, older than ${maxSourceAgeHours}h freshness threshold.`);
  if (dataAsOfAgeDays !== null && dataAsOfAgeDays > maxDataAsOfAgeDays) warnings.push(`Source data_as_of is ${dataAsOfAgeDays}d old, older than ${maxDataAsOfAgeDays}d freshness threshold.`);
  if (!latestRetrievedAt && !manifest.fixture) warnings.push('No provider retrieved_at timestamp is available for this non-fixture run.');
  return {
    generated_at: generatedAt,
    generated_age_hours: generatedAgeHours,
    latest_retrieved_at: latestRetrievedAt,
    latest_retrieved_age_hours: latestRetrievedAgeHours,
    data_as_of: dataAsOf,
    data_as_of_age_days: dataAsOfAgeDays,
    stale: warnings.length > 0,
    stale_thresholds: {
      max_generated_age_hours: maxGeneratedAgeHours,
      max_source_age_hours: maxSourceAgeHours,
      max_data_as_of_age_days: maxDataAsOfAgeDays
    }
  };
}

// Re-derive the human-readable staleness warnings from a constructed freshness blob,
// matching the wording the publisher emits in coverageForRun.
function freshnessWarningsFor(freshness) {
  if (!freshness || !freshness.stale) return [];
  const warnings = [];
  const generatedAge = freshness.generated_age_hours;
  if (generatedAge !== null && generatedAge > freshness.stale_thresholds.max_generated_age_hours) warnings.push(`Generated artifact is ${generatedAge}h old, older than ${freshness.stale_thresholds.max_generated_age_hours}h freshness threshold.`);
  const sourceAge = freshness.latest_retrieved_age_hours;
  if (sourceAge !== null && sourceAge > freshness.stale_thresholds.max_source_age_hours) warnings.push(`Latest provider retrieval is ${sourceAge}h old, older than ${freshness.stale_thresholds.max_source_age_hours}h freshness threshold.`);
  const dataAge = freshness.data_as_of_age_days;
  if (dataAge !== null && dataAge > freshness.stale_thresholds.max_data_as_of_age_days) warnings.push(`Source data_as_of is ${dataAge}d old, older than ${freshness.stale_thresholds.max_data_as_of_age_days}d freshness threshold.`);
  return warnings;
}

function coverageForRun(run, now = new Date()) {
  const supplied = run.coverage && typeof run.coverage === 'object' ? run.coverage : {};
  const usable = run.scores.filter((score) => !score.excluded && score.composite_score !== null).length;
  const scored = run.scores.filter((score) => score.composite_score !== null).length;
  const excluded = run.scores.filter((score) => score.excluded).length;
  const selectedCount = Number.isInteger(Number(run.universe.selected_count)) ? Number(run.universe.selected_count) : null;
  const denominator = selectedCount || run.universe.count || run.companies.length;
  const status = sanitizeText(supplied.denominator_status, null, 80) ?? (run.fixture ? 'sample' : (run.universe.complete_exchange_listing ? 'complete_exchange_listing' : 'known_sample_universe'));
  const freshness = freshnessForRun(run, now);
  const warnings = [...(Array.isArray(supplied.warnings) ? sanitizeTextArray(supplied.warnings, 12, 240) : [])];
  if (freshness.stale) {
    const generatedAge = freshness.generated_age_hours;
    if (generatedAge !== null && generatedAge > freshness.stale_thresholds.max_generated_age_hours) warnings.push(`Generated artifact is ${generatedAge}h old, older than ${freshness.stale_thresholds.max_generated_age_hours}h freshness threshold.`);
    const sourceAge = freshness.latest_retrieved_age_hours;
    if (sourceAge !== null && sourceAge > freshness.stale_thresholds.max_source_age_hours) warnings.push(`Latest provider retrieval is ${sourceAge}h old, older than ${freshness.stale_thresholds.max_source_age_hours}h freshness threshold.`);
    const dataAge = freshness.data_as_of_age_days;
    if (dataAge !== null && dataAge > freshness.stale_thresholds.max_data_as_of_age_days) warnings.push(`Source data_as_of is ${dataAge}d old, older than ${freshness.stale_thresholds.max_data_as_of_age_days}d freshness threshold.`);
    if (!freshness.latest_retrieved_at && !run.fixture) warnings.push('No provider retrieved_at timestamp is available for this non-fixture run.');
  }
  return {
    denominator,
    denominator_label: sanitizeText(supplied.denominator_label, run.universe.source, 240),
    denominator_status: status,
    scraped: run.companies.length,
    scored,
    usable,
    excluded,
    failed: run.failures.length,
    stale: freshness.stale,
    missing_required_fields: run.exclusions.length,
    percent: denominator > 0 ? Number(((usable / denominator) * 100).toFixed(1)) : null,
    freshness,
    warnings,
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
      sector: score.sector ?? null,
      industry: score.industry ?? null,
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
    const coverage = coverageForRun(normalized, now);
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
        latest_retrieved_at: coverage.freshness.latest_retrieved_at,
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
      sector: candidate.sector ?? null,
      industry: candidate.industry ?? null,
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
      latest_retrieved_at: coverage.freshness.latest_retrieved_at,
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

function normalizeTicker(value) {
  const ticker = sanitizeText(value, null, 32)?.toUpperCase();
  if (!ticker || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(ticker)) {
    const error = new Error('invalid company ticker');
    error.code = 'invalid_ticker';
    throw error;
  }
  return ticker;
}

function parseJsonlRows(content) {
  return String(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readManifestArtifactRows({ dataRoot, manifest, runDir, artifactName }) {
  const artifact = manifest?.artifacts?.[artifactName];
  if (!artifact?.path) return [];
  const artifactPath = join(runDir, artifact.path);
  const relativePath = relative(join(dataRoot, ROOT_DIR), artifactPath);
  if (relativePath.startsWith('..') || relativePath.startsWith('/')) throw new Error('artifact path escaped screener root');
  return parseJsonlRows(await readFile(artifactPath, 'utf8'));
}

function parsedObservationValue(row) {
  if (Object.prototype.hasOwnProperty.call(row, 'value')) return row.value;
  if (!Object.prototype.hasOwnProperty.call(row, 'value_json')) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

function observationMap(rows, ticker) {
  const wanted = normalizeTicker(ticker);
  const byField = new Map();
  for (const row of rows) {
    if (normalizeTicker(row?.ticker ?? 'UNKNOWN') !== wanted) continue;
    const field = sanitizeText(row?.field_name, null, 80);
    if (!field) continue;
    byField.set(field, {
      field,
      value: parsedObservationValue(row),
      source_family: sanitizeText(row?.source_family, null, 80),
      retrieved_at: row?.retrieved_at ? isoDate(row.retrieved_at, 'retrieved_at') : null,
      data_as_of: sanitizeText(row?.data_as_of, null, 32)
    });
  }
  return byField;
}

function provenanceMap(rows, ticker) {
  const wanted = normalizeTicker(ticker);
  const byField = new Map();
  for (const row of rows) {
    if (normalizeTicker(row?.ticker ?? 'UNKNOWN') !== wanted) continue;
    const field = sanitizeText(row?.field_name, null, 80);
    if (!field) continue;
    byField.set(field, {
      field,
      source_family: sanitizeText(row?.source_family, null, 80),
      provider: sanitizeText(row?.provider, null, 80),
      retrieved_at: row?.retrieved_at ? isoDate(row.retrieved_at, 'retrieved_at') : null,
      data_as_of: sanitizeText(row?.data_as_of, null, 32)
    });
  }
  return byField;
}

function valueState(value, hasEvidence) {
  if (!hasEvidence) return 'unavailable';
  if (value === null || value === undefined || value === '') return 'missing';
  return 'present';
}

function trimFixed(value, decimals) {
  const fixed = value.toFixed(decimals);
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '.0');
}

function formatLargeNumber(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  if (number === 0) return '0';
  const sign = number < 0 ? '-' : '';
  const absolute = Math.abs(number);
  const units = [
    { threshold: 1_000_000_000_000, suffix: 'T' },
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' }
  ];
  const unit = units.find((candidate) => absolute >= candidate.threshold);
  if (!unit) return `${sign}${trimFixed(absolute, absolute >= 100 ? 0 : 2)}`;
  return `${sign}${trimFixed(absolute / unit.threshold, 1)}${unit.suffix}`;
}

function formatRatio(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  const decimals = Math.abs(number) >= 10 ? 1 : 2;
  return `${trimFixed(number, decimals)}x`;
}

function formatPercent(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return `${trimFixed(number * 100, 1)}%`;
}

function displayForField({ state, value, kind, unit }) {
  const base = {
    display_kind: kind ?? 'raw',
    ...(unit ? { display_unit: unit } : {})
  };
  if (state === 'missing') return { ...base, display_value: 'Missing' };
  if (state !== 'present') return { ...base, display_value: 'Unavailable' };
  if (kind === 'currency' || kind === 'large-number') return { ...base, display_value: formatLargeNumber(value) };
  if (kind === 'ratio') return { ...base, display_value: formatRatio(value) };
  if (kind === 'percentage') return { ...base, display_value: formatPercent(value) };
  return { ...base, display_value: String(value) };
}

function observedField(field, label, observations, provenance, unsupportedReason = null, display = {}) {
  const observation = observations.get(field);
  const source = provenance.get(field) ?? null;
  const state = unsupportedReason ? 'unavailable' : valueState(observation?.value, Boolean(observation));
  const value = state === 'present' ? observation.value : null;
  return {
    field,
    label,
    state,
    value,
    ...displayForField({ state, value, kind: display.kind, unit: display.unit }),
    source_family: source?.source_family ?? observation?.source_family ?? null,
    retrieved_at: source?.retrieved_at ?? observation?.retrieved_at ?? null,
    data_as_of: source?.data_as_of ?? observation?.data_as_of ?? null,
    ...(unsupportedReason && state === 'unavailable' ? { note: unsupportedReason } : {})
  };
}

function scoreField(field, label, score) {
  const raw = field === 'composite_score' ? score?.composite_score : score?.sub_scores?.[field];
  const value = numberOrNull(raw);
  return { field, label, state: value === null ? 'unavailable' : 'present', value };
}

function latestIso(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function unavailableRows(sections) {
  const rows = [];
  for (const section of sections) {
    for (const field of Object.values(section)) {
      if (field && typeof field === 'object' && ['missing', 'unavailable'].includes(field.state)) {
        rows.push({ field: field.field, label: field.label, state: field.state, note: field.note ?? (field.state === 'missing' ? 'Missing in latest source.' : 'Unavailable from current source.') });
      }
    }
  }
  return rows;
}

export async function readInvestmentScreenerCompanyDetail({ dataRoot, ticker, market = 'ASX', source = 'yahoo-finance' }) {
  if (!dataRoot) {
    const error = new Error('investment screener data root is not configured');
    error.code = 'not_configured';
    throw error;
  }
  const wantedTicker = normalizeTicker(ticker);
  const safeMarket = assertSafeSlug(String(market).toUpperCase(), 'market');
  const safeSource = assertSafeSlug(String(source), 'source');
  const latest = await readLatestInvestmentScreenerManifest({ dataRoot, market: safeMarket, source: safeSource });
  const manifestPath = join(dataRoot, ROOT_DIR, latest.run_manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const runDir = dirname(manifestPath);
  const [companies, scores, observationsRows, provenanceRows] = await Promise.all([
    readManifestArtifactRows({ dataRoot, manifest, runDir, artifactName: 'companies_jsonl' }),
    readManifestArtifactRows({ dataRoot, manifest, runDir, artifactName: 'scores_jsonl' }),
    readManifestArtifactRows({ dataRoot, manifest, runDir, artifactName: 'observations_jsonl' }),
    readManifestArtifactRows({ dataRoot, manifest, runDir, artifactName: 'provenance_jsonl' })
  ]);
  const company = companies.find((row) => normalizeTicker(row?.ticker ?? 'UNKNOWN') === wantedTicker);
  const score = scores.find((row) => normalizeTicker(row?.ticker ?? 'UNKNOWN') === wantedTicker) ?? null;
  if (!company && !score) {
    const error = new Error('company not found');
    error.code = 'not_found';
    throw error;
  }
  const observations = observationMap(observationsRows, wantedTicker);
  const provenance = provenanceMap(provenanceRows, wantedTicker);
  const unsupported = 'Unavailable from current source; the current sanitized ASX/Yahoo export does not include this field.';
  const currency = sanitizeText(company?.currency ?? score?.currency, null, 16);
  const currencyDisplay = { kind: 'currency', unit: currency };
  const ratioDisplay = { kind: 'ratio' };
  const percentageDisplay = { kind: 'percentage' };
  const valuation = {
    market_cap: observedField('market_cap', 'Market cap', observations, provenance, null, currencyDisplay),
    pe_ratio: observedField('pe_ratio', 'P/E ratio', observations, provenance, null, ratioDisplay),
    price_to_sales: observedField('price_to_sales', 'Price / sales', observations, provenance, null, ratioDisplay)
  };
  const qualityGrowthSafety = {
    composite_score: scoreField('composite_score', 'Composite score', score),
    quality: scoreField('quality', 'Quality score', score),
    valuation: scoreField('valuation', 'Valuation score', score),
    growth: scoreField('growth', 'Growth score', score),
    net_margin: observedField('net_margin', 'Net margin', observations, provenance, null, percentageDisplay),
    roe: observedField('roe', 'Return on equity', observations, provenance, null, percentageDisplay),
    fcf: observedField('fcf', 'Free cash flow', observations, provenance, null, currencyDisplay),
    fcf_margin: observedField('fcf_margin', 'FCF margin', observations, provenance, null, percentageDisplay),
    revenue_growth: observedField('revenue_growth', 'Revenue growth', observations, provenance, null, percentageDisplay),
    current_ratio: observedField('current_ratio', 'Current ratio', observations, provenance, null, ratioDisplay),
    debt_to_assets: observedField('debt_to_assets', 'Debt / assets', observations, provenance, null, percentageDisplay)
  };
  const statements = {
    revenue: observedField('revenue', 'Revenue', observations, provenance, null, currencyDisplay),
    prior_revenue: observedField('prior_revenue', 'Prior revenue', observations, provenance, null, currencyDisplay),
    net_income: observedField('net_income', 'Net income', observations, provenance, null, currencyDisplay),
    operating_cash_flow: observedField('operating_cash_flow', 'Operating cash flow', observations, provenance, null, currencyDisplay),
    capital_expenditures: observedField('capital_expenditures', 'Capital expenditure', observations, provenance, null, currencyDisplay),
    total_assets: observedField('total_assets', 'Total assets', observations, provenance, null, currencyDisplay),
    current_assets: observedField('current_assets', 'Current assets', observations, provenance, null, currencyDisplay),
    total_liabilities: observedField('total_liabilities', 'Total liabilities', observations, provenance, null, currencyDisplay),
    current_liabilities: observedField('current_liabilities', 'Current liabilities', observations, provenance, null, currencyDisplay)
  };
  const dividends = {
    dividend_yield: observedField('dividend_yield', 'Dividend yield', observations, provenance),
    dividend_per_share: observedField('dividend_per_share', 'Dividend per share', observations, provenance)
  };
  const earnings = {
    eps: observedField('eps', 'Earnings per share', observations, provenance, unsupported),
    earnings_date: observedField('earnings_date', 'Next earnings date', observations, provenance, unsupported)
  };
  const balanceCashflow = {
    total_assets: statements.total_assets,
    current_assets: statements.current_assets,
    total_liabilities: statements.total_liabilities,
    current_liabilities: statements.current_liabilities,
    operating_cash_flow: statements.operating_cash_flow,
    capital_expenditures: statements.capital_expenditures
  };
  const provenanceValues = [...provenance.values()];
  const providerNames = [...new Set(provenanceValues.map((row) => row.provider).filter(Boolean))];
  const sourceFamilies = [...new Set(provenanceValues.map((row) => row.source_family).filter(Boolean))];
  const identityUnavailable = ['exchange', 'region'];
  return {
    schema_version: 'investment-screener-company-detail/v1',
    ticker: wantedTicker,
    market: safeMarket,
    run_id: sanitizeText(manifest.run_id, null, 160),
    mode: sanitizeText(manifest.mode, 'unknown', 80),
    identity: {
      ticker: wantedTicker,
      name: sanitizeText(company?.name ?? score?.name, wantedTicker, 180),
      market: sanitizeText(company?.market ?? score?.market, safeMarket, 32),
      exchange: null,
      region: null,
      sector: sanitizeText(company?.sector ?? score?.sector, null, 80),
      industry: sanitizeText(company?.industry ?? score?.industry, null, 80),
      currency,
      unavailable: identityUnavailable
    },
    valuation,
    quality_growth_safety: qualityGrowthSafety,
    statements_summary: statements,
    dividends,
    earnings,
    balance_cashflow_summary: balanceCashflow,
    freshness: {
      generated_at: sanitizeText(manifest.generated_at, null, 80),
      data_as_of: sanitizeText(manifest.data_as_of, null, 32),
      latest_retrieved_at: latestIso(provenanceValues.map((row) => row.retrieved_at))
    },
    source_notes: {
      providers: providerNames,
      source_families: sourceFamilies,
      caveats: manifest.fixture
        ? ['Fixture/sample data only — not a real ASX scrape/backfill.']
        : ['Yahoo Finance public endpoints are unofficial bootstrap evidence; verify against ASX filings before acting.'],
      provenance_rows: provenanceValues.length
    },
    unavailable_data: [
      ...identityUnavailable.map((field) => ({ field, label: field.replaceAll('_', ' '), state: 'unavailable', note: unsupported })),
      ...unavailableRows([valuation, qualityGrowthSafety, statements, dividends, earnings])
    ]
  };
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
      SELECT rank, ticker, name, market, currency, sector, industry, composite_score AS score, sub_scores_json
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
      sector: row.sector ?? null,
      industry: row.industry ?? null,
      score: Number(row.score),
      sub_scores: row.sub_scores_json ? JSON.parse(row.sub_scores_json) : {}
    }));
    const provenanceParquet = join(runDir, manifest.artifacts.provenance_parquet.path).replaceAll("'", "''");
    await connection.run(`CREATE OR REPLACE TABLE provenance AS SELECT * FROM read_parquet('${provenanceParquet}')`);
    const provenanceRows = await duckRows(connection, `
      SELECT count(*) AS provenance_rows, count(DISTINCT field_name) AS provenance_fields
      FROM provenance
    `);
    const provenanceSummary = provenanceRows[0] ?? {};
    const reconstructedFreshness = freshnessFromManifest(manifest);
    const coverage = {
      ...manifest.coverage,
      // Preserve manifest-level coverage counts. ranked_candidates is intentionally
      // capped for the API payload, so deriving usable/percent from ranked.length
      // turns a truthful 184/200 staged run into a fake 100/200 UI-cap result.
      freshness: reconstructedFreshness,
      // Pre-6227ed2 artifacts carry a bare `stale: 0` count; re-derive it from
      // the reconstructed freshness so a stale artifact reads stale in the count too.
      stale: reconstructedFreshness.stale,
      // Surface staleness warnings alongside the reconstructed freshness, mirroring
      // the publisher's coverageForRun, so stale artifacts read as stale end-to-end.
      warnings: [
        ...(Array.isArray(manifest.coverage?.warnings) ? manifest.coverage.warnings : []),
        ...freshnessWarningsFor(reconstructedFreshness)
      ]
    };
    const summary = {
      schema_version: 'investment-screener-duckdb-summary/v1',
      source: 'duckdb',
      run_id: manifest.run_id,
      market: safeMarket,
      generated_at: manifest.generated_at ?? manifest.completed_at ?? null,
      source_summary: {
        mode: manifest.mode,
        providers: [manifest.source],
        source_families: [...new Set(manifest.provenance_sources ?? [])],
        latest_retrieved_at: manifest.latest_retrieved_at ?? null,
        universe_source: manifest.universe.source,
        universe_version: manifest.universe.version,
        data_as_of: manifest.data_as_of,
        provenance_rows: Number(provenanceSummary.provenance_rows ?? manifest.artifacts.provenance_parquet.rows),
        provenance_fields: Number(provenanceSummary.provenance_fields ?? 0)
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
