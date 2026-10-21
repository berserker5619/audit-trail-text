// Edge cases 14-16: schema shapes and record shapes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRecords, jsonSchemaAdapter } from '../../src/index.ts';
import { schema, sentences } from './helpers.ts';

test('14. additionalProperties maps: each entry uses the value schema, labelled with its key (#3)', () => {
  const s = schema({ name: { type: 'object', title: 'Name', additionalProperties: { type: 'string', title: 'Translation' } } });
  const changes = diffRecords({ name: { en: 'Rose' } }, { name: { en: 'Rose', ta: 'ரோஜா' } }, s);
  assert.deepEqual(changes.map((c) => [c.code, c.labels, c.inSchema, c.schemaPath, c.display]), [
    ['FIELD_SET', ['Name', 'ta'], true, '/properties/name/additionalProperties', { type: 'string' }],
  ]);
  assert.deepEqual(sentences(s, { name: { en: 'Rose' } }, { name: { en: 'Rosa' } }), ['Name: en changed from "Rose" to "Rosa"']);
  // Sensitive map values are redacted and stripped like any other field.
  const secrets = schema({ keys: { type: 'object', additionalProperties: { type: 'string', writeOnly: true } } });
  const [c] = diffRecords({ keys: { a: '1' } }, { keys: { a: '2' } }, secrets);
  assert.equal(c!.redacted, true);
  assert.deepEqual(diffRecords(null, { keys: { a: '1' } }, secrets)[0]!.after, { keys: {} });
  // Declared properties still win over the map.
  const mixed = schema({ m: { type: 'object', properties: { id: { type: 'string', title: 'ID' } }, additionalProperties: { type: 'integer' } } });
  assert.deepEqual(diffRecords({ m: { id: 'a', x: 1 } }, { m: { id: 'b', x: 2 } }, mixed).map((c) => c.labels), [['M', 'ID'], ['M', 'x']]);
});

test('14b. patternProperties: a key takes the first matching pattern, before additionalProperties (#4)', () => {
  const s = schema({
    sizes: { type: 'object', patternProperties: { '^[A-Z]+$': { type: 'integer', title: 'Units' } }, additionalProperties: { type: 'string' } },
  });
  const [c] = diffRecords({ sizes: { M: 1 } }, { sizes: { M: 1000 } }, s);
  assert.deepEqual([c!.labels, c!.inSchema, c!.schemaPath], [['Sizes', 'M'], true, '/properties/sizes/patternProperties/^[A-Z]+$']);
  assert.deepEqual(sentences(s, { sizes: { M: 1 } }, { sizes: { M: 1000 } }, { locale: 'en-IN' }), ['Sizes: M changed from 1 to 1,000']);
  assert.equal(diffRecords({ sizes: { note: 'a' } }, { sizes: { note: 'b' } }, s)[0]!.schemaPath, '/properties/sizes/additionalProperties');
  assert.throws(() => schema({ x: { type: 'object', patternProperties: { '(': {} } } }), { code: 'INVALID_SCHEMA' });
});

test('14c. allOf entries are merged, so their fields are walked and titled (#5)', () => {
  const s = jsonSchemaAdapter({
    type: 'object',
    properties: {
      addr: { title: 'Address', allOf: [{ $ref: '#/$defs/place' }, { properties: { pin: { type: 'string', title: 'PIN' }, city: { title: 'Ignored' } } }] },
    },
    $defs: { place: { type: 'object', properties: { city: { type: 'string', title: 'City' } } } },
  });
  const changes = diffRecords({ addr: { city: 'A', pin: '1' } }, { addr: { city: 'B', pin: '2' } }, s);
  assert.deepEqual(changes.map((c) => [c.code, c.labels, c.schemaPath]), [
    ['FIELD_CHANGED', ['Address', 'City'], '/properties/addr/properties/city'],
    ['FIELD_CHANGED', ['Address', 'PIN'], '/properties/addr/properties/pin'],
  ]);
  // Keywords on the field itself win over allOf entries; nested allOf is merged too.
  const nested = schema({ n: { title: 'Own', allOf: [{ title: 'Entry', allOf: [{ type: 'integer' }] }] } });
  assert.deepEqual(diffRecords({ n: 1 }, { n: 2 }, nested)[0]!.labels, ['Own']);
  assert.equal(diffRecords({ n: 1 }, { n: 2 }, nested)[0]!.display.type, 'integer');
  assert.throws(() => schema({ x: { allOf: {} } }), { code: 'INVALID_SCHEMA' });
});

test('14d. anyOf is ignored; the value is compared and shown as written', () => {
  const s = schema({ a: { title: 'A', anyOf: [{ type: 'string' }, { type: 'number' }] } });
  assert.deepEqual(sentences(s, { a: '1' }, { a: 2 }), ['A changed from "1" to 2']);
});

test('14e. type: ["string", "null"] reads as a string, and null is empty', () => {
  const s = schema({ n: { type: ['string', 'null'], title: 'Nickname' }, c: { type: ['null', 'integer'], title: 'Count' } });
  assert.deepEqual(diffRecords({ n: null }, { n: 'Raj', c: 1500 }, s).map((c) => [c.code, c.display.type]), [
    ['FIELD_SET', 'string'],
    ['FIELD_SET', 'integer'],
  ]);
  assert.deepEqual(sentences(s, { n: 'Raj', c: null }, { n: null, c: 1500 }, { locale: 'en-IN' }), ['Nickname cleared (was "Raj")', 'Count set to 1,500']);
});

test('15. labels file entries that match no field are listed in unusedLabels, and refused with strictLabels (#6)', () => {
  const labels = { '/phnoe': 'Mobile', '/phone': 'Phone no.', '/orders#key': 'id', '/status=active': 'Active', '/stauts=x': 'X', '#record': 'Lead' };
  const props = { phone: { type: 'string' }, status: { type: 'string', enum: ['active'] } };
  const a = jsonSchemaAdapter({ type: 'object', properties: props }, { labels });
  assert.deepEqual(a.unusedLabels, ['/phnoe', '/orders#key', '/stauts=x']);
  assert.equal(a.root.properties.get('phone')!.title, 'Phone no.');
  assert.throws(() => jsonSchemaAdapter({ type: 'object', properties: props }, { labels, strictLabels: true }), {
    code: 'UNKNOWN_LABEL',
    path: '/phnoe',
    message: /\/phnoe, \/orders#key, \/stauts=x/,
  });
  assert.deepEqual(jsonSchemaAdapter({ type: 'object', properties: props }, { labels: { '/phone': 'P' }, strictLabels: true }).unusedLabels, []);
});

test('16. a record that is not an object throws INVALID_RECORD (#7)', () => {
  const s = schema({});
  assert.throws(() => diffRecords([], [1], s), { code: 'INVALID_RECORD', side: 'before', message: /plain object or null/ });
  assert.throws(() => diffRecords({}, 'text', s), { code: 'INVALID_RECORD', side: 'after' });
  // NOT_JSON stays for values JSON can't represent.
  assert.throws(() => diffRecords({ d: new Date() }, {}, s), { code: 'NOT_JSON' });
});

test('16b. both sides null gives no changes', () => {
  assert.deepEqual(diffRecords(null, null, schema({})), []);
  assert.deepEqual(diffRecords(undefined, null, schema({})), []);
});

test('16c. a record nested exactly maxDepth deep is fine; one level more throws TOO_DEEP', () => {
  // The record itself is depth 1; each nested object or array adds one.
  const nest = (levels: number): Record<string, unknown> => (levels <= 1 ? { leaf: 'x' } : { x: nest(levels - 1) });
  const s = schema({});
  for (const maxDepth of [1, 3, 32]) {
    assert.doesNotThrow(() => diffRecords(nest(maxDepth), nest(maxDepth), s, { maxDepth }), `maxDepth ${maxDepth}`);
    assert.throws(() => diffRecords(nest(maxDepth + 1), {}, s, { maxDepth }), { code: 'TOO_DEEP' }, `maxDepth ${maxDepth} + 1`);
  }
  assert.doesNotThrow(() => diffRecords(nest(32), {}, s));
  assert.throws(() => diffRecords(nest(33), {}, s), { code: 'TOO_DEEP', path: '/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x' });
});
