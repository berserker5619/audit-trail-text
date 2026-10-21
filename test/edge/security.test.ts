// Edge cases 1-4: security and safety.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { describe, describeChanges, diffRecords, jsonSchemaAdapter } from '../../src/index.ts';
import { DECISION, schema, sentences, WRONG } from './helpers.ts';

const text = schema({ v: { type: 'string', title: 'V' } });

test('1. values containing template tokens print literally', () => {
  assert.deepEqual(sentences(text, { v: '{after}' }, { v: '{field} {parents} {before}' }), [
    'V changed from "{after}" to "{field} {parents} {before}"',
  ]);
  const list = schema({
    o: { type: 'array', 'x-key': 'id', 'x-label': '{name}', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
  });
  // A value inside an item label template isn't expanded again.
  assert.deepEqual(sentences(list, {}, { o: [{ id: 'a', name: '{id} {after}' }] }), ['Item "{id} {after}" added to O']);
  // A template token inside a custom message's value isn't expanded either.
  const [s] = describeChanges({ v: 'x' }, { v: '{field}' }, text, { messages: { FIELD_CHANGED: '{after}!' } });
  assert.equal(s!.text, '"{field}"!');
});

test('2. __proto__, constructor, prototype and hasOwnProperty as field names: reported, no pollution', () => {
  const names = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty'];
  const props = Object.fromEntries(names.map((n) => [n, { type: 'string' }]));
  // JSON.parse makes "__proto__" an own key, as a schema or record read from JSON would have.
  const s = jsonSchemaAdapter(JSON.parse(JSON.stringify({ type: 'object', properties: props })), {
    labels: JSON.parse('{"/__proto__": "Proto", "/constructor": "Ctor", "__proto__": "ignored", "/prototype=x": "Ex"}'),
  });
  assert.deepEqual([...s.root.properties.keys()].sort(), [...names].sort());
  const before = JSON.parse('{"__proto__": "a", "constructor": "a", "prototype": "a", "hasOwnProperty": "a"}');
  const after = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "b", "prototype": "x", "hasOwnProperty": "b"}');
  const changes = diffRecords(before, after, s);
  assert.deepEqual(changes.map((c) => c.labels[0]), ['Proto', 'Ctor', 'Prototype', 'Has Own Property']);
  assert.deepEqual(Object.getOwnPropertyNames(changes[0]!.after as object), ['polluted']);
  assert.equal(Object.getPrototypeOf(changes[0]!.after), Object.prototype);
  assert.equal(changes[2]!.display.afterLabel, 'Ex');
  // Whole values carrying those keys are copied as data, not as prototypes.
  const created = diffRecords(null, after, s)[0]!.after as Record<string, unknown>;
  assert.ok(Object.hasOwn(created, '__proto__'));
  assert.equal(Object.getPrototypeOf(created), Object.prototype);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
});

test('2b. a record with no schema for those names still reports them, labelled from the key', () => {
  const free = jsonSchemaAdapter({ type: 'object' });
  const changes = diffRecords(JSON.parse('{"__proto__": {"a": 1}, "constructor": 1}'), JSON.parse('{"__proto__": {"a": 2}, "constructor": 2}'), free);
  // Fields the schema doesn't describe come in key order: "__proto__" sorts before "constructor".
  assert.deepEqual(changes.map((c) => c.labels), [['Proto', 'A'], ['Constructor']]);
  assert.equal(({} as Record<string, unknown>)['a'], undefined);
});

test('3. HTML and newlines are kept as plain text in parts', () => {
  const [s] = describeChanges({ v: 'a' }, { v: '<script>alert(1)</script>' }, text);
  assert.deepEqual(s!.parts.find((p) => p.type === 'value' && p.text.includes('<')), { type: 'value', text: '<script>alert(1)</script>' });
  assert.ok(s!.parts.every((p) => typeof p.text === 'string' && Object.keys(p).sort().join() === 'text,type'));
});

test('3b. the README tells apps to escape parts when rendering HTML', WRONG, () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /escape/i);
});

test(`3c. ${DECISION} a newline in a value is printed as is, so a sentence can span lines`, () => {
  assert.deepEqual(sentences(text, { v: 'a' }, { v: 'line 1\nline 2' }), ['V changed from "a" to "line 1\nline 2"']);
});

test('4. inputs are not mutated, and frozen inputs work', () => {
  const deepFreeze = <T>(v: T): T => {
    if (v && typeof v === 'object') {
      Object.values(v).forEach(deepFreeze);
      Object.freeze(v);
    }
    return v;
  };
  const listSchema = deepFreeze({
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' } },
      o: { type: 'array', 'x-key': 'id', items: { type: 'object', properties: { id: { type: 'string' }, secret: { type: 'string', writeOnly: true } } } },
    },
  });
  const labels = deepFreeze({ '/tags': 'Tags' });
  const before = deepFreeze({ tags: ['x'], o: [{ id: 'a', secret: 's' }], extra: { n: -0 } });
  const after = deepFreeze({ tags: ['y'], o: [{ id: 'b', secret: 't' }], extra: { n: 1 } });
  const copy = structuredClone({ before, after });
  const changes = diffRecords(before, after, jsonSchemaAdapter(listSchema, { labels }), { ignore: ['/o/*/id'] });
  assert.ok(changes.length > 0);
  describe(changes);
  assert.deepEqual({ before, after }, copy);
  // The returned changes are new objects, not the frozen inputs.
  assert.ok(changes.every((c) => !Object.isFrozen(c)));
});
