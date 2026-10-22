// 1.2: labels in every language. Changes keep every language; describe picks one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, diffRecords, jsonSchemaAdapter, type Change } from '../../src/index.ts';

const de = {
  FIELD_CHANGED: '{field} von {before} zu {after} geändert',
  ITEM_ADDED: '{itemNoun} {item} zu {list} hinzugefügt',
  ITEM_MOVED: '{itemNoun} {item} von {from} nach {to} verschoben',
};
const ta = { FIELD_CHANGED: '{field}: {before} → {after}', ITEM_ADDED: '{list}: {itemNoun} {item} சேர்க்கப்பட்டது' };

const schema = {
  title: 'Contact',
  'x-title': { en: 'Contact', de: 'Kontakt', ta: 'தொடர்பு' },
  type: 'object',
  properties: {
    status: {
      title: 'Status',
      'x-title': { en: 'Status', de: 'Status', ta: 'நிலை' },
      type: 'object',
      'x-atomic': true,
      'x-key': '$key',
      'x-label': '@lang',
    },
    stage: {
      type: 'string',
      'x-title': { en: 'Stage', de: 'Phase' },
      oneOf: [
        { const: 'open', title: 'Open', 'x-title': { en: 'Open', de: 'Offen' } },
        { const: 'won', title: 'Won', 'x-title': { en: 'Won', de: 'Gewonnen' } },
      ],
    },
    orders: {
      title: 'Orders',
      'x-title': { en: 'Orders', de: 'Aufträge', ta: 'ஆர்டர்கள்' },
      'x-itemNoun': { en: 'Order', de: 'Auftrag', ta: 'ஆர்டர்' },
      type: 'array',
      'x-key': 'id',
      'x-label': '{product}',
      items: { type: 'object', properties: { id: { type: 'string' }, product: { type: 'string' }, qty: { type: 'integer', 'x-title': { en: 'Quantity', de: 'Menge' } } } },
    },
  },
};
const adapter = jsonSchemaAdapter(schema);
const lead = { $key: 'lead', en: 'Lead', de: 'Interessent', ta: 'முன்னணி' };
const active = { $key: 'active', en: 'Active', de: 'Aktiv', ta: 'செயலில்' };
const before = { status: lead, stage: 'open', orders: [{ id: 'A1', product: 'Blue kurta', qty: 2 }] };
const after = { status: active, stage: 'won', orders: [{ id: 'A1', product: 'Blue kurta', qty: 3 }, { id: 'A2', product: 'Red saree', qty: 1 }] };
// Stored once, described in three languages.
const stored: Change[] = JSON.parse(JSON.stringify(diffRecords(before, after, adapter)));

test('the same stored changes read in English, German and Tamil', () => {
  assert.deepEqual(describe(stored).map((s) => s.text), [
    'Status changed from Lead to Active',
    'Stage changed from Open to Won',
    'Orders › Blue kurta: Quantity changed from 2 to 3',
    'Order "Red saree" added to Orders',
  ]);
  assert.deepEqual(describe(stored, { locale: 'de-DE', messages: de }).map((s) => s.text), [
    'Status von Interessent zu Aktiv geändert',
    'Phase von Offen zu Gewonnen geändert',
    'Aufträge › Blue kurta: Menge von 2 zu 3 geändert',
    'Auftrag "Red saree" zu Aufträge hinzugefügt',
  ]);
  // Tamil has no map for Stage, its options or Quantity: they fall back to English.
  assert.deepEqual(describe(stored, { locale: 'ta-IN', messages: ta }).map((s) => s.text), [
    'நிலை: முன்னணி → செயலில்',
    'Stage: Open → Won',
    'ஆர்டர்கள் › Blue kurta: Quantity: 2 → 3',
    'ஆர்டர்கள்: ஆர்டர் "Red saree" சேர்க்கப்பட்டது',
  ]);
});

test('labels stay plain strings, in fallbackLanguage; the maps travel in display.i18n', () => {
  const [status, stage, qty, added] = stored;
  assert.deepEqual(status!.labels, ['Status']);
  assert.deepEqual(status!.display, {
    type: 'object',
    beforeLabel: 'Lead',
    afterLabel: 'Active',
    i18n: {
      labels: [{ en: 'Status', de: 'Status', ta: 'நிலை' }],
      beforeLabel: { en: 'Lead', de: 'Interessent', ta: 'முன்னணி' },
      afterLabel: { en: 'Active', de: 'Aktiv', ta: 'செயலில்' },
    },
  });
  assert.deepEqual(stage!.display.i18n, { labels: [{ en: 'Stage', de: 'Phase' }], beforeLabel: { en: 'Open', de: 'Offen' }, afterLabel: { en: 'Won', de: 'Gewonnen' } });
  // Item names are data: null in the i18n labels, never translated.
  assert.deepEqual(qty!.display.i18n!.labels, [{ en: 'Orders', de: 'Aufträge', ta: 'ஆர்டர்கள்' }, null, { en: 'Quantity', de: 'Menge' }]);
  assert.deepEqual(added!.display.i18n!.itemNoun, { en: 'Order', de: 'Auftrag', ta: 'ஆர்டர்' });
  // The diffRecords fallbackLanguage decides the stored strings.
  const german = diffRecords(before, after, adapter, { fallbackLanguage: 'de' });
  assert.deepEqual(german.map((c) => c.labels), [['Status'], ['Phase'], ['Aufträge', 'Blue kurta', 'Menge'], ['Aufträge', 'Red saree']]);
  assert.deepEqual([german[0]!.display.beforeLabel, german[3]!.display.itemNoun], ['Interessent', 'Auftrag']);
  assert.throws(() => diffRecords({}, {}, adapter, { fallbackLanguage: '' }), { code: 'INVALID_OPTION', path: 'fallbackLanguage' });
});

test('how describe picks: exact language, its base, fallbackLanguage, then the first language', () => {
  const map = { $key: 'x', fr: 'Bonjour', de: 'Hallo', 'de-CH': 'Grüezi', en: 'Hello' };
  const change: Change = {
    code: 'FIELD_SET',
    labels: ['Greeting'],
    after: 'x',
    display: { beforeLabel: undefined as never, afterLabel: 'Hello', i18n: { afterLabel: map } },
    inSchema: true,
  };
  delete (change.display as Record<string, unknown>)['beforeLabel'];
  const read = (options: object) => describe([change], options)[0]!.text;
  assert.equal(read({ language: 'de-CH' }), 'Greeting set to Grüezi');
  assert.equal(read({ language: 'de-AT' }), 'Greeting set to Hallo');
  assert.equal(read({ locale: 'de-CH' }), 'Greeting set to Hallo'); // the language part of locale
  assert.equal(read({ language: 'it' }), 'Greeting set to Hello');
  assert.equal(read({ language: 'it', fallbackLanguage: 'fr' }), 'Greeting set to Bonjour');
  const noEnglish = { ...change, display: { ...change.display, i18n: { afterLabel: { $key: 'x', fr: 'Bonjour', de: 'Hallo' } } } };
  assert.equal(describe([noEnglish], { language: 'it' })[0]!.text, 'Greeting set to Bonjour'); // first language; $key skipped
  assert.throws(() => describe([], { language: 'not a language!' }), { code: 'INVALID_OPTION', path: 'language' });
});

test("describe's fallbackLanguage applies only to maps; without an i18n block the stored labels are used as they are", () => {
  const german = diffRecords(before, after, adapter, { fallbackLanguage: 'de' });
  const plain = german.map(({ display: { i18n: _, ...display }, ...rest }) => ({ ...rest, display }));
  assert.deepEqual(describe(plain, { language: 'ta' }).map((s) => s.text)[0], 'Status changed from Interessent to Aktiv');
  assert.deepEqual(describe(german, { language: 'ta' }).map((s) => s.text)[0], 'நிலை changed from முன்னணி to செயலில்');
});

test('translateLabel is for labels without a map; mapped labels are already in the reader\'s language', () => {
  const seen: string[] = [];
  describe(stored, { language: 'de', translateLabel: (label) => (seen.push(label), label) });
  assert.deepEqual(seen, []);
  const a = jsonSchemaAdapter({ type: 'object', properties: { name: { type: 'string' } } });
  assert.deepEqual(describe(diffRecords({ name: 'a' }, { name: 'b' }, a), { translateLabel: () => 'Nom' }).map((s) => s.text), ['Nom changed from "a" to "b"']);
});

test('language maps in the labels file, for titles, item nouns, the record and value labels', () => {
  const a = jsonSchemaAdapter({ type: 'object', properties: { st: { type: 'string' }, lines: { type: 'array', 'x-key': 'id', items: { type: 'object', properties: { id: { type: 'string' } } } } } }, {
    labels: {
      '#record': { en: 'Customer', de: 'Kunde' },
      '/st': { en: 'Stage', de: 'Phase' },
      '/st=won': { en: 'Won', de: 'Gewonnen' },
      '/lines': { en: 'Lines', de: 'Positionen' },
      '/lines/*': { en: 'Line', de: 'Position' },
    },
    strictLabels: true,
  });
  const changes = diffRecords({ st: 'open', lines: [] }, { st: 'won', lines: [{ id: 'L1' }] }, a);
  assert.deepEqual(describe(changes, { language: 'de' }).map((s) => s.text), ['Phase changed from open to Gewonnen', 'Position "L1" added to Positionen']);
  assert.deepEqual(describe(diffRecords(null, {}, a), { language: 'de' }).map((s) => s.text), ['Kunde created']);
  assert.throws(() => jsonSchemaAdapter({ type: 'object' }, { labels: { '/a': { en: 1 } as never } }), { code: 'INVALID_SCHEMA', path: '/a' });
  const list = { type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } };
  assert.throws(() => jsonSchemaAdapter(list, { labels: { '/a#key': { en: 'id' } } }), { code: 'INVALID_SCHEMA', path: '/a#key' });
  assert.throws(() => jsonSchemaAdapter({ type: 'object', properties: { a: { 'x-title': 3 } } }), { code: 'INVALID_SCHEMA' });
});

test('x-label templates whose fields hold language maps give item names in every language', () => {
  const a = jsonSchemaAdapter({
    type: 'object',
    properties: {
      sizes: { type: 'array', title: 'Sizes', 'x-key': 'id', 'x-label': '{size} {fit}', items: { type: 'object', properties: { id: { type: 'string' }, size: { type: 'string' }, fit: { type: 'object' }, qty: { type: 'integer', title: 'Qty' } } } },
    },
  });
  const row = (qty: number) => ({ id: 'm', size: 'M', fit: { en: 'Regular', de: 'Normal' }, qty });
  const changes = diffRecords({ sizes: [row(1)] }, { sizes: [row(2)] }, a);
  assert.deepEqual(changes[0]!.labels, ['Sizes', 'M Regular', 'Qty']);
  assert.deepEqual(changes[0]!.display.i18n!.labels, [null, { en: 'M Regular', de: 'M Normal' }, null]);
  assert.deepEqual(describe(changes, { language: 'de' }).map((s) => s.text), ['Sizes › M Normal: Qty changed from 1 to 2']);
});

test('ITEM_MOVED reads its places in the reader\'s language', () => {
  const tree = jsonSchemaAdapter({
    type: 'object',
    properties: { parts: { $ref: '#/$defs/list' } },
    $defs: {
      list: { 'x-title': { en: 'Parts', de: 'Teile' }, 'x-itemNoun': { en: 'Part', de: 'Teil' }, type: 'array', 'x-key': 'id', 'x-key-scope': 'tree', items: { $ref: '#/$defs/part' } },
      part: { type: 'object', properties: { id: { type: 'string' }, parts: { $ref: '#/$defs/list' } } },
    },
  });
  const changes = diffRecords({ parts: [{ id: 'Cuff' }, { id: 'Body' }] }, { parts: [{ id: 'Body', parts: [{ id: 'Cuff' }] }] }, tree);
  assert.deepEqual(describe(changes, { messages: de, language: 'de' }).map((s) => s.text), ['Teil "Cuff" von Teile nach Body verschoben']);
  assert.deepEqual(describe(changes).map((s) => s.text), ['Part "Cuff" moved from Parts to Body']);
});
