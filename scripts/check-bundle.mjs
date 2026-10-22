#!/usr/bin/env node
// Checks the built package: no runtime dependencies, nothing from Node in the main entry, and a
// main entry that stays small once bundled the way apps bundle it.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// Both raised in 1.2.0, from 24 KB and 10 KB: recursive schemas, atomic values, language maps and
// moves across parents took the entry to 33,717 bytes minified and 12,694 gzipped, up from about
// 8 KB gzipped in 1.1.0. Raise them again only for a feature, not drift.
const MAX_MIN_BYTES = 36 * 1024;
const MAX_GZIP_BYTES = 14 * 1024;

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const failures = [];

for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) {
  if (pkg[field] && Object.keys(pkg[field]).length > 0) failures.push(`package.json has ${field}: ${Object.keys(pkg[field]).join(', ')}`);
}

const result = await build({
  entryPoints: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  metafile: true,
  logLevel: 'silent',
});

const outside = Object.keys(result.metafile.inputs).filter((input) => !input.replace(/\\/g, '/').includes('dist/'));
if (outside.length) failures.push(`the main entry pulls in files outside dist: ${outside.join(', ')}`);
const code = result.outputFiles[0].text;
if (/\bfrom\s*["']node:|require\(["']node:/.test(code)) failures.push('the main entry imports a Node built-in');

const min = Buffer.byteLength(code);
const gzip = gzipSync(code).length;
if (min > MAX_MIN_BYTES) failures.push(`minified main entry is ${min} bytes, over ${MAX_MIN_BYTES}`);
if (gzip > MAX_GZIP_BYTES) failures.push(`gzipped main entry is ${gzip} bytes, over ${MAX_GZIP_BYTES}`);

if (failures.length) {
  for (const f of failures) console.error(`✖ ${f}`);
  process.exit(1);
}
console.log(`✔ no runtime dependencies; main entry ${min} bytes minified, ${gzip} gzipped`);
