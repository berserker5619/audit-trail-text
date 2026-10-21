import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRecords, jsonSchemaAdapter } from '../src/index.ts';
import { contactSchema, specAfter, specBefore } from './helpers.ts';

test('a stored change keeps its display details after the schema and labels change', () => {
  const stored = JSON.stringify(diffRecords(specBefore, specAfter, jsonSchemaAdapter(contactSchema)));
  // The app later relabels status and renames the field: the stored change must not depend on it.
  const relabelled = jsonSchemaAdapter(contactSchema, { labels: { '/status': 'Stage', '/status=active': 'Customer' } });
  const fresh = diffRecords(specBefore, specAfter, relabelled);
  const status = JSON.parse(stored).find((c: { beforePath?: string }) => c.beforePath === '/status');
  assert.deepEqual(status.labels, ['Status']);
  assert.deepEqual(status.display, { type: 'string', beforeLabel: 'Lead', afterLabel: 'Active customer' });
  assert.notDeepEqual(fresh.find((c) => c.beforePath === '/status')!.display, status.display);
});
