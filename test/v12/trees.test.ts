// 1.2: recursive schemas and moves across parents.
import assert from 'node:assert/strict';
import { describe as group, test } from 'node:test';
import { describe, diffRecords, jsonSchemaAdapter, type Change } from '../../src/index.ts';
import { part, style, styleSchema, texts } from './helpers.ts';

const tree = jsonSchemaAdapter(styleSchema());
const perList = jsonSchemaAdapter(styleSchema({}));

/** Six levels of parts: Garment › Body › Sleeve › Cuff › Button › Thread. */
const bom = () =>
  style(
    part('Garment', 1, [
      part('Body', 1, [
        part('Sleeve', 2, [part('Cuff', 2, [part('Button', 4, [part('Thread', 1)])]), part('Placket', 1)]),
        part('Collar', 1, [part('Stand', 1)]),
        part('Pocket', 1),
      ]),
    ]),
  );

group('recursive schemas', () => {
  test('a tree six levels deep: edits, adds, removes and a reorder, each where it happened', () => {
    const after = bom();
    const body = after.parts[0]!.parts![0]!;
    const [sleeve, collar] = body.parts!;
    sleeve!.parts![0]!.parts![0]!.parts![0]!.qty = 2; // Thread
    sleeve!.qty = 3;
    collar!.parts!.push(part('Band', 1)); // added
    body.parts = [collar!, sleeve!]; // reordered; Pocket removed
    assert.deepEqual(texts(tree, bom(), after), [
      // Matched items are walked in their order after the edit: Collar, then Sleeve.
      'Parts › Garment › Body: Part "Band" added to Collar',
      'Parts › Garment › Body › Sleeve: Quantity changed from 2 to 3',
      '… › Cuff › Button › Thread: Quantity changed from 1 to 2',
      'Parts › Garment: Part "Pocket" removed from Body',
      'Parts › Garment: Body reordered',
    ]);
  });

  test('a nested list of the same definition adds no title of its own, and labels keep the full path', () => {
    const after = bom();
    after.parts[0]!.parts![0]!.parts![0]!.parts![0]!.parts![0]!.parts![0]!.qty = 9;
    const [c] = diffRecords(bom(), after, tree);
    assert.deepEqual(c!.labels, ['Parts', 'Garment', 'Body', 'Sleeve', 'Cuff', 'Button', 'Thread', 'Quantity']);
    assert.deepEqual(c!.display.itemLabels, [1, 2, 3, 4, 5, 6]);
    assert.equal(c!.afterPath, '/parts/0/parts/0/parts/0/parts/0/parts/0/parts/0/qty');
  });

  test('schemaPath names the definition, so every level shares one path', () => {
    const after = bom();
    after.parts[0]!.qty = 5;
    after.parts[0]!.parts![0]!.parts![0]!.parts![0]!.qty = 5;
    const paths = diffRecords(bom(), after, tree).map((c) => c.schemaPath);
    assert.deepEqual(paths, ['/$defs/part/properties/qty', '/$defs/part/properties/qty']);
  });

  test('maxParents keeps the last enclosing items; Infinity keeps them all', () => {
    const after = bom();
    after.parts[0]!.parts![0]!.parts![0]!.parts![0]!.qty = 3; // Cuff: four items above the field
    assert.deepEqual(texts(tree, bom(), after), ['… › Body › Sleeve › Cuff: Quantity changed from 2 to 3']);
    assert.deepEqual(texts(tree, bom(), after, { maxParents: Infinity }), ['Parts › Garment › Body › Sleeve › Cuff: Quantity changed from 2 to 3']);
    assert.deepEqual(texts(tree, bom(), after, { maxParents: 1 }), ['… › Cuff: Quantity changed from 2 to 3']);
    assert.deepEqual(texts(tree, bom(), after, { maxParents: 0 }), ['…: Quantity changed from 2 to 3']);
    assert.throws(() => describe([], { maxParents: -1 }), { code: 'INVALID_OPTION', path: 'maxParents' });
  });

  test('labels file entries for a definition apply wherever it is used; a path entry wins at its place', () => {
    const labels = { '$defs/part/qty': 'Qty', '/parts/*/qty': 'Top qty', '$defs/partList#label': '{id} ({qty})' };
    const a = jsonSchemaAdapter(styleSchema(), { labels, strictLabels: true });
    const after = bom();
    after.parts[0]!.qty = 2;
    after.parts[0]!.parts![0]!.qty = 2;
    assert.deepEqual(texts(a, bom(), after), [
      // Items are named as they are after the edit.
      'Parts › Garment (2): Top qty changed from 1 to 2',
      'Parts › Garment (2) › Body (2): Qty changed from 1 to 2',
    ]);
  });

  test('a recursive key and label are checked once the tree is built', () => {
    const s = styleSchema();
    (s.$defs.partList as Record<string, unknown>)['x-key'] = 'sku';
    assert.throws(() => jsonSchemaAdapter(s), { code: 'KEY_NOT_IN_SCHEMA' });
    const secret = styleSchema();
    (secret.$defs.part.properties as Record<string, unknown>)['name'] = { type: 'string', 'x-sensitive': true };
    assert.throws(() => jsonSchemaAdapter(secret), { code: 'SENSITIVE_KEY' });
  });

  test('a list whose items are lists of itself is nested arrays, compared as values', () => {
    const a = jsonSchemaAdapter({ type: 'object', properties: { grid: { $ref: '#/$defs/g' } }, $defs: { g: { type: 'array', title: 'Grid', items: { $ref: '#/$defs/g' } } } });
    assert.deepEqual(texts(a, { grid: [[1], [2]] }, { grid: [[1], [3]] }), ['[2] removed from Grid', '[3] added to Grid']);
  });

  test('a record 10,000 levels deep diffs and describes without a stack overflow', () => {
    const n = 4999; // root, then a list and a part per level: 2n + 1 = 9,999 levels, plus the leaf's value
    const chain = (leafQty: number, moved = false) => {
      let node: Record<string, unknown> = { id: `p${n}`, name: `p${n}`, qty: leafQty };
      for (let i = n - 1; i >= 1; i--) node = { id: `p${i}`, name: `p${i}`, qty: 1, parts: [node] };
      return { parts: moved ? [node, { id: 'top', name: 'top', qty: 1 }] : [node] };
    };
    for (const a of [perList, tree]) {
      const changes = diffRecords(chain(1), chain(2), a, { maxDepth: 10000 });
      assert.equal(changes.length, 1);
      assert.equal(changes[0]!.labels.length, n + 2);
      assert.equal(describe(changes)[0]!.text, `… › p${n - 2} › p${n - 1} › p${n}: Quantity changed from 1 to 2`);
      const removed = diffRecords(chain(1), { parts: [] }, a, { maxDepth: 10000 });
      assert.deepEqual(describe(removed).map((s) => s.text), ['Part "p1" removed from Parts']);
      assert.deepEqual(diffRecords(chain(1), chain(1), a, { maxDepth: 10000 }), []);
    }
    // The leaf moves to the top of the tree.
    const before = chain(1);
    const after = chain(1);
    let last = after.parts[0] as Record<string, unknown>;
    while ((last['parts'] as unknown[])[0] && ((last['parts'] as Record<string, unknown>[])[0]!['parts'])) last = (last['parts'] as Record<string, unknown>[])[0]!;
    const leaf = (last['parts'] as unknown[]).pop();
    after.parts.push(leaf as never);
    assert.deepEqual(describe(diffRecords(before, after, tree, { maxDepth: 10000 })).map((s) => s.text), [`Part "p${n}" moved from p${n - 1} to Parts`]);
    assert.throws(() => diffRecords(chain(1), chain(1), tree), { code: 'TOO_DEEP' });
  });
});

group('moves across parents', () => {
  const moveCuff = () => {
    const after = bom();
    const [sleeve, collar] = after.parts[0]!.parts![0]!.parts!;
    collar!.parts!.push(sleeve!.parts!.shift()!);
    return after;
  };

  test('an item that changes parent is one ITEM_MOVED, with both paths and both parents', () => {
    const changes = diffRecords(bom(), moveCuff(), tree);
    assert.deepEqual(changes, [{
      code: 'ITEM_MOVED',
      beforePath: '/parts/0/parts/0/parts/0/parts/0',
      afterPath: '/parts/0/parts/0/parts/1/parts/1',
      schemaPath: '/$defs/part',
      labels: ['Parts', 'Garment', 'Body', 'Collar', 'Cuff'],
      item: { key: 'Cuff', label: 'Cuff' },
      display: {
        type: 'object',
        itemNoun: 'Part',
        fromParent: ['Parts', 'Garment', 'Body', 'Sleeve'],
        toParent: ['Parts', 'Garment', 'Body', 'Collar'],
        fromItemLabels: [1, 2, 3],
        itemLabels: [1, 2, 3, 4],
      },
      inSchema: true,
    }]);
    assert.deepEqual(describe(changes).map((s) => s.text), ['Part "Cuff" moved from Sleeve to Collar']);
  });

  test('with list scope, the same edit is a remove and an add, as in 1.1', () => {
    assert.deepEqual(texts(perList, bom(), moveCuff()), [
      'Parts › Garment › Body: Part "Cuff" removed from Sleeve',
      'Parts › Garment › Body: Part "Cuff" added to Collar',
    ]);
  });

  test('the moved item\'s field changes follow, reported at the new place', () => {
    const after = moveCuff();
    const cuff = after.parts[0]!.parts![0]!.parts![1]!.parts![1]!;
    cuff.qty = 6;
    cuff.parts![0]!.qty = 5; // Button, which moves with it
    const changes = diffRecords(bom(), after, tree);
    assert.deepEqual(describe(changes, { maxParents: Infinity }).map((s) => s.text), [
      'Part "Cuff" moved from Sleeve to Collar',
      'Parts › Garment › Body › Collar › Cuff: Quantity changed from 2 to 6',
      'Parts › Garment › Body › Collar › Cuff › Button: Quantity changed from 4 to 5',
    ]);
    assert.equal(changes[1]!.beforePath, '/parts/0/parts/0/parts/0/parts/0/qty');
    assert.equal(changes[1]!.afterPath, '/parts/0/parts/0/parts/1/parts/1/qty');
  });

  test('a child that stays under its moving parent is not moved; one that leaves for another parent is', () => {
    const after = moveCuff();
    const [sleeve, collar] = after.parts[0]!.parts![0]!.parts!;
    const cuff = collar!.parts![1]!;
    sleeve!.parts!.push(cuff.parts![0]!.parts!.shift()!); // Thread leaves Button for Sleeve
    assert.deepEqual(texts(tree, bom(), after), ['Part "Thread" moved from Button to Sleeve', 'Part "Cuff" moved from Sleeve to Collar']);
  });

  test('moved and renamed at once: the item is named as it is after, and the rename shows on its own', () => {
    const after = moveCuff();
    after.parts[0]!.parts![0]!.parts![1]!.parts![1]!.name = 'French cuff';
    const changes = diffRecords(bom(), after, tree);
    assert.deepEqual(changes.map((c) => [c.code, c.labels.at(-1), c.item]), [
      ['ITEM_MOVED', 'French cuff', { key: 'Cuff', label: 'French cuff' }],
      ['FIELD_CHANGED', 'Name', { key: 'Cuff', label: 'French cuff' }],
    ]);
    assert.deepEqual(describe(changes, { maxParents: Infinity }).map((s) => s.text), [
      'Part "French cuff" moved from Sleeve to Collar',
      'Parts › Garment › Body › Collar › French cuff: Name changed from "Cuff" to "French cuff"',
    ]);
  });

  test('an item moved into a new parent: the parent is added, then the move is reported', () => {
    const after = bom();
    const sleeve = after.parts[0]!.parts![0]!.parts![0]!;
    const cuff = sleeve.parts!.shift()!;
    after.parts.push(part('Spares', 1, [cuff]));
    assert.deepEqual(texts(tree, bom(), after), ['Part "Spares" added to Parts', 'Part "Cuff" moved from Sleeve to Spares']);
  });

  test('an item moved out of a removed parent: the parent is removed, and the move is reported where it went', () => {
    const after = bom();
    const body = after.parts[0]!.parts![0]!;
    const sleeve = body.parts!.shift()!;
    body.parts!.push(sleeve.parts!.shift()!);
    assert.deepEqual(texts(tree, bom(), after), ['Parts › Garment: Part "Sleeve" removed from Body', 'Part "Cuff" moved from Sleeve to Body']);
  });

  test('to and from name as many trailing labels as tell the two parents apart', () => {
    const before = style(part('Shirt', 1, [part('Sleeve', 1, [part('Cuff')])]), part('Jacket', 1, [part('Sleeve2', 1)]));
    before.parts[1]!.parts![0]!.name = 'Sleeve';
    const after = style(part('Shirt', 1, [part('Sleeve', 1)]), part('Jacket', 1, [part('Sleeve2', 1, [part('Cuff')])]));
    after.parts[1]!.parts![0]!.name = 'Sleeve';
    assert.deepEqual(texts(tree, before, after), ['Part "Cuff" moved from Shirt › Sleeve to Jacket › Sleeve']);
  });

  test('a key used twice in one tree throws DUPLICATE_KEY with both paths; list scope allows it', () => {
    const twice = style(part('Body', 1, [part('Cuff')]), part('Collar', 1, [part('Cuff')]));
    assert.throws(() => diffRecords(twice, twice, tree), (e: Error & Record<string, unknown>) => {
      assert.equal(e['code'], 'DUPLICATE_KEY');
      assert.equal(e['side'], 'before');
      assert.equal(e['key'], 'Cuff');
      assert.deepEqual(e['paths'], ['/parts/0/parts/0', '/parts/1/parts/0']);
      assert.match(e.message, /\/parts\/0\/parts\/0 and \/parts\/1\/parts\/0/);
      return true;
    });
    assert.deepEqual(diffRecords(twice, twice, perList), []);
  });

  test('duplicates are checked within each version: the same key under different parents across versions is a move', () => {
    const before = style(part('Body', 1, [part('Cuff')]), part('Collar', 1));
    const after = style(part('Body', 1), part('Collar', 1, [part('Cuff')]));
    assert.deepEqual(texts(tree, before, after), ['Part "Cuff" moved from Body to Collar']);
  });

  test('a top-level item moved under another, and back', () => {
    const before = style(part('Body'), part('Cuff'));
    const after = style(part('Body', 1, [part('Cuff')]));
    assert.deepEqual(texts(tree, before, after), ['Part "Cuff" moved from Parts to Body']);
    assert.deepEqual(texts(tree, after, before), ['Part "Cuff" moved from Body to Parts']);
  });

  test('order within the new parent is not reported; LIST_REORDERED still covers moves within one list', () => {
    const before = style(part('A', 1, [part('x'), part('y')]), part('B', 1, [part('z')]));
    const after = style(part('A', 1, [part('y')]), part('B', 1, [part('x'), part('z')]));
    assert.deepEqual(texts(tree, before, after), ['Part "x" moved from A to B']);
  });

  test('tree scope from the labels file', () => {
    const a = jsonSchemaAdapter(styleSchema({}), { labels: { '$defs/partList#scope': 'tree' }, strictLabels: true });
    assert.deepEqual(texts(a, bom(), moveCuff()), ['Part "Cuff" moved from Sleeve to Collar']);
    assert.throws(() => jsonSchemaAdapter(styleSchema({ 'x-key-scope': 'forest' })), { code: 'INVALID_SCHEMA' });
  });

  test('only within one definition: a key moving between lists of different definitions is a remove and an add', () => {
    const s = {
      type: 'object',
      properties: {
        orders: { type: 'array', title: 'Orders', 'x-key': 'id', 'x-key-scope': 'tree', items: { type: 'object', title: 'Line', properties: { id: { type: 'string' } } } },
        quotes: { type: 'array', title: 'Quotes', 'x-key': 'id', 'x-key-scope': 'tree', items: { type: 'object', title: 'Line', properties: { id: { type: 'string' } } } },
      },
    };
    assert.deepEqual(texts(jsonSchemaAdapter(s), { orders: [{ id: 'L1' }] }, { quotes: [{ id: 'L1' }] }), [
      'Line "L1" removed from Orders',
      'Line "L1" added to Quotes',
    ]);
  });

  test('a sensitive tree list reports the move without the item', () => {
    const s = styleSchema({ 'x-key-scope': 'tree', 'x-sensitive': true });
    const changes = diffRecords(bom(), moveCuff(), jsonSchemaAdapter(s));
    assert.deepEqual(changes.map((c) => [c.code, c.redacted, c.item, c.labels]), [['ITEM_MOVED', true, undefined, ['Parts']]]);
    assert.deepEqual(describe(changes).map((s) => s.text), ['Part moved from Parts to Parts']);
  });

  test('swap property: diffing the other way keeps ITEM_MOVED with fromParent and toParent swapped', () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    // A random forest over the same ids: each id under a random earlier id, or at the top.
    const forest = () => {
      const nodes = new Map(ids.map((id) => [id, part(id, 1, [])]));
      const top: ReturnType<typeof part>[] = [];
      ids.forEach((id, i) => {
        const parent = i > 0 && r() < 0.7 ? ids[Math.floor(r() * i)]! : undefined;
        (parent ? nodes.get(parent)!.parts! : top).push(nodes.get(id)!);
      });
      return style(...top);
    };
    const moves = (cs: Change[]) =>
      cs.filter((c) => c.code === 'ITEM_MOVED').map((c) => JSON.stringify([c.item!.key, c.display.fromParent, c.display.toParent])).sort();
    for (let run = 0; run < 200; run++) {
      const a = forest();
      const b = forest();
      const forward = diffRecords(a, b, tree);
      const backward = diffRecords(b, a, tree);
      const swapped = backward
        .filter((c) => c.code === 'ITEM_MOVED')
        .map((c) => JSON.stringify([c.item!.key, c.display.toParent, c.display.fromParent]))
        .sort();
      assert.deepEqual(moves(forward), swapped, `run ${run}`);
      // Every id in both versions is either matched in place or moved: nothing is lost.
      assert.ok(!forward.some((c) => c.code === 'ITEM_ADDED' || c.code === 'ITEM_REMOVED'), `run ${run}`);
    }
  });
});
