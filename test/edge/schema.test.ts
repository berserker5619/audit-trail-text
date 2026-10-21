// Edge cases 14-16: schema shapes and record shapes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRecords, jsonSchemaAdapter } from '../../src/index.ts';
import { DECISION, schema, sentences } from './helpers.ts';

test(`14. ${DECISION} additionalProperties maps: entries are reported as fields the schema doesn't describe`, () => {
  const s = schema({ name: { type: 'object', title: 'Name', additionalProperties: { type: 'string', title: 'Translation' } } });
  const changes = diffRecords({ name: { en: 'Rose' } }, { name: { en: 'Rose', ta: 'ரோஜா' } }, s);
  assert.deepEqual(changes.map((c) => [c.code, c.labels, c.inSchema, c.display]), [['FIELD_SET', ['Name', 'Ta'], false, {}]]);
});

test(`14b. ${DECISION} patternProperties are ignored the same way`, () => {
  const s = schema({ sizes: { type: 'object', patternProperties: { '^[A-Z]+$': { type: 'integer', title: 'Units' } } } });
  const [c] = diffRecords({ sizes: { M: 1 } }, { sizes: { M: 1000 } }, s);
  assert.deepEqual([c!.labels, c!.inSchema], [['Sizes', 'M'], false]);
  assert.deepEqual(sentences(s, { sizes: { M: 1 } }, { sizes: { M: 1000 } }), ['Sizes: M changed from 1 to 1000']);
});

test(`14c. ${DECISION} allOf is ignored: an object described only through allOf is compared as one value`, () => {
  const s = schema({ addr: { title: 'Address', allOf: [{ type: 'object', properties: { city: { type: 'string', title: 'City' } } }] } });
  const changes = diffRecords({ addr: { city: 'A' } }, { addr: { city: 'B' } }, s);
  assert.deepEqual(changes.map((c) => [c.code, c.labels]), [['FIELD_CHANGED', ['Address']]]);
  assert.deepEqual(sentences(s, { addr: { city: 'A' } }, { addr: { city: 'B' } }), ['Address changed']);
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

test(`15. ${DECISION} a labels file entry for a path that doesn't exist is silently ignored`, () => {
  const labels = { '/phnoe': 'Mobile', '/orders#key': 'id', '/status=actvie': 'Active' };
  const a = jsonSchemaAdapter({ type: 'object', properties: { phone: { type: 'string' }, status: { type: 'string', enum: ['active'] } } }, { labels });
  assert.equal(a.root.properties.get('phone')!.title, 'Phone');
  assert.deepEqual(sentences(a, { phone: '1' }, { phone: '2' }), ['Phone changed from "1" to "2"']);
});

test(`16. ${DECISION} a top-level array as the record throws NOT_JSON`, () => {
  const s = schema({});
  assert.throws(() => diffRecords([], [1], s), { code: 'NOT_JSON', side: 'before', message: /plain object or null/ });
  assert.throws(() => diffRecords({}, 'text', s), { code: 'NOT_JSON', side: 'after' });
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
