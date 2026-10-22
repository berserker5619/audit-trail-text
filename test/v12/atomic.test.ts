// 1.2: objects compared and shown as one value (`x-atomic`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, diffRecords, jsonSchemaAdapter } from '../../src/index.ts';

const status = { title: 'Status', type: 'object', 'x-atomic': true, 'x-key': '$key', 'x-label': '@lang' };
const adapter = jsonSchemaAdapter({
  type: 'object',
  properties: {
    status,
    tags: { title: 'Tags', type: 'array', items: { ...status, title: 'Tag' } },
    price: { title: 'Price', type: 'object', 'x-atomic': true, 'x-label': '{amount} {currency}', properties: { secret: { type: 'string', 'x-sensitive': true } } },
  },
});
const run = (b: unknown, a: unknown) => diffRecords(b, a, adapter);
const texts = (b: unknown, a: unknown, options = {}) => describe(run(b, a), options).map((s) => s.text);

test('the four cases in the spec', () => {
  const lead = { $key: 'lead', en: 'Lead' };
  const active = { $key: 'active', en: 'Active' };
  // Different keys: changed, read by label.
  assert.deepEqual(run({ status: lead }, { status: active }), [{
    code: 'FIELD_CHANGED',
    beforePath: '/status',
    afterPath: '/status',
    schemaPath: '/properties/status',
    labels: ['Status'],
    before: lead,
    after: active,
    display: { type: 'object', beforeLabel: 'Lead', afterLabel: 'Active', i18n: { beforeLabel: { en: 'Lead' }, afterLabel: { en: 'Active' } } },
    inSchema: true,
  }]);
  assert.deepEqual(texts({ status: lead }, { status: active }), ['Status changed from Lead to Active']);
  // Same key, option renamed: no change.
  assert.deepEqual(run({ status: active }, { status: { $key: 'active', en: 'Enabled' } }), []);
  // No key on either side: the whole object is compared.
  assert.deepEqual(texts({ status: { en: 'Active' } }, { status: { en: 'Enabled' } }), ['Status changed from Active to Enabled']);
  // From nothing: set.
  assert.deepEqual(texts({ status: null }, { status: lead }), ['Status set to Lead']);
  assert.deepEqual(texts({ status: lead }, {}), ['Status cleared (was Lead)']);
});

test('a key on only one side compares the whole objects, as Dynamic Entity matches options', () => {
  assert.deepEqual(texts({ status: { en: 'Active' } }, { status: { $key: 'active', en: 'Active' } }), ['Status changed from Active to Active']);
  assert.deepEqual(run({ status: { en: 'Active' } }, { status: { en: 'Active' } }), []);
});

test('a multi-select is compared by key: a renamed option is the same option', () => {
  const vip = { $key: 'vip', en: 'VIP' };
  const wholesale = { $key: 'wholesale', en: 'Wholesale' };
  assert.deepEqual(texts({ tags: [wholesale] }, { tags: [{ ...wholesale, en: 'Trade' }, vip] }), ['VIP added to Tags']);
  assert.deepEqual(texts({ tags: [wholesale, vip] }, { tags: [vip] }), ['Wholesale removed from Tags']);
  const [added] = run({ tags: [] }, { tags: [vip] });
  assert.deepEqual([added!.code, added!.after, added!.display.afterLabel, added!.display.itemNoun], ['ITEM_ADDED', vip, 'VIP', 'Tag']);
});

test('a label template reads the fields; raw objects are stored, stripped as usual, and never printed', () => {
  const changes = run({ price: { amount: 100, currency: 'INR', secret: 'x' } }, { price: { amount: 120, currency: 'INR', secret: 'y' } });
  assert.deepEqual(changes.map((c) => [c.before, c.after, c.display.beforeLabel, c.display.afterLabel]), [
    [{ amount: 100, currency: 'INR' }, { amount: 120, currency: 'INR' }, '100 INR', '120 INR'],
  ]);
  assert.deepEqual(describe(changes).map((s) => s.text), ['Price changed from 100 INR to 120 INR']);
  // Ignored and sensitive fields are stripped and don't count as a change.
  assert.deepEqual(diffRecords({ price: { amount: 1, at: 'a' } }, { price: { amount: 1, at: 'b' } }, adapter, { ignore: ['/price/at'] }), []);
  assert.deepEqual(run({ price: { amount: 1, secret: 'a' } }, { price: { amount: 1, secret: 'b' } }), []);
  assert.deepEqual(run(null, { price: { amount: 1, secret: 'a' } })[0]!.after, { price: { amount: 1 } });
  assert.throws(
    () => jsonSchemaAdapter({ type: 'object', properties: { p: { type: 'object', 'x-atomic': true, 'x-key': 'k', properties: { k: { type: 'string', writeOnly: true } } } } }),
    { code: 'SENSITIVE_KEY' },
  );
});

test('without a label, an atomic value reads by its key, else its text fields; never as raw JSON', () => {
  const a = jsonSchemaAdapter({ type: 'object', properties: { owner: { type: 'object', 'x-atomic': true, 'x-key': 'id' } } });
  assert.deepEqual(describe(diffRecords({ owner: { id: 'u1', n: { deep: 1 } } }, { owner: { id: 'u2' } }, a)).map((s) => s.text), ['Owner changed from u1 to u2']);
  assert.deepEqual(describe(diffRecords({ owner: { name: 'Priya' } }, { owner: { name: 'Arun' } }, a)).map((s) => s.text), ['Owner changed from Priya to Arun']);
  // Nothing readable: the change reads as a whole.
  assert.deepEqual(describe(diffRecords({ owner: { n: [1] } }, { owner: { n: [2] } }, a)).map((s) => s.text), ['Owner changed']);
});

test('the labels file makes a field atomic for schemas you don\'t control', () => {
  const a = jsonSchemaAdapter({ type: 'object', properties: { status: { type: 'object', title: 'Status' } } }, {
    labels: { '/status#atomic': '$key', '/status#label': '@lang' },
    strictLabels: true,
  });
  assert.deepEqual(describe(diffRecords({ status: { $key: 'a', en: 'A' } }, { status: { $key: 'b', en: 'B' } }, a)).map((s) => s.text), [
    'Status changed from A to B',
  ]);
  assert.deepEqual(diffRecords({ status: { $key: 'a', en: 'A' } }, { status: { $key: 'a', en: 'Renamed' } }, a), []);
});

test('x-atomic on a schema that is not an object is INVALID_SCHEMA', () => {
  assert.throws(() => jsonSchemaAdapter({ type: 'object', properties: { s: { type: 'string', 'x-atomic': true } } }), { code: 'INVALID_SCHEMA', path: '/properties/s' });
  assert.throws(() => jsonSchemaAdapter({ type: 'object', properties: { s: { type: 'object', 'x-atomic': 'yes' } } }), { code: 'INVALID_SCHEMA' });
});

test('an atomic list item key and label keep working with 1.1 list items', () => {
  const a = jsonSchemaAdapter({
    type: 'object',
    properties: {
      rows: { type: 'array', title: 'Rows', 'x-key': '$rowId', 'x-label': '{status}', items: { type: 'object', title: 'Row', properties: { $rowId: { type: 'string' }, status } } },
    },
  });
  const row = (key: string, en: string) => ({ $rowId: 'r1', status: { $key: key, en } });
  assert.deepEqual(describe(diffRecords({ rows: [row('a', 'Open')] }, { rows: [row('b', 'Closed')] }, a)).map((s) => s.text), [
    'Rows › Closed: Status changed from Open to Closed',
  ]);
});
