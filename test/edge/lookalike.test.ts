// Edge cases 5-9: values that look the same.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRecords } from '../../src/index.ts';
import { DECISION, schema, sentences, WRONG } from './helpers.ts';

const text = schema({ v: { type: 'string', title: 'V' } });

test('5. a leading or trailing space is a change, and shows inside the quotes', () => {
  assert.deepEqual(sentences(text, { v: 'Rose' }, { v: 'Rose ' }), ['V changed from "Rose" to "Rose "']);
  assert.deepEqual(sentences(text, { v: 'Rose' }, { v: ' Rose' }), ['V changed from "Rose" to " Rose"']);
});

test(`5b. ${DECISION} a tab versus a space is a change, but the sentence shows no visible difference`, () => {
  assert.deepEqual(sentences(text, { v: 'a b' }, { v: 'a\tb' }), ['V changed from "a b" to "a\tb"']);
});

test(`5c. ${DECISION} a value of only spaces is not empty`, () => {
  assert.deepEqual(diffRecords({ v: '' }, { v: ' ' }, text).map((c) => c.code), ['FIELD_SET']);
  assert.deepEqual(sentences(text, { v: '' }, { v: ' ' }), ['V set to " "']);
});

test(`6. ${DECISION} "é" as NFC and as NFD is a change, and both sides print the same`, () => {
  const nfc = 'café';
  const nfd = 'café';
  assert.equal(nfc.normalize('NFC'), nfd.normalize('NFC'));
  assert.deepEqual(diffRecords({ v: nfc }, { v: nfd }, text).map((c) => c.code), ['FIELD_CHANGED']);
  assert.deepEqual(sentences(text, { v: nfc }, { v: nfd }), [`V changed from "${nfc}" to "${nfd}"`]);
});

test('6b. emoji, Tamil and right-to-left text are compared and printed exactly', () => {
  assert.deepEqual(sentences(text, { v: '🌹' }, { v: '🌹🌹' }), ['V changed from "🌹" to "🌹🌹"']);
  assert.deepEqual(sentences(text, { v: 'ரோஜா' }, { v: 'தாமரை' }), ['V changed from "ரோஜா" to "தாமரை"']);
  assert.deepEqual(sentences(text, { v: 'שלום' }, { v: 'مرحبا' }), ['V changed from "שלום" to "مرحبا"']);
  assert.deepEqual(diffRecords({ v: 'ரோஜா' }, { v: 'ரோஜா' }, text), []);
});

test(`6c. ${DECISION} right-to-left values are not wrapped in direction isolates`, () => {
  const [s] = sentences(text, { v: 'a' }, { v: 'مرحبا 123' });
  assert.ok(!/[⁦-⁩]/.test(s!));
});

const dates = schema({ at: { type: 'string', format: 'date-time', title: 'At' }, d: { type: 'string', format: 'date', title: 'D' } });

test(`7. ${DECISION} the same instant written with different offsets is a change that prints identically`, () => {
  const before = { at: '2026-10-05T10:00:00+05:30' };
  const after = { at: '2026-10-05T04:30:00Z' };
  assert.equal(Date.parse(before.at), Date.parse(after.at));
  assert.deepEqual(diffRecords(before, after, dates).map((c) => c.code), ['FIELD_CHANGED']);
  assert.deepEqual(sentences(dates, before, after, { locale: 'en-IN', timeZone: 'Asia/Kolkata' }), [
    'At changed from 5 Oct 2026, 10:00 am to 5 Oct 2026, 10:00 am',
  ]);
});

test('8. invalid dates under format: date are shown as written, quoted', () => {
  assert.deepEqual(sentences(dates, {}, { d: '2026-02-30' }, { locale: 'en-IN' }), ['D set to "2026-02-30"']);
  assert.deepEqual(sentences(dates, {}, { d: '05/10/2026' }, { locale: 'en-IN' }), ['D set to "05/10/2026"']);
  assert.deepEqual(sentences(dates, {}, { d: '2026-10-05' }, { locale: 'en-IN' }), ['D set to 5 Oct 2026']);
});

const nums = schema({ n: { type: 'number', title: 'N' }, b: { type: 'boolean', title: 'B' } });

test('9. 0.1 + 0.2 versus 0.3 is a change, printed with every digit', () => {
  assert.deepEqual(sentences(nums, { n: 0.1 + 0.2 }, { n: 0.3 }), ['N changed from 0.30000000000000004 to 0.3']);
});

test('9b. integers above 2^53 that parse to the same number are no change', () => {
  const before = JSON.parse('{"n": 9007199254740993}');
  const after = JSON.parse('{"n": 9007199254740992}');
  assert.deepEqual(diffRecords(before, after, nums), []);
});

test('9c. integers above 2^53 print as the number stored', WRONG, () => {
  const before = 2 ** 60;
  const after = 2 ** 60 + 2 ** 10;
  // String(2 ** 60) is "1152921504606846976"; Intl rounds it to 17 significant digits.
  assert.deepEqual(sentences(nums, { n: before }, { n: after }), [
    'N changed from 1,152,921,504,606,846,976 to 1,152,921,504,606,848,000',
  ]);
});

test('9d. 1 versus "1" and true versus "true" are changes, and the quotes show which is text', () => {
  assert.deepEqual(sentences(nums, { n: 1 }, { n: '1' }), ['N changed from 1 to "1"']);
  assert.deepEqual(sentences(nums, { b: true }, { b: 'true' }), ['B changed from Yes to "true"']);
});
