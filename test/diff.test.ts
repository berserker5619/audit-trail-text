import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diffRecords, jsonSchemaAdapter, type Change } from '../src/index.ts';
import { contactSchema, specAfter, specBefore } from './helpers.ts';

const adapter = jsonSchemaAdapter(contactSchema);
const diff = (b: unknown, a: unknown, opts = {}) => diffRecords(b, a, adapter, opts);
const codes = (changes: Change[]) => changes.map((c) => c.code);

describe('spec example', () => {
  test('gives the four changes in the spec', () => {
    const changes = diff(specBefore, specAfter);
    assert.deepEqual(codes(changes), ['FIELD_CHANGED', 'FIELD_CHANGED', 'FIELD_CHANGED', 'ITEM_REMOVED']);
    assert.deepEqual(changes[2], {
      code: 'FIELD_CHANGED',
      beforePath: '/orders/0/qty',
      afterPath: '/orders/0/qty',
      schemaPath: '/properties/orders/items/properties/qty',
      labels: ['Orders', 'Blue kurta', 'Quantity'],
      before: 2,
      after: 3,
      item: { key: 'A1', label: 'Blue kurta' },
      display: { type: 'integer' },
      inSchema: true,
    });
    assert.deepEqual(changes[3]!.item, { key: 'A2', label: 'Red saree' });
  });

  test('changes survive a JSON round trip unchanged', () => {
    const changes = diff(specBefore, specAfter);
    assert.deepEqual(JSON.parse(JSON.stringify(changes)), changes);
  });
});

describe('fields', () => {
  test('set, cleared and changed', () => {
    assert.deepEqual(codes(diff({}, { email: 'r@x.in' })), ['FIELD_SET']);
    assert.deepEqual(codes(diff({ email: 'r@x.in' }, { email: '' })), ['FIELD_CLEARED']);
    assert.deepEqual(codes(diff({ email: 'a' }, { email: 'b' })), ['FIELD_CHANGED']);
  });

  test('undefined, null and "" are all empty', () => {
    assert.deepEqual(diff({ email: null }, { email: '' }), []);
    assert.deepEqual(diff({ email: undefined }, { email: null }), []);
  });

  test('null to {} is no change', () => {
    assert.deepEqual(diff({ address: null }, { address: {} }), []);
  });

  test('a whole object appearing is one FIELD_SET, or its fields with expandObjects', () => {
    const changes = diff({}, { address: { city: 'Chennai' } });
    assert.deepEqual(changes, [{
      code: 'FIELD_SET',
      beforePath: '/address',
      afterPath: '/address',
      schemaPath: '/properties/address',
      labels: ['Address'],
      after: { city: 'Chennai' },
      display: { type: 'object' },
      inSchema: true,
    }]);
    const expanded = diff({}, { address: { city: 'Chennai' } }, { expandObjects: true });
    assert.deepEqual(expanded.map((c) => c.labels), [['Address', 'City']]);
    assert.equal(expanded[0]!.schemaPath, '/properties/address/properties/city');
  });

  test('an object disappearing is one FIELD_CLEARED', () => {
    assert.deepEqual(codes(diff({ address: { city: 'Chennai' } }, { address: null })), ['FIELD_CLEARED']);
  });

  test('type changes are reported', () => {
    assert.deepEqual(codes(diff({ phone: '5' }, { phone: 5 })), ['FIELD_CHANGED']);
  });

  test('key order inside objects is ignored', () => {
    assert.deepEqual(diff({ address: { city: 'C', pin: '6' } }, { address: { pin: '6', city: 'C' } }), []);
  });

  test('-0 equals 0', () => {
    assert.deepEqual(diff({ x: -0 }, { x: 0 }), []);
  });

  test('the same record twice gives []', () => {
    assert.deepEqual(diff(specBefore, structuredClone(specBefore)), []);
  });

  test('changes follow schema order, then unknown fields sorted', () => {
    const changes = diff({}, { zeta: 1, alpha: 2, phone: '1', name: 'R' });
    assert.deepEqual(changes.map((c) => c.labels[0]), ['Name', 'Phone', 'Alpha', 'Zeta']);
  });

  test('fields the schema does not describe are labelled from their key', () => {
    const [c] = diff({}, { primaryAddress: 'x', phone_number: 'y' });
    assert.deepEqual(c!.labels, ['Phone Number']);
    assert.equal(c!.inSchema, false);
    assert.equal('schemaPath' in c!, false);
    const nested = diff({ meta: { sourceSystem: 'a' } }, { meta: { sourceSystem: 'b' } });
    assert.deepEqual(nested[0]!.labels, ['Meta', 'Source System']);
    assert.equal(nested[0]!.inSchema, false);
  });

  test('a field named __proto__ or constructor is handled as data', () => {
    const b = JSON.parse('{"__proto__": {"a": 1}}');
    const a = JSON.parse('{"__proto__": {"a": 2}}');
    assert.deepEqual(diff(b, a)[0]!.labels, ['Proto', 'A']);
    assert.deepEqual(diff({}, {}), []);
    const s = jsonSchemaAdapter({ type: 'object', properties: { constructor: { type: 'string' } } });
    assert.deepEqual(diffRecords({}, {}, s), []);
  });
});

describe('display', () => {
  test('carries type, format, and labels only for the values in the change', () => {
    const [c] = diff({ status: 'lead' }, { status: 'active' });
    assert.deepEqual(c!.display, { type: 'string', beforeLabel: 'Lead', afterLabel: 'Active customer' });
    const [d] = diff({}, { updatedAt: '2026-10-05T10:00:00Z' });
    assert.deepEqual(d!.display, { type: 'string', format: 'date-time' });
  });

  test('coded fields with no label keep the code as their label, so it is never quoted', () => {
    const s = jsonSchemaAdapter({ type: 'object', properties: { season: { type: 'string', enum: ['SS27', 'AW27'] } } });
    assert.deepEqual(diffRecords({ season: 'SS27' }, { season: 'AW27' }, s)[0]!.display, { type: 'string', beforeLabel: 'SS27', afterLabel: 'AW27' });
  });

  test('a redacted change keeps no value labels', () => {
    const s = jsonSchemaAdapter({ type: 'object', properties: { tier: { type: 'string', writeOnly: true, oneOf: [{ const: 'a', title: 'Gold' }] } } });
    assert.deepEqual(diffRecords({}, { tier: 'a' }, s)[0]!.display, { type: 'string' });
  });

  test('fields the schema does not describe have no type', () => {
    assert.deepEqual(diff({}, { legacyId: 1 })[0]!.display, {});
  });
});

describe('records', () => {
  test('created and deleted records are one change carrying the whole value', () => {
    const created = diff(null, { name: 'R', password: 'secret', updatedAt: 'x' }, { ignore: ['/updatedAt'] });
    assert.deepEqual(created, [{ code: 'RECORD_CREATED', afterPath: '', schemaPath: '', labels: ['Contact'], after: { name: 'R' }, display: { type: 'object' }, inSchema: true }]);
    const deleted = diff({ name: 'R' }, null);
    assert.deepEqual(codes(deleted), ['RECORD_DELETED']);
    assert.deepEqual(deleted[0]!.before, { name: 'R' });
    assert.deepEqual(diff(null, null), []);
  });

  test('a record that is not an object throws NOT_JSON', () => {
    assert.throws(() => diff([], {}), { code: 'NOT_JSON', side: 'before' });
  });
});

describe('lists of objects', () => {
  const order = (id: string, qty = 1, product = `P${id}`) => ({ id, product, qty });

  test('added items carry the whole item, with sensitive fields stripped', () => {
    const changes = diff({ orders: [] }, { orders: [{ id: 'A3', product: 'Green dupatta', qty: 1, note: 'private' }] });
    assert.deepEqual(changes, [{
      code: 'ITEM_ADDED',
      afterPath: '/orders/0',
      schemaPath: '/properties/orders/items',
      labels: ['Orders', 'Green dupatta'],
      after: { id: 'A3', product: 'Green dupatta', qty: 1 },
      item: { key: 'A3', label: 'Green dupatta' },
      display: { type: 'object', itemNoun: 'Order' },
      inSchema: true,
    }]);
  });

  test('a missing or null list counts as []', () => {
    assert.deepEqual(codes(diff({}, { orders: [order('A')] })), ['ITEM_ADDED']);
    assert.deepEqual(codes(diff({ orders: null }, { orders: [order('A')] })), ['ITEM_ADDED']);
    assert.deepEqual(codes(diff({ orders: [order('A')] }, {})), ['ITEM_REMOVED']);
    assert.deepEqual(diff({}, { orders: [] }), []);
  });

  test('a moved item gives its field changes, with each path in its own version, plus LIST_REORDERED', () => {
    const changes = diff({ orders: [order('A'), order('B', 1)] }, { orders: [order('B', 2), order('A')] });
    assert.deepEqual(codes(changes), ['FIELD_CHANGED', 'LIST_REORDERED']);
    assert.equal(changes[0]!.beforePath, '/orders/1/qty');
    assert.equal(changes[0]!.afterPath, '/orders/0/qty');
    assert.deepEqual(changes[1], {
      code: 'LIST_REORDERED',
      beforePath: '/orders',
      afterPath: '/orders',
      schemaPath: '/properties/orders',
      labels: ['Orders'],
      before: ['A', 'B'],
      after: ['B', 'A'],
      display: { type: 'array', itemNoun: 'Order' },
      inSchema: true,
    });
  });

  test('adding or removing items alone is not a reorder', () => {
    assert.deepEqual(codes(diff({ orders: [order('A'), order('B')] }, { orders: [order('B')] })), ['ITEM_REMOVED']);
    assert.deepEqual(codes(diff({ orders: [order('A')] }, { orders: [order('Z'), order('A')] })), ['ITEM_ADDED']);
  });

  test('reorder is reported even when items were also added', () => {
    const changes = diff({ orders: [order('A'), order('B')] }, { orders: [order('B'), order('C'), order('A')] });
    assert.deepEqual(codes(changes), ['ITEM_ADDED', 'LIST_REORDERED']);
  });

  test('a sensitive field inside a matched item is redacted', () => {
    const [c] = diff({ orders: [{ id: 'A', note: 'x' }] }, { orders: [{ id: 'A', note: 'y' }] });
    assert.equal(c!.redacted, true);
    assert.equal('before' in c!, false);
    assert.equal('after' in c!, false);
    assert.deepEqual(c!.labels, ['Orders', 'A', 'Note']);
  });

  test('item without its key throws ITEM_KEY_MISSING', () => {
    assert.throws(() => diff({ orders: [{ product: 'x' }] }, {}), { code: 'ITEM_KEY_MISSING', path: '/orders/0', side: 'before' });
    assert.throws(() => diff({}, { orders: ['x'] }), { code: 'ITEM_KEY_MISSING', side: 'after' });
  });

  test('duplicate keys throw DUPLICATE_KEY', () => {
    assert.throws(() => diff({}, { orders: [order('A'), order('A')] }), { code: 'DUPLICATE_KEY', path: '/orders', key: 'A' });
  });

  test('composite keys match on all fields, and label from key values when no template', () => {
    const s = jsonSchemaAdapter({
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          'x-key': ['product', 'size'],
          items: { type: 'object', properties: { product: { type: 'string' }, size: { type: 'string' }, qty: { type: 'integer' } } },
        },
      },
    });
    const changes = diffRecords(
      { lines: [{ product: 'Blue kurta', size: 'M', qty: 1 }, { product: 'Blue kurta', size: 'L', qty: 1 }] },
      { lines: [{ product: 'Blue kurta', size: 'M', qty: 2 }, { product: 'Blue kurta', size: 'L', qty: 1 }] },
      s,
    );
    assert.deepEqual(changes.map((c) => [c.code, c.labels, c.item]), [
      ['FIELD_CHANGED', ['Lines', 'Blue kurta, M', 'Qty'], { key: ['Blue kurta', 'M'], label: 'Blue kurta, M' }],
    ]);
  });

  test('a sensitive list leaks neither values, keys nor labels', () => {
    const s = jsonSchemaAdapter({
      type: 'object',
      properties: {
        cards: { type: 'array', 'x-sensitive': true, 'x-key': 'last4', items: { type: 'object', properties: { last4: { type: 'string' } } } },
      },
    });
    const [c] = diffRecords({}, { cards: [{ last4: '4242' }] }, s);
    assert.deepEqual(c, { code: 'ITEM_ADDED', afterPath: '/cards/0', schemaPath: '/properties/cards/items', labels: ['Cards', 'Item'], display: { type: 'object', itemNoun: 'Item' }, redacted: true, inSchema: true });
  });
});

describe('lists of plain values', () => {
  test('compared by value, counting duplicates', () => {
    const changes = diff({ tags: ['a', 'a', 'b'] }, { tags: ['b', 'a', 'vip'] });
    assert.deepEqual(changes.map((c) => [c.code, c.beforePath ?? c.afterPath, c.before ?? c.after]), [
      ['ITEM_REMOVED', '/tags/1', 'a'],
      ['ITEM_ADDED', '/tags/2', 'vip'],
    ]);
    assert.deepEqual(changes[1]!.labels, ['Tags']);
  });

  test('order is never reported', () => {
    assert.deepEqual(diff({ tags: ['a', 'b'] }, { tags: ['b', 'a'] }), []);
  });

  test('a sensitive list of tags is redacted', () => {
    const s = jsonSchemaAdapter({ type: 'object', properties: { codes: { type: 'array', 'x-sensitive': true, items: { type: 'string' } } } });
    const [c] = diffRecords({}, { codes: ['1234'] }, s);
    assert.equal(c!.redacted, true);
    assert.equal('after' in c!, false);
  });
});

describe('lists the schema does not describe', () => {
  test('compared as one value, with missing, null and [] all empty', () => {
    assert.deepEqual(diff({}, { extras: [] }), []);
    assert.deepEqual(diff({ extras: null }, { extras: [] }), []);
    assert.deepEqual(codes(diff({ extras: [] }, { extras: [{ a: 1 }] })), ['FIELD_SET']);
    assert.deepEqual(codes(diff({ extras: [1] }, { extras: [] })), ['FIELD_CLEARED']);
    const [c] = diff({ extras: [1, 'x'] }, { extras: [2, 'x'] });
    assert.deepEqual([c!.code, c!.before, c!.after, c!.inSchema], ['FIELD_CHANGED', [1, 'x'], [2, 'x'], false]);
  });
});

describe('sensitive fields', () => {
  test('a changed sensitive field has no values', () => {
    assert.deepEqual(diff({ password: 'a' }, { password: 'b' }), [{
      code: 'FIELD_CHANGED', beforePath: '/password', afterPath: '/password', schemaPath: '/properties/password',
      labels: ['Password'], display: { type: 'string' }, redacted: true, inSchema: true,
    }]);
  });

  test('stripped at every depth from a whole object', () => {
    const s = jsonSchemaAdapter({
      type: 'object',
      properties: { login: { type: 'object', properties: { user: { type: 'string' }, pass: { type: 'string', writeOnly: true } } } },
    });
    const [c] = diffRecords({}, { login: { user: 'r', pass: 'x' } }, s);
    assert.deepEqual(c!.after, { user: 'r' });
  });

  test('a sensitive object is redacted as a whole', () => {
    const s = jsonSchemaAdapter({ type: 'object', properties: { bank: { type: 'object', 'x-sensitive': true, properties: { acct: { type: 'string' } } } } });
    const [c] = diffRecords({}, { bank: { acct: '1' } }, s);
    assert.equal(c!.redacted, true);
    assert.equal('after' in c!, false);
  });
});

describe('ignore', () => {
  test('ignored paths are never reported, at the top and inside list items', () => {
    const opts = { ignore: ['/updatedAt', '/orders/*/syncedAt'] };
    assert.deepEqual(diff({ updatedAt: '1' }, { updatedAt: '2' }, opts), []);
    assert.deepEqual(diff({ orders: [{ id: 'A', syncedAt: 1 }] }, { orders: [{ id: 'A', syncedAt: 2 }] }, opts), []);
  });

  test('ignored fields are stripped from whole values', () => {
    const [c] = diff({}, { orders: [{ id: 'A', syncedAt: 1 }] }, { ignore: ['/orders/*/syncedAt'] });
    assert.deepEqual(c!.after, { id: 'A' });
  });

  test('an object holding only ignored fields counts as empty', () => {
    const s = jsonSchemaAdapter({ type: 'object', properties: { sync: { type: 'object', properties: { at: { type: 'string' } } } } });
    assert.deepEqual(diffRecords({}, { sync: { at: 'x' } }, s, { ignore: ['/sync/at'] }), []);
  });
});

describe('limits and input checks', () => {
  test('maxChanges stops the walk with one TRUNCATED', () => {
    const before = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i]));
    const after = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i + 1]));
    const changes = diff(before, after, { maxChanges: 3 });
    assert.deepEqual(codes(changes), ['FIELD_CHANGED', 'FIELD_CHANGED', 'FIELD_CHANGED', 'TRUNCATED']);
    assert.deepEqual(changes[3], { code: 'TRUNCATED', labels: [], display: {}, inSchema: true });
    assert.equal(diff(before, after, { maxChanges: 10 }).length, 10);
  });

  test('maxDepth throws TOO_DEEP', () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 40; i++) deep = (deep['x'] = {}) as Record<string, unknown>;
    assert.throws(() => diff(root, {}), { code: 'TOO_DEEP', side: 'before' });
    assert.doesNotThrow(() => diff(root, {}, { maxDepth: 50 }));
  });

  test('values that are not JSON throw NOT_JSON with the path', () => {
    assert.throws(() => diff({ d: new Date() }, {}), { code: 'NOT_JSON', path: '/d' });
    assert.throws(() => diff({}, { n: NaN }), { code: 'NOT_JSON', path: '/n', side: 'after' });
    assert.throws(() => diff({}, { n: Infinity }), { code: 'NOT_JSON' });
    assert.throws(() => diff({}, { f: () => 1 }), { code: 'NOT_JSON' });
    assert.throws(() => diff({}, { a: [1, undefined] }), { code: 'NOT_JSON', path: '/a/1' });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    assert.throws(() => diff(cyclic, {}), { code: 'NOT_JSON', path: '/self' });
  });

  test('a shared, non-cyclic object is fine', () => {
    const shared = { city: 'C' };
    assert.deepEqual(diff({ address: shared, other: shared }, { address: shared, other: shared }), []);
  });

  test('inputs are not mutated', () => {
    const b = structuredClone(specBefore);
    const a = structuredClone(specAfter);
    diff(b, a, { ignore: ['/orders/*/qty'] });
    assert.deepEqual(b, specBefore);
    assert.deepEqual(a, specAfter);
  });
});
