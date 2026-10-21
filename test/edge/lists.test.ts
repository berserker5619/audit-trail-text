// Edge cases 10-13: keys and lists.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRecords, jsonSchemaAdapter, type Change } from '../../src/index.ts';
import { DECISION, schema, sentences } from './helpers.ts';

const orders = schema({
  o: {
    type: 'array',
    title: 'Orders',
    'x-key': 'id',
    'x-label': '{name}',
    items: { type: 'object', title: 'Order', properties: { id: {}, name: { type: 'string' }, qty: { type: 'integer', title: 'Qty' } } },
  },
});
const codes = (cs: Change[]) => cs.map((c) => c.code);

test('10. item keys 1 and "1" are different items, both labelled "1" (documented as intended)', () => {
  assert.deepEqual(codes(diffRecords({ o: [{ id: 1 }] }, { o: [{ id: '1' }] }, orders)), ['ITEM_REMOVED', 'ITEM_ADDED']);
  assert.deepEqual(sentences(orders, { o: [{ id: 1 }] }, { o: [{ id: '1' }] }), ['Order "1" removed from Orders', 'Order "1" added to Orders']);
});

test('10b. a key that is null, missing or "" throws ITEM_KEY_MISSING with the item path', () => {
  for (const id of [null, undefined, '']) {
    assert.throws(() => diffRecords({}, { o: [{ id: 'a' }, { id }] }, orders), { code: 'ITEM_KEY_MISSING', path: '/o/1', side: 'after' });
  }
});

test('10c. a key that is an object or an array throws INVALID_KEY with the item path (#1)', () => {
  assert.throws(() => diffRecords({}, { o: [{ id: 'a' }, { id: { a: 1 } }] }, orders), { code: 'INVALID_KEY', path: '/o/1', side: 'after', message: /"id"/ });
  assert.throws(() => diffRecords({ o: [{ id: [1] }] }, {}, orders), { code: 'INVALID_KEY', side: 'before' });
  // Strings, numbers and booleans are fine.
  assert.doesNotThrow(() => diffRecords({}, { o: [{ id: 'a' }, { id: 2 }, { id: true }] }, orders));
});

test('10d. keys that differ only in case are different items', () => {
  assert.deepEqual(codes(diffRecords({ o: [{ id: 'A1' }] }, { o: [{ id: 'a1' }] }, orders)), ['ITEM_REMOVED', 'ITEM_ADDED']);
  assert.doesNotThrow(() => diffRecords({}, { o: [{ id: 'A1' }, { id: 'a1' }] }, orders));
});

test('10e. a composite key with one part missing throws ITEM_KEY_MISSING naming the part', () => {
  const lines = jsonSchemaAdapter({
    type: 'object',
    properties: { l: { type: 'array', 'x-key': ['sku', 'size'], items: { type: 'object', properties: { sku: { type: 'string' }, size: { type: 'string' } } } } },
  });
  assert.throws(() => diffRecords({}, { l: [{ sku: 'K1' }] }, lines), { code: 'ITEM_KEY_MISSING', path: '/l/0', message: /"size"/ });
});

test('11. arrays of arrays are compared by value, counting duplicates', () => {
  const matrix = schema({ m: { type: 'array', title: 'M', items: { type: 'array', items: { type: 'number' } } } });
  assert.deepEqual(diffRecords({ m: [[1, 2], [3]] }, { m: [[3], [1, 2]] }, matrix), []);
  assert.deepEqual(sentences(matrix, { m: [[1, 2], [3]] }, { m: [[1, 2], [3, 4]] }), ['[3] removed from M', '[3,4] added to M']);
});

test('11b. a list of objects inside an item inside another list, three levels deep', () => {
  const s = jsonSchemaAdapter({
    type: 'object',
    properties: {
      styles: {
        type: 'array', 'x-key': 'no',
        items: { type: 'object', properties: { no: { type: 'string' },
          colours: { type: 'array', 'x-key': 'code',
            items: { type: 'object', properties: { code: { type: 'string' },
              sizes: { type: 'array', 'x-key': 'size', items: { type: 'object', title: 'Size', properties: { size: { type: 'string' }, qty: { type: 'integer' } } } } } } } } },
      },
    },
  });
  const before = { styles: [{ no: 'S1', colours: [{ code: 'NVY', sizes: [{ size: 'M', qty: 1 }] }] }] };
  const after = { styles: [{ no: 'S1', colours: [{ code: 'NVY', sizes: [{ size: 'M', qty: 2 }, { size: 'L', qty: 1 }] }] }] };
  const changes = diffRecords(before, after, s);
  assert.deepEqual(changes.map((c) => [c.code, c.beforePath ?? null, c.afterPath, c.labels, c.display.itemLabels]), [
    ['FIELD_CHANGED', '/styles/0/colours/0/sizes/0/qty', '/styles/0/colours/0/sizes/0/qty', ['Styles', 'S1', 'Colours', 'NVY', 'Sizes', 'M', 'Qty'], [1, 3, 5]],
    ['ITEM_ADDED', null, '/styles/0/colours/0/sizes/1', ['Styles', 'S1', 'Colours', 'NVY', 'Sizes', 'L'], [1, 3, 5]],
  ]);
  assert.deepEqual(sentences(s, before, after), [
    'Styles › S1 › Colours › NVY › Sizes › M: Qty changed from 1 to 2',
    'Styles › S1 › Colours › NVY: Size "L" added to Sizes',
  ]);
});

test('11c. tuple-style items (items as an array, or prefixItems) are compared as one value', () => {
  for (const def of [{ items: [{ type: 'string' }, { type: 'number' }] }, { prefixItems: [{ type: 'string' }, { type: 'number' }] }]) {
    const s = schema({ t: { type: 'array', title: 'T', ...def } });
    assert.deepEqual(sentences(s, { t: ['a', 1] }, { t: ['a', 2] }), ['T changed']);
  }
});

test('12. one edit that moves, changes, adds and removes items at once', () => {
  const before = { o: [{ id: 'A', qty: 1 }, { id: 'B', qty: 1 }, { id: 'C', qty: 1 }, { id: 'D', qty: 1 }] };
  const after = { o: [{ id: 'C', qty: 1 }, { id: 'E', qty: 1 }, { id: 'A', qty: 5 }, { id: 'B', qty: 1 }] };
  const changes = diffRecords(before, after, orders);
  assert.deepEqual(changes.map((c) => [c.code, c.item?.key ?? null, c.beforePath ?? null, c.afterPath ?? null]), [
    ['FIELD_CHANGED', 'A', '/o/0/qty', '/o/2/qty'],
    ['ITEM_REMOVED', 'D', '/o/3', null],
    ['ITEM_ADDED', 'E', null, '/o/1'],
    ['LIST_REORDERED', null, '/o', '/o'],
  ]);
  // Only the item that moved is stored: A and B kept their order, C moved ahead of them.
  assert.deepEqual([changes[3]!.before, changes[3]!.after, changes[3]!.display.moved], [['C'], ['C'], 1]);
});

function bigList(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `K${i}`, name: `Item ${i}`, qty: i }));
}
function time(f: () => unknown): number {
  const start = performance.now();
  f();
  return performance.now() - start;
}

test('13. 10,000 items with 100 changed, and 10,000 reordered, in linear time', (t) => {
  const before = { o: bigList(10_000) };
  const changed = { o: before.o.map((x, i) => (i % 100 === 0 ? { ...x, qty: -1 } : x)) };
  const reordered = { o: [...before.o].reverse() };

  let changes: Change[] = [];
  const tChanged = time(() => (changes = diffRecords(before, changed, orders)));
  assert.equal(changes.length, 100);
  const tReordered = time(() => (changes = diffRecords(before, reordered, orders)));
  assert.deepEqual(codes(changes), ['LIST_REORDERED']);

  // Linear, not quadratic: four times the items should take about four times as long, not sixteen.
  const small = { o: bigList(20_000) };
  const large = { o: bigList(80_000) };
  const rev = (r: { o: unknown[] }) => ({ o: [...r.o].reverse() });
  const tSmall = Math.min(...[1, 2, 3].map(() => time(() => diffRecords(small, rev(small), orders))));
  const tLarge = Math.min(...[1, 2, 3].map(() => time(() => diffRecords(large, rev(large), orders))));
  const ratio = tLarge / tSmall;
  t.diagnostic(`10,000 items, 100 changed: ${tChanged.toFixed(1)} ms`);
  t.diagnostic(`10,000 items reversed: ${tReordered.toFixed(1)} ms`);
  t.diagnostic(`20,000 reversed: ${tSmall.toFixed(1)} ms; 80,000 reversed: ${tLarge.toFixed(1)} ms; ratio ${ratio.toFixed(1)} (linear about 4, quadratic about 16)`);
  assert.ok(ratio < 9, `4x the items took ${ratio.toFixed(1)}x as long`);
  assert.ok(tChanged < 2000 && tReordered < 2000);
});

test('13b. a reorder stores only the moved keys, at most 100, with the count in display.moved (#2)', () => {
  const before = { o: bigList(10_000) };
  const [reversed] = diffRecords(before, { o: [...before.o].reverse() }, orders);
  assert.equal(reversed!.display.moved, 9_999);
  assert.equal((reversed!.before as unknown[]).length, 100);
  assert.equal((reversed!.after as unknown[]).length, 100);
  assert.ok(JSON.stringify(reversed).length < 5_000);
  // The same keys on both sides, each in its own order.
  assert.deepEqual([...(reversed!.before as string[])].sort(), [...(reversed!.after as string[])].sort());

  // One item moved from the end to the front of 10,000: one key stored.
  const moved = { o: [before.o[9_999]!, ...before.o.slice(0, 9_999)] };
  const [one] = diffRecords(before, moved, orders);
  assert.deepEqual([one!.before, one!.after, one!.display.moved], [['K9999'], ['K9999'], 1]);
});
