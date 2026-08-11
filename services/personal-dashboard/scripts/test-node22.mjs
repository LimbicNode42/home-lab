#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const [major] = process.versions.node.split('.').map(Number);
const requestedArgs = process.argv.slice(2);
const testArgs = ['--test', ...(requestedArgs.length ? requestedArgs : ['test/*.test.js'])];
const command = major >= 22 ? process.execPath : 'npx';
const args = major >= 22 ? testArgs : ['-y', 'node@22', ...testArgs];

if (major < 22) {
  console.error(`personal-dashboard tests require Node >=22 for node:sqlite; current Node is ${process.versions.node}.`);
  console.error('Falling back to npx -y node@22 --test so local/CI runs fail on real test failures, not the host Node version.');
}

const result = spawnSync(command, args, { stdio: 'inherit' });
if (result.error) {
  console.error(`Unable to run ${command} ${args.join(' ')}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
