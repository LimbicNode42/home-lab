#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '..');
const generator = join(serviceRoot, 'investment-screener', 'generate_asx_universe_seed.py');

const result = spawnSync('python3', [generator, ...process.argv.slice(2)], {
  cwd: serviceRoot,
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
