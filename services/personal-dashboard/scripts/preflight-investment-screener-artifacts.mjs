#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function usage() {
  return `Usage: node scripts/preflight-investment-screener-artifacts.mjs --data-root <root> [--market ASX] [--source yahoo-finance] [--max-generated-age-hours 26]`;
}

function parseArgs(argv) {
  const args = { market: 'ASX', source: 'yahoo-finance', 'max-generated-age-hours': '26' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function assertSafeSlug(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value) || value.includes('..')) {
    throw new Error(`${name} must be a safe slug`);
  }
  return value;
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['data-root']) throw new Error(usage());
  const dataRoot = args['data-root'];
  const market = assertSafeSlug(String(args.market).toUpperCase(), 'market');
  const source = assertSafeSlug(String(args.source), 'source');
  const latestPath = join(dataRoot, 'investment-screener', 'manifests', `market=${market}`, `source=${source}`, 'latest.json');
  const latest = JSON.parse(await readFile(latestPath, 'utf8'));
  const manifestPath = join(dataRoot, 'investment-screener', latest.run_manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const runDir = dirname(manifestPath);
  const required = ['manifest.json', 'checksums.sha256', 'companies.jsonl', 'observations.jsonl', 'scores.jsonl', 'provenance.jsonl', 'coverage.json', 'failures.jsonl', 'exclusions.jsonl', 'ranked_candidates.jsonl', 'ranked_candidates.parquet', 'latest_ranked.json'];
  for (const name of required) {
    const path = join(runDir, name);
    if (!existsSync(path)) throw new Error(`required artifact missing: ${name}`);
    await stat(path);
  }
  const checksumLines = (await readFile(join(runDir, 'checksums.sha256'), 'utf8')).trim().split(/\n+/).filter(Boolean);
  const checksumMap = new Map(checksumLines.map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    return [match[2], match[1]];
  }));
  for (const artifact of Object.values(manifest.artifacts ?? {})) {
    const expected = checksumMap.get(artifact.path);
    if (!expected) throw new Error(`checksum missing for ${artifact.path}`);
    const actual = await sha256File(join(runDir, artifact.path));
    if (actual !== expected || actual !== artifact.sha256) throw new Error(`checksum mismatch for ${artifact.path}`);
  }
  const maxGeneratedAgeHours = Number(args['max-generated-age-hours']);
  const generatedAt = new Date(manifest.generated_at);
  const generatedAgeHours = Number(((Date.now() - generatedAt.getTime()) / 36e5).toFixed(1));
  const stale = Number.isFinite(maxGeneratedAgeHours) && generatedAgeHours > maxGeneratedAgeHours;
  console.log(JSON.stringify({
    ok: !stale,
    run_id: manifest.run_id,
    market: manifest.market,
    source: manifest.source,
    mode: manifest.mode,
    fixture: manifest.fixture,
    generated_at: manifest.generated_at,
    generated_age_hours: generatedAgeHours,
    latest_retrieved_at: manifest.latest_retrieved_at ?? null,
    coverage: manifest.coverage,
    required_artifacts: required
  }, null, 2));
  if (stale) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`preflight failed: ${err?.message ?? err}`);
  process.exit(1);
});
