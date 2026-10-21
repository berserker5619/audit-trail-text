// Edge case 19: packaging. Installs the packed package into throwaway projects
// (scripts/check-packaging.mjs). It needs a build and the network, so it runs only with
// EDGE_PACKAGING=1:
//
//   npm run build && EDGE_PACKAGING=1 node --test test/edge/packaging.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const enabled = process.env['EDGE_PACKAGING'] === '1';
type Result = { name: string; ok: boolean; detail: string };

let results: Result[] = [];
if (enabled) {
  const script = fileURLToPath(new URL('../../scripts/check-packaging.mjs', import.meta.url));
  let out = '';
  try {
    out = execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 900_000 });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? '');
  }
  results = JSON.parse(out.trim().split('\n').pop()!);
}
const result = (pattern: RegExp) => results.filter((r) => pattern.test(r.name));
const skip = enabled ? false : 'set EDGE_PACKAGING=1 to run';

test('19. ESM import works on this Node and on Node 18', { skip }, () => {
  for (const r of result(/^ESM import/)) assert.ok(r.ok, `${r.name}: ${r.detail}`);
});

test('19b. TypeScript strict, node16 and bundler resolution, on TypeScript 5 and the repo version', { skip }, () => {
  const rs = result(/^TypeScript .*(node16 \(ESM package\)|bundler)/);
  assert.equal(rs.length, 4);
  for (const r of rs) assert.ok(r.ok, `${r.name}: ${r.detail}`);
});

test('19c. a Vite browser build includes the package and no Node built-ins', { skip }, () => {
  for (const r of result(/^Vite/)) assert.ok(r.ok, `${r.name}: ${r.detail}`);
});

test('19d. CommonJS require works on this Node (it can require ES modules)', { skip }, () => {
  for (const r of result(/^CommonJS require, this Node/)) assert.ok(r.ok, `${r.name}: ${r.detail}`);
});

// ESM-only, as the README states: require() needs a Node that can require ES modules.
test('19e. the README says the package is ESM-only, and which Node versions can require it', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /ESM-only/);
  assert.match(readme, /20\.19/);
  assert.match(readme, /22\.12/);
});

test('19f. as documented, CommonJS require fails on Node 18, and a TypeScript CommonJS project cannot import it', { skip }, () => {
  const rs = [...result(/^CommonJS require, Node 18/), ...result(/CommonJS package/)];
  assert.equal(rs.length, 3);
  for (const r of rs) assert.equal(r.ok, false, `${r.name} unexpectedly works: if so, update the README`);
});
