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

for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies']) {
  if (pkg[field] && Object.keys(pkg[field]).length > 0) failures.push(`package.json has ${field}: ${Object.keys(pkg[field]).join(', ')}`);
}
// The one peer is Mongoose, for the audit-trail-text/mongoose entry only, and it is optional.
const peers = Object.keys(pkg.peerDependencies ?? {});
if (peers.some((p) => p !== 'mongoose')) failures.push(`package.json has peerDependencies other than mongoose: ${peers.join(', ')}`);
if (peers.includes('mongoose') && pkg.peerDependenciesMeta?.mongoose?.optional !== true) failures.push('the mongoose peer dependency must be optional');

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

const inputs = Object.keys(result.metafile.inputs).map((input) => input.replace(/\\/g, '/'));
const outside = inputs.filter((input) => !input.includes('dist/'));
if (outside.length) failures.push(`the main entry pulls in files outside dist: ${outside.join(', ')}`);
const plugin = inputs.filter((input) => input.includes('dist/mongoose/'));
if (plugin.length) failures.push(`the main entry pulls in the Mongoose plugin: ${plugin.join(', ')}`);
const code = result.outputFiles[0].text;
if (/\bfrom\s*["']node:|require\(["']node:/.test(code)) failures.push('the main entry imports a Node built-in');
if (/["']mongoose["']/.test(code)) failures.push('the main entry refers to mongoose');

// The Mongoose entry never loads Mongoose itself: it works with the schema and models it is given,
// so it can't load a second copy, and importing it without Mongoose installed still works.
const mongooseEntry = await build({
  entryPoints: [fileURLToPath(new URL('../dist/mongoose/index.js', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  metafile: true,
  logLevel: 'silent',
});
const loaded = Object.keys(mongooseEntry.metafile.inputs).filter((input) => !input.replace(/\\/g, '/').includes('dist/'));
if (loaded.length) failures.push(`the Mongoose entry loads packages: ${loaded.join(', ')}`);

// The same for the plain-driver entry: it never loads the MongoDB driver, or the Mongoose plugin.
const mongoEntry = await build({
  entryPoints: [fileURLToPath(new URL('../dist/mongo/index.js', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  metafile: true,
  logLevel: 'silent',
});
const mongoInputs = Object.keys(mongoEntry.metafile.inputs).map((input) => input.replace(/\\/g, '/'));
const mongoLoaded = mongoInputs.filter((input) => !input.includes('dist/'));
if (mongoLoaded.length) failures.push(`the MongoDB entry loads packages: ${mongoLoaded.join(', ')}`);
const pluginFiles = mongoInputs.filter((input) => /dist\/mongoose\/(plugin|stream|schema|history|migrate)\.js$/.test(input));
if (pluginFiles.length) failures.push(`the MongoDB entry pulls in the Mongoose plugin: ${pluginFiles.join(', ')}`);

const min = Buffer.byteLength(code);
const gzip = gzipSync(code).length;
if (min > MAX_MIN_BYTES) failures.push(`minified main entry is ${min} bytes, over ${MAX_MIN_BYTES}`);
if (gzip > MAX_GZIP_BYTES) failures.push(`gzipped main entry is ${gzip} bytes, over ${MAX_GZIP_BYTES}`);

if (failures.length) {
  for (const f of failures) console.error(`✖ ${f}`);
  process.exit(1);
}
console.log(`✔ no runtime dependencies; main entry ${min} bytes minified, ${gzip} gzipped`);
