#!/usr/bin/env node
// Copies Dynamic Entity's demo seed data into fixtures/, from a tag of berserker5619/Dynamic-Entity
// (default v3.3.1), and records the tag, its commit and each file's sha256 in fixtures/SOURCE.json.
//
//   node scripts/refresh-fixtures.mjs [tag]
//
// The files are copied as they are, with one change: JSON imports get `with { type: 'json' }`,
// which Node needs to load them (the demo's bundler doesn't). Set GITHUB_TOKEN to avoid the
// API's rate limit for anonymous calls.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'berserker5619/Dynamic-Entity';
const MOCK = 'packages/demo-angular/src/app/mock';
// The three seed files, then the data they import: two configs imported by seed-enterprise.ts,
// and test_data.json, which holds the configs seed-records.ts is written against.
const FILES = [
  [`${MOCK}/seed-enterprise.ts`, 'seed-enterprise.ts'],
  [`${MOCK}/seed-records.ts`, 'seed-records.ts'],
  [`${MOCK}/demo-rules.ts`, 'demo-rules.ts'],
  [`${MOCK}/configs/patient-intake.json`, 'configs/patient-intake.json'],
  [`${MOCK}/configs/it-assets.json`, 'configs/it-assets.json'],
  ['test_data.json', 'test_data.json'],
];

const tag = process.argv[2] ?? 'v3.3.1';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const headers = { 'User-Agent': 'audit-trail-text-fixtures', ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }) };

async function get(url, accept = 'application/vnd.github+json') {
  const res = await fetch(url, { headers: { ...headers, Accept: accept } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return accept.includes('raw') ? res.text() : res.json();
}

// A tag ref points at a tag object (annotated) or straight at a commit.
let ref = (await get(`https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`)).object;
while (ref.type === 'tag') ref = (await get(ref.url)).object;
const commit = ref.sha;

const files = {};
for (const [from, to] of FILES) {
  let text = await get(`https://api.github.com/repos/${REPO}/contents/${from}?ref=${commit}`, 'application/vnd.github.raw');
  const original = createHash('sha256').update(text).digest('hex');
  if (to.endsWith('.ts')) text = text.replace(/^(import \w+ from '[^']+\.json');$/gm, "$1 with { type: 'json' };");
  mkdirSync(dirname(join(out, to)), { recursive: true });
  writeFileSync(join(out, to), text);
  files[to] = { from, sha256: original };
}
writeFileSync(join(out, 'SOURCE.json'), `${JSON.stringify({ repo: REPO, tag, commit, files }, null, 2)}\n`);
console.log(`fixtures from ${REPO} ${tag} (${commit})`);
