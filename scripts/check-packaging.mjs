#!/usr/bin/env node
// Installs the packed package into throwaway consumer projects, the ways apps use it, and reports
// what works: ESM import, CommonJS require, TypeScript strict (node16 and bundler resolution, on
// TypeScript 5 and the version in this repo), and a Vite browser build.
//
//   npm run build && node scripts/check-packaging.mjs [--json]
//
// Needs the network for npm installs. Prints one line per check; exits 1 if any check that is
// expected to work fails.
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'att-packaging-'));
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tarball = join(work, JSON.parse(sh(`npm pack --json --pack-destination "${work}"`, root))[0].filename);
const repoTs = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version;

const results = [];
function check(name, expectWorks, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, expectWorks, detail: detail ?? '' });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message;
    results.push({ name, ok: false, expectWorks, detail: out.split('\n').filter(Boolean).slice(0, 4).join(' | ') });
  }
}

function project(name, pkg, files) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, ...pkg }));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const use = `
const adapter = jsonSchemaAdapter({ type: 'object', properties: { phone: { type: 'string', title: 'Phone' } } });
const changes = diffRecords({ phone: '1' }, { phone: '2' }, adapter);
const text = describe(changes).map((s) => s.text).join();
if (text !== 'Phone changed from "1" to "2"') throw new Error(text);
console.log(text);
`;

// Plain JavaScript consumers.
const esm = project('esm', { type: 'module' }, { 'index.js': `import { jsonSchemaAdapter, diffRecords, describe } from 'audit-trail-text';\n${use}` });
const cjs = project('cjs', { type: 'commonjs' }, { 'index.js': `const { jsonSchemaAdapter, diffRecords, describe } = require('audit-trail-text');\n${use}` });
sh(`npm install "${tarball}" --no-audit --no-fund --loglevel error`, esm);
sh(`npm install "${tarball}" --no-audit --no-fund --loglevel error`, cjs);
check('ESM import, this Node', true, () => sh('node index.js', esm).trim());
check('CommonJS require, this Node', true, () => sh('node index.js', cjs).trim());
check('CommonJS require, Node 18', true, () => sh('npx -y -p node@18 node index.js', cjs).trim());
check('ESM import, Node 18', true, () => sh('npx -y -p node@18 node index.js', esm).trim());

// TypeScript consumers, strict, without skipLibCheck so the package's own .d.ts files are checked.
const tsUse = `import { jsonSchemaAdapter, diffRecords, describe, type Change, type Sentence } from 'audit-trail-text';
const adapter = jsonSchemaAdapter({ type: 'object', properties: { phone: { type: 'string' } } });
const changes: Change[] = diffRecords({ phone: '1' }, { phone: '2' }, adapter);
const sentences: Sentence[] = describe(changes, { locale: 'en-IN', translateLabel: (l, { kind }) => kind + l });
export const first: string | undefined = sentences[0]?.text;
`;
const tsConfigs = {
  'node16 (ESM package)': { pkg: { type: 'module' }, options: { module: 'node16', moduleResolution: 'node16' } },
  'node16 (CommonJS package)': { pkg: { type: 'commonjs' }, options: { module: 'node16', moduleResolution: 'node16' } },
  bundler: { pkg: { type: 'module' }, options: { module: 'esnext', moduleResolution: 'bundler' } },
};
for (const ts of ['5', repoTs]) {
  for (const [label, { pkg, options }] of Object.entries(tsConfigs)) {
    const dir = project(`ts${ts.replace(/\W/g, '')}-${label.replace(/\W/g, '')}`, pkg, {
      'index.ts': tsUse,
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: 'es2022', types: [], ...options }, files: ['index.ts'] }),
    });
    sh(`npm install "${tarball}" typescript@${ts} --no-audit --no-fund --loglevel error`, dir);
    const version = JSON.parse(readFileSync(join(dir, 'node_modules/typescript/package.json'), 'utf8')).version;
    check(`TypeScript ${version}, strict, ${label}`, !label.includes('CommonJS'), () => {
      sh('npx tsc -p tsconfig.json', dir);
    });
  }
}

// A Vite browser build.
const vite = project('vite', { type: 'module', scripts: { build: 'vite build' } }, {
  'index.html': '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>',
  'main.js': `import { jsonSchemaAdapter, diffRecords, describe } from 'audit-trail-text';\n${use.replace('console.log(text)', 'document.body.textContent = text')}`,
});
sh(`npm install "${tarball}" vite --no-audit --no-fund --loglevel error`, vite);
check('Vite browser build', true, () => {
  sh('npx vite build --logLevel error', vite);
  const assets = readdirSync(join(vite, 'dist/assets')).filter((f) => f.endsWith('.js'));
  const js = assets.map((f) => readFileSync(join(vite, 'dist/assets', f), 'utf8')).join('');
  if (!js.includes('changed from')) throw new Error('bundle does not contain the package');
  if (/from\s*["']node:/.test(js)) throw new Error('bundle imports a Node built-in');
  return `${assets.length} chunk(s), ${js.length} bytes`;
});

if (process.argv.includes('--json')) console.log(JSON.stringify(results));
else for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
process.exitCode = results.some((r) => r.expectWorks && !r.ok) ? 1 : 0;
