import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_PATH = join(__dirname, '..', 'package.json');
const LOCK_PATH = join(__dirname, '..', 'package-lock.json');

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('package.json depends on portable DuckDB API only', async () => {
  const pkg = await loadJson(PACKAGE_PATH);
  const dependencyNames = Object.keys(pkg.dependencies ?? {});

  assert.ok(dependencyNames.includes('@duckdb/node-api'), 'dashboard must keep investment-screener DuckDB support');
  assert.deepEqual(
    dependencyNames.filter((name) => name.startsWith('@duckdb/node-bindings-')),
    [],
    'do not pin a platform-specific DuckDB native binding in package.json; npm must choose the matching optional package per architecture'
  );
});

test('DuckDB native platform packages stay optional in package-lock.json', async () => {
  const lock = await loadJson(LOCK_PATH);
  const packages = lock.packages ?? {};
  const duckdbBindings = packages['node_modules/@duckdb/node-bindings'];

  assert.ok(duckdbBindings, 'package-lock must include @duckdb/node-bindings');
  assert.deepEqual(
    duckdbBindings.optionalDependencies,
    {
      '@duckdb/node-bindings-darwin-arm64': '1.5.5-r.4',
      '@duckdb/node-bindings-darwin-x64': '1.5.5-r.4',
      '@duckdb/node-bindings-linux-arm64': '1.5.5-r.4',
      '@duckdb/node-bindings-linux-arm64-musl': '1.5.5-r.4',
      '@duckdb/node-bindings-linux-x64': '1.5.5-r.4',
      '@duckdb/node-bindings-linux-x64-musl': '1.5.5-r.4',
      '@duckdb/node-bindings-win32-arm64': '1.5.5-r.4',
      '@duckdb/node-bindings-win32-x64': '1.5.5-r.4',
    },
    'DuckDB native bindings must remain optional dependencies so npm skips non-matching platforms'
  );

  const nativeBindingEntries = Object.entries(packages).filter(([packagePath]) =>
    packagePath.startsWith('node_modules/@duckdb/node-bindings-')
  );

  assert.ok(nativeBindingEntries.length >= 8, 'expected DuckDB native binding packages for all supported platforms');
  for (const [packagePath, packageInfo] of nativeBindingEntries) {
    assert.equal(
      packageInfo.optional,
      true,
      `${packagePath} must be marked optional; otherwise arm64 npm ci tries to install incompatible x64 bindings`
    );
    assert.ok(Array.isArray(packageInfo.os), `${packagePath} must declare its target OS`);
    assert.ok(Array.isArray(packageInfo.cpu), `${packagePath} must declare its target CPU`);
  }
});
