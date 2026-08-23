#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { publishInvestmentScreenerRun } from '../src/investment-screener-storage.js';

function usage() {
  return `Usage: node scripts/publish-investment-screener-run.mjs --data-root <root> --run-json <payload.json>

Publishes a validated Investment Screener run payload to the NAS/DuckDB file-first artifact layout.
The data root should be a staging/safe writer path, not the dashboard read-only runtime cache.`;
}

function parseArgs(argv) {
  const args = {};
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

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args['data-root'] || !args['run-json']) {
    console.error(usage());
    process.exit(2);
  }
  const run = JSON.parse(await readFile(args['run-json'], 'utf8'));
  const result = await publishInvestmentScreenerRun({ dataRoot: args['data-root'], run });
  console.log(JSON.stringify({ run_id: result.run_id, market: result.manifest.market, source: result.manifest.source, mode: result.manifest.mode, fixture: result.manifest.fixture, coverage: result.latest.coverage }, null, 2));
} catch (err) {
  console.error(`publish failed: ${err?.message ?? err}`);
  process.exit(1);
}
