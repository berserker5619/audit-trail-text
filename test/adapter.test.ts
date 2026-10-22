import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diffRecords, jsonSchemaAdapter, type ObjectNode } from '../src/index.ts';
import { contactSchema } from './helpers.ts';

const list = (extra: Record<string, unknown> = {}, itemProps: Record<string, unknown> = { id: { type: 'string' } }) => ({
  type: 'object',
  properties: { orders: { type: 'array', ...extra, items: { type: 'object', properties: itemProps } } },
});

describe('jsonSchemaAdapter', () => {
  test('reads titles, nouns, formats and value labels', () => {
    const { root, recordNoun } = jsonSchemaAdapter(contactSchema);
    assert.equal(recordNoun, 'Contact');
    const status = root.properties.get('status')!;
    assert.equal(status.kind, 'value');
    assert.equal(status.kind === 'value' && status.valueLabels.get('active'), 'Active customer');
    const orders = root.properties.get('orders')!;
    assert.equal(orders.kind, 'objectList');
    assert.equal(orders.kind === 'objectList' && orders.itemNoun, 'Order');
    assert.equal(root.properties.get('updatedAt')!.kind === 'value' && (root.properties.get('updatedAt') as { format?: string }).format, 'date-time');
    assert.equal(root.properties.get('email')!.title, 'Email');
  });

  test('record noun defaults to "Record"', () => {
    assert.equal(jsonSchemaAdapter({ type: 'object' }).recordNoun, 'Record');
  });

  test('$ref to $defs is followed, with sibling keywords winning', () => {
    const address = jsonSchemaAdapter(contactSchema).root.properties.get('address')!;
    assert.equal(address.kind, 'object');
    assert.equal(address.title, 'Address');
    assert.equal(address.kind === 'object' && address.properties.get('pin')!.title, 'PIN');
  });

  test('the labels file wins over the schema', () => {
    const a = jsonSchemaAdapter(
      { type: 'object', title: 'Contact', properties: { ph: { type: 'string', title: 'Ph' }, status: { type: 'string' }, orders: { type: 'array', items: { type: 'object', properties: { lineId: { type: 'string' }, product: { type: 'string' } } } } } },
      { labels: { '#record': 'Customer', '/ph': 'Phone', '/status=vip': 'VIP', '/orders/*': 'Order', '/orders#key': 'lineId', '/orders#label': '{product}' } },
    );
    assert.equal(a.recordNoun, 'Customer');
    assert.equal(a.root.properties.get('ph')!.title, 'Phone');
    const status = a.root.properties.get('status')!;
    assert.equal(status.kind === 'value' && status.valueLabels.get('vip'), 'VIP');
    const orders = a.root.properties.get('orders')!;
    assert.ok(orders.kind === 'objectList');
    assert.deepEqual([orders.itemNoun, orders.key, orders.itemLabel], ['Order', ['lineId'], '{product}']);
  });

  test('labels file composite key is comma-separated', () => {
    const a = jsonSchemaAdapter(list({}, { product: { type: 'string' }, size: { type: 'string' } }), { labels: { '/orders#key': 'product, size' } });
    const orders = a.root.properties.get('orders')!;
    assert.deepEqual(orders.kind === 'objectList' && orders.key, ['product', 'size']);
  });

  test('a list of objects with no key throws LIST_KEY_MISSING', () => {
    assert.throws(() => jsonSchemaAdapter(list()), { code: 'LIST_KEY_MISSING', path: '/orders' });
  });

  test('a key field missing from the item schema throws KEY_NOT_IN_SCHEMA', () => {
    assert.throws(() => jsonSchemaAdapter(list({ 'x-key': 'sku' })), { code: 'KEY_NOT_IN_SCHEMA', path: '/orders' });
  });

  test('a sensitive key or label field throws SENSITIVE_KEY', () => {
    const props = { id: { type: 'string', writeOnly: true }, name: { type: 'string' }, secret: { type: 'string', 'x-sensitive': true } };
    assert.throws(() => jsonSchemaAdapter(list({ 'x-key': 'id' }, props)), { code: 'SENSITIVE_KEY' });
    assert.throws(() => jsonSchemaAdapter(list({ 'x-key': 'name', 'x-label': '{name} {secret}' }, props)), { code: 'SENSITIVE_KEY' });
  });

  test('external and missing $refs, and $ref loops that describe no data, throw INVALID_SCHEMA', () => {
    assert.throws(() => jsonSchemaAdapter({ type: 'object', properties: { a: { $ref: 'other.json#/x' } } }), { code: 'INVALID_SCHEMA', path: '/properties/a' });
    assert.throws(() => jsonSchemaAdapter({ type: 'object', properties: { a: { $ref: '#/$defs/nope' } } }), { code: 'INVALID_SCHEMA' });
    // a refers to b, b refers to a: no property or item in between.
    assert.throws(
      () => jsonSchemaAdapter({ type: 'object', properties: { x: { $ref: '#/$defs/a' } }, $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } }),
      { code: 'INVALID_SCHEMA', message: /loops back to itself without describing any data/ },
    );
    assert.throws(
      () => jsonSchemaAdapter({ type: 'object', properties: { x: { $ref: '#/$defs/a' } }, $defs: { a: { allOf: [{ $ref: '#/$defs/a' }] } } }),
      { code: 'INVALID_SCHEMA' },
    );
  });

  test('a recursive $ref is followed as deep as the data goes (1.2)', () => {
    const a = jsonSchemaAdapter({ type: 'object', properties: { node: { $ref: '#/$defs/n' } }, $defs: { n: { type: 'object', properties: { child: { $ref: '#/$defs/n' } } } } });
    const node = a.root.properties.get('node')! as ObjectNode;
    const child = node.properties.get('child')! as ObjectNode;
    // Built once per use (here titled "Node" and "Child"), then reused at every depth.
    assert.equal(child.properties.get('child'), child);
    assert.deepEqual([node.title, child.title, node.schemaPath, child.schemaPath], ['Node', 'Child', '/$defs/n', '/$defs/n']);
  });

  test('the same $def used twice is not recursion', () => {
    assert.doesNotThrow(() => jsonSchemaAdapter({ type: 'object', properties: { home: { $ref: '#/$defs/a' }, work: { $ref: '#/$defs/a' } }, $defs: { a: { type: 'object' } } }));
  });

  test('schemas it cannot read throw INVALID_SCHEMA', () => {
    assert.throws(() => jsonSchemaAdapter('nope'), { code: 'INVALID_SCHEMA' });
    assert.throws(() => jsonSchemaAdapter({ type: 'string' }), { code: 'INVALID_SCHEMA' });
    assert.throws(() => jsonSchemaAdapter({ type: 'object' }, { labels: { '/a': 1 as unknown as string } }), { code: 'INVALID_SCHEMA', path: '/a' });
  });

  test('unknown keywords are ignored, not refused', () => {
    assert.doesNotThrow(() => jsonSchemaAdapter({ type: 'object', allOf: [], 'x-whatever': 1, properties: { a: { type: ['string', 'null'], minLength: 2 } } }));
  });

  test('an adapter is reusable across diffs', () => {
    const a = jsonSchemaAdapter(contactSchema);
    assert.equal(diffRecords({ name: 'a' }, { name: 'b' }, a).length, 1);
    assert.equal(diffRecords({ name: 'a' }, { name: 'b' }, a).length, 1);
  });
});
