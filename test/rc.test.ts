// The real-record round: every scenario's sentences are checked in test/rc/sentences.json,
// after being read by hand. Run `node test/rc.test.ts --update` to rewrite them, then reread.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { describeChanges, jsonSchemaAdapter } from '../src/index.ts';
import { crmOptions, crmScenarios, crmSchema, plmScenarios, plmSchema, type Scenario } from './rc/scenarios.ts';

const file = new URL('./rc/sentences.json', import.meta.url);
const update = process.argv.includes('--update');
const options = { locale: 'en-IN', timeZone: 'Asia/Kolkata' };

const sets: [string, unknown, Scenario[], object][] = [
  ['crm', crmSchema, crmScenarios, crmOptions],
  ['plm', plmSchema, plmScenarios, {}],
];

const actual: Record<string, Record<string, string[]>> = {};
for (const [set, schema, scenarios, diffOptions] of sets) {
  const adapter = jsonSchemaAdapter(schema);
  actual[set] = Object.fromEntries(
    scenarios.map((s) => [s.name, describeChanges(s.before, s.after, adapter, { ...diffOptions, ...options }).map((x) => x.text)]),
  );
}

if (update) writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
const expected = JSON.parse(readFileSync(file, 'utf8'));

for (const [set] of sets) {
  for (const [name, sentences] of Object.entries(actual[set]!)) {
    test(`${set}: ${name}`, () => assert.deepEqual(sentences, expected[set][name]));
  }
}
