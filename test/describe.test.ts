import assert from 'node:assert/strict';
import { describe as suite, test } from 'node:test';
import { describe, describeChanges, diffRecords, jsonSchemaAdapter, type Change } from '../src/index.ts';
import { contactSchema, specAfter, specBefore } from './helpers.ts';

const adapter = jsonSchemaAdapter(contactSchema);
const texts = (b: unknown, a: unknown, opts = {}) => describeChanges(b, a, adapter, { locale: 'en-IN', ...opts }).map((s) => s.text);
const one = (b: unknown, a: unknown, opts = {}) => texts(b, a, opts)[0];

suite('default English sentences', () => {
  test('the spec example', () => {
    assert.deepEqual(texts(specBefore, specAfter), [
      'Phone changed from "98400 11111" to "98400 22222"',
      'Status changed from Lead to Active customer',
      'Orders › Blue kurta: Quantity changed from 2 to 3',
      'Order "Red saree" removed from Orders',
    ]);
  });

  test('set, cleared, objects and redaction', () => {
    assert.equal(one({}, { email: 'r.kumar@example.com' }), 'Email set to "r.kumar@example.com"');
    assert.equal(one({ email: 'r.kumar@example.com' }, {}), 'Email cleared (was "r.kumar@example.com")');
    assert.equal(one({}, { address: { city: 'Chennai' } }), 'Address added');
    assert.equal(one({ address: { city: 'Chennai' } }, {}), 'Address removed');
    assert.equal(one({ address: { city: 'A' } }, { address: { city: 'B' } }), 'Address: City changed from "A" to "B"');
    assert.equal(one({ password: 'a' }, { password: 'b' }), 'Password changed');
    assert.equal(one({}, { password: 'b' }), 'Password set');
  });

  test('items, plain values and reorders', () => {
    assert.equal(one({}, { orders: [{ id: 'A3', product: 'Green dupatta' }] }), 'Order "Green dupatta" added to Orders');
    assert.equal(one({ tags: [] }, { tags: ['vip'] }), '"vip" added to Tags');
    assert.equal(one({ orders: [{ id: 'A' }, { id: 'B' }] }, { orders: [{ id: 'B' }, { id: 'A' }] }), 'Orders reordered');
  });

  test('a coded plain-value item is shown by its label, unquoted', () => {
    const s = jsonSchemaAdapter({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string', oneOf: [{ const: 'vip', title: 'VIP' }] } } } });
    assert.equal(describeChanges({}, { tags: ['vip'] }, s)[0]!.text, 'VIP added to Tags');
  });

  test('records, lists the schema does not describe, and truncation', () => {
    assert.deepEqual(texts(null, { name: 'R' }), ['Contact created']);
    assert.deepEqual(texts({ name: 'R' }, null), ['Contact deleted']);
    assert.equal(one({ extras: [1] }, { extras: [2] }), 'Extras changed');
    assert.deepEqual(texts({ name: 'a', phone: '1' }, { name: 'b', phone: '2' }, { maxChanges: 1 }), [
      'Name changed from "a" to "b"',
      'More changes not shown',
    ]);
  });

  test('a sensitive list says only what happened', () => {
    const s = jsonSchemaAdapter({
      type: 'object',
      properties: { cards: { type: 'array', 'x-sensitive': true, 'x-key': 'n', items: { type: 'object', title: 'Card', properties: { n: { type: 'string' } } } } },
    });
    assert.equal(describeChanges({}, { cards: [{ n: '4242' }] }, s)[0]!.text, 'Card added to Cards');
  });

  test('nested items get their parents first', () => {
    const s = jsonSchemaAdapter({
      type: 'object',
      properties: {
        colourways: {
          type: 'array',
          'x-key': 'code',
          'x-label': '{name}',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              name: { type: 'string' },
              sizes: { type: 'array', 'x-key': ['size', 'fit'], items: { type: 'object', title: 'Size', properties: { size: { type: 'string' }, fit: { type: 'string' } } } },
            },
          },
        },
      },
    });
    const b = { colourways: [{ code: 'RED', name: 'Red', sizes: [] }] };
    const a = { colourways: [{ code: 'RED', name: 'Red', sizes: [{ size: 'M', fit: 'Slim' }] }] };
    assert.equal(describeChanges(b, a, s)[0]!.text, 'Colourways › Red: Size "M, Slim" added to Sizes');
  });
});

suite('formatting', () => {
  const s = jsonSchemaAdapter({
    type: 'object',
    properties: {
      amount: { type: 'number' },
      active: { type: 'boolean' },
      launch: { type: 'string', format: 'date' },
      at: { type: 'string', format: 'date-time' },
      season: { type: 'string', enum: ['SS27', 'AW27'] },
      note: { type: 'string' },
    },
  });
  const d = (b: unknown, a: unknown, opts = {}) => describeChanges(b, a, s, { locale: 'en-IN', ...opts })[0]!.text;

  test('numbers use locale digits; numbers the schema does not describe are shown as written', () => {
    assert.equal(d({ amount: 1000 }, { amount: 125000 }), 'Amount changed from 1,000 to 1,25,000');
    assert.equal(d({ amount: 1 }, { amount: 1.23456 }), 'Amount changed from 1 to 1.23456');
    assert.equal(one({ legacyId: 1000 }, { legacyId: 125000 }), 'Legacy Id changed from 1000 to 125000');
  });

  test('booleans are Yes and No', () => {
    assert.equal(d({ active: false }, { active: true }), 'Active changed from No to Yes');
  });

  test('date-only values are never shifted by time zone', () => {
    for (const timeZone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      assert.equal(d({}, { launch: '2026-10-05' }, { timeZone }), 'Launch set to 5 Oct 2026');
    }
  });

  test('date-times are shown in the given time zone; UTC by default', () => {
    assert.equal(d({}, { at: '2026-10-05T10:00:00Z' }), 'At set to 5 Oct 2026, 10:00 am');
    assert.equal(d({}, { at: '2026-10-05T10:00:00Z' }, { timeZone: 'Asia/Kolkata' }), 'At set to 5 Oct 2026, 3:30 pm');
  });

  test('invalid dates, and date-times with no offset, are shown as written', () => {
    assert.equal(d({}, { launch: '2026-02-30' }), 'Launch set to "2026-02-30"');
    assert.equal(d({}, { at: '2026-10-05T10:00' }), 'At set to "2026-10-05T10:00"');
  });

  test('enum codes are not quoted', () => {
    assert.equal(d({ season: 'SS27' }, { season: 'AW27' }), 'Season changed from SS27 to AW27');
  });

  test('long values are cut at maxValueLength; the raw value stays whole', () => {
    const long = 'x'.repeat(100);
    const [sentence] = describeChanges({}, { note: long }, s, { maxValueLength: 10 });
    assert.equal(sentence!.text, 'Note set to "xxxxxxxxxx…"');
    assert.equal(sentence!.change.after, long);
  });
});

suite('parts', () => {
  test('split the sentence into field, value and text, with quotes outside values', () => {
    const [s] = describeChanges({ phone: '1' }, { phone: '2' }, adapter);
    assert.deepEqual(s!.parts, [
      { type: 'field', text: 'Phone' },
      { type: 'text', text: ' changed from "' },
      { type: 'value', text: '1' },
      { type: 'text', text: '" to "' },
      { type: 'value', text: '2' },
      { type: 'text', text: '"' },
    ]);
    assert.equal(s!.parts.map((p) => p.text).join(''), s!.text);
  });

  test('parents are a field part', () => {
    const s = describeChanges(specBefore, specAfter, adapter)[2]!;
    assert.deepEqual(s.parts.slice(0, 2), [{ type: 'field', text: 'Orders › Blue kurta' }, { type: 'text', text: ': ' }]);
  });
});

suite('messages', () => {
  test('a string template replaces the default for its code', () => {
    const [s] = describeChanges({ phone: '1' }, { phone: '2' }, adapter, { messages: { FIELD_CHANGED: '{field} updated: {before} → {after}' } });
    assert.equal(s!.text, 'Phone updated: "1" → "2"');
  });

  test('a custom template gets the parents first, unless it places {parents} itself', () => {
    const plain = { FIELD_CHANGED: '{field}: {before} → {after}' };
    assert.equal(describeChanges(specBefore, specAfter, adapter, { messages: plain })[2]!.text, 'Orders › Blue kurta: Quantity: 2 → 3');
    assert.equal(describeChanges(specBefore, specAfter, adapter, { messages: plain })[0]!.text, 'Phone: "98400 11111" → "98400 22222"');
    const placed = { FIELD_CHANGED: '{field} ({parents}): {before} → {after}' };
    assert.equal(describeChanges(specBefore, specAfter, adapter, { messages: placed })[2]!.text, 'Quantity (Orders › Blue kurta): 2 → 3');
  });

  test('a variant falls back to its code, then to English', () => {
    const fr = { FIELD_CHANGED: '{field} modifié', 'FIELD_CHANGED:redacted': '{field} modifié (masqué)' };
    assert.equal(describeChanges({ password: 'a' }, { password: 'b' }, adapter, { messages: fr })[0]!.text, 'Password modifié (masqué)');
    assert.equal(describeChanges({ extras: [1] }, { extras: [2] }, adapter, { messages: { FIELD_CHANGED: '{field} modifié' } })[0]!.text, 'Extras modifié');
  });

  test('a function template gets the change and formatted values', () => {
    const seen: Change[] = [];
    const [s] = describeChanges({}, { orders: [{ id: 'A', product: 'Kurta' }] }, adapter, {
      messages: {
        ITEM_ADDED: (change, v) => {
          seen.push(change);
          return `${v.itemNoun} ajoutée : ${v.item}`;
        },
      },
    });
    assert.equal(s!.text, 'Order ajoutée : Kurta');
    assert.deepEqual(s!.parts, [{ type: 'text', text: 'Order ajoutée : Kurta' }]);
    assert.equal(seen[0]!.code, 'ITEM_ADDED');
  });

  test('translateLabel translates titles and nouns', () => {
    const ta: Record<string, string> = { Phone: 'தொலைபேசி' };
    const [s] = describeChanges({ phone: '1' }, { phone: '2' }, adapter, { translateLabel: (l) => ta[l] ?? l });
    assert.equal(s!.text, 'தொலைபேசி changed from "1" to "2"');
  });

  test('translateLabel gets each label with its kind, and never an item name', () => {
    const seen: string[] = [];
    const translateLabel = (label: string, { kind }: { kind: string }) => {
      seen.push(`${kind}:${label}`);
      return label.toUpperCase();
    };
    const b = { orders: [{ id: 'A1', product: 'Rose', qty: 1 }, { id: 'A2', product: 'Rose', qty: 1 }] };
    const a = { orders: [{ id: 'A2', product: 'Rose', qty: 1 }, { id: 'A1', product: 'Rose', qty: 2 }, { id: 'A3', product: 'Rose' }] };
    const out = [
      ...describeChanges(b, a, adapter, { translateLabel }),
      ...describeChanges(null, { name: 'R' }, adapter, { translateLabel }),
    ].map((s) => s.text);
    assert.deepEqual(out, [
      'ORDERS › Rose: QUANTITY changed from 1 to 2',
      'ORDER "Rose" added to ORDERS',
      'ORDERS reordered',
      'CONTACT created',
    ]);
    assert.ok(seen.every((s) => !s.endsWith(':Rose')), seen.join(', '));
    assert.deepEqual([...new Set(seen)].sort(), ['field:Quantity', 'itemNoun:Order', 'list:Orders', 'record:Contact']);
  });
});

suite('stored changes', () => {
  test('describe needs no adapter, and a stored change reads the same after the schema changes', () => {
    const original = jsonSchemaAdapter(contactSchema);
    const stored: Change[] = JSON.parse(JSON.stringify(diffRecords(specBefore, specAfter, original)));
    const expected = describe(diffRecords(specBefore, specAfter, original), { locale: 'en-IN' }).map((s) => s.text);

    // Later: the app relabels the field and its values.
    const relabelled = jsonSchemaAdapter(contactSchema, { labels: { '/status': 'Stage', '/status=active': 'Customer' } });
    assert.notDeepEqual(describe(diffRecords(specBefore, specAfter, relabelled)).map((s) => s.text), expected);

    assert.deepEqual(describe(stored, { locale: 'en-IN' }).map((s) => s.text), expected);
  });
});
