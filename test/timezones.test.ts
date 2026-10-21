// Sentences must not depend on the machine's time zone: run the same describe in child
// processes with different TZ values and compare.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const script = `
import { describeChanges, jsonSchemaAdapter } from './src/index.ts';
const a = jsonSchemaAdapter({ type: 'object', properties: {
  launch: { type: 'string', format: 'date' }, at: { type: 'string', format: 'date-time' } } });
const out = describeChanges({}, { launch: '2026-10-05', at: '2026-10-05T23:30:00Z' }, a, { locale: 'en-IN' })
  .concat(describeChanges({}, { at: '2026-10-05T23:30:00Z' }, a, { locale: 'en-IN', timeZone: 'Asia/Kolkata' }));
console.log(JSON.stringify(out.map((s) => s.text)));
`;

test('sentences are identical across machine time zones', () => {
  const run = (TZ: string) =>
    JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }));
  const results = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'].map(run);
  assert.deepEqual(results[0], ['Launch set to 5 Oct 2026', 'At set to 5 Oct 2026, 11:30 pm', 'At set to 6 Oct 2026, 5:00 am']);
  for (const r of results) assert.deepEqual(r, results[0]);
});
