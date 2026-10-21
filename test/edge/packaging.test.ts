// Edge case 19: packaging. Installs the packed package into throwaway projects
// (scripts/check-packaging.mjs). It needs a build and the network, so it runs only with
// EDGE_PACKAGING=1:
//
//   npm run build && EDGE_PACKAGING=1 node --test test/edge/packaging.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WRONG } from './helpers.ts';

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

test('19e. CommonJS require works on Node 18, which engines promises', { ...WRONG, skip }, () => {
  for (const r of result(/^CommonJS require, Node 18/)) assert.ok(r.ok, `${r.name}: ${r.detail}`);
});

test('19f. a TypeScript CommonJS project (node16 resolution) can import the package', { ...WRONG, skip }, () => {
  for (const r of result(/CommonJS package/)) assert.ok(r.ok, `${r.name}: ${r.detail}`);
});
