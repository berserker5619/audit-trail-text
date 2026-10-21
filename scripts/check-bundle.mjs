#!/usr/bin/env node
// Checks the built package: no runtime dependencies, nothing from Node in the main entry, and a
// main entry that stays small once bundled the way apps bundle it.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const MAX_MIN_BYTES = 24 * 1024;
// Raised from 8 KB in 1.1.0: map entries, allOf and option checks took the gzipped entry to about
// 7.8 KB (8,018 bytes), up from 6.9 KB in 1.0.1. Raise it again only for a feature, not drift.
const MAX_GZIP_BYTES = 10 * 1024;

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
