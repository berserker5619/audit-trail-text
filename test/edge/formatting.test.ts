// Edge cases 17-18: formatting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, diffRecords } from '../../src/index.ts';
import { DECISION, schema, sentences, WRONG } from './helpers.ts';

const text = schema({ v: { type: 'string', title: 'V' } });
const changes = diffRecords({ v: 'a' }, { v: 'b' }, text);

test(`17. ${DECISION} an invalid locale throws a raw RangeError, not a DiffError`, () => {
  assert.throws(() => describe(changes, { locale: 'not a locale!' }), (e: unknown) => e instanceof RangeError && !('code' in (e as object)));
});

test(`17b. ${DECISION} an invalid timeZone throws a raw RangeError, even when no change needs it`, () => {
  assert.throws(() => describe(changes, { timeZone: 'Mars/Base' }), RangeError);
  assert.throws(() => describe([], { timeZone: 'Mars/Base' }), RangeError);
});

test('17c. locales Intl accepts but has no data for fall back without an error', () => {
  assert.doesNotThrow(() => describe(changes, { locale: 'xx-YY' }));
});

const cut = (value: string, maxValueLength: number) => sentences(text, {}, { v: value }, { maxValueLength })[0]!;

test('18. long values are cut at maxValueLength with "…", never splitting a surrogate pair', () => {
  assert.equal(cut('x'.repeat(100), 10), `V set to "${'x'.repeat(10)}…"`);
  assert.equal(cut('🌹'.repeat(5), 2), 'V set to "🌹🌹…"');
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut('🌹'.repeat(5), 3)));
});

test('18b. a cut never splits an emoji sequence, a flag or a Tamil letter', WRONG, () => {
  const family = '👨‍👩‍👧‍👦';
  assert.equal(cut(family.repeat(3), 1), `V set to "${family}…"`);
  assert.equal(cut('🇮🇳🇮🇳🇮🇳', 1), 'V set to "🇮🇳…"');
  // "தமிழ்நாடு" is 5 letters (grapheme clusters) but 9 code points.
  assert.equal(cut('தமிழ்நாடு', 3), 'V set to "தமிழ்…"');
});

test('18c. multi-byte values shorter than the limit are left whole', () => {
  assert.equal(cut('தமிழ்நாடு', 80), 'V set to "தமிழ்நாடு"');
});
