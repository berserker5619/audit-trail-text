// Fixture pairs with their expected changes checked in. Run `npm run golden:update` to rewrite
// `expected` after an intended change, then review the diff.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { diffRecords, jsonSchemaAdapter } from '../src/index.ts';

const dir = new URL('./fixtures/', import.meta.url);
const update = process.argv.includes('--update');

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  test(`golden: ${file}`, () => {
    const url = new URL(file, dir);
    const fixture = JSON.parse(readFileSync(url, 'utf8'));
    const adapter = jsonSchemaAdapter(fixture.schema, { labels: fixture.labels });
    const changes = diffRecords(fixture.before, fixture.after, adapter, fixture.options);
    if (update) {
      writeFileSync(url, `${JSON.stringify({ ...fixture, expected: changes }, null, 2)}\n`);
      return;
    }
    assert.deepEqual(changes, fixture.expected);
  });
}
