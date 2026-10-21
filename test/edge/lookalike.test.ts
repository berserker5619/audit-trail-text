// Edge cases 5-9: values that look the same.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRecords } from '../../src/index.ts';
import { describeChanges, jsonSchemaAdapter } from '../../src/index.ts';
import { DECISION, schema, sentences } from './helpers.ts';

const text = schema({ v: { type: 'string', title: 'V' } });

test('5. a leading or trailing space is a change, and shows inside the quotes', () => {
  assert.deepEqual(sentences(text, { v: 'Rose' }, { v: 'Rose ' }), ['V changed from "Rose" to "Rose "']);
  assert.deepEqual(sentences(text, { v: 'Rose' }, { v: ' Rose' }), ['V changed from "Rose" to " Rose"']);
});

test('5b. a tab versus a space is a change, and the tab shows as ⇥', () => {
  assert.deepEqual(sentences(text, { v: 'a b' }, { v: 'a\tb' }), ['V changed from "a b" to "a⇥b"']);
  // Other control characters show as their control pictures; the raw value is kept.
  assert.deepEqual(sentences(text, { v: 'a' }, { v: 'a\u0000\u001b\u007f\u0085' }), ['V changed from "a" to "a␀␛␡\ufffd"']);
  assert.equal(describeChanges({ v: 'a' }, { v: 'a\tb' }, text)[0]!.change.after, 'a\tb');
});

test('5c. a value of only spaces is not empty (documented as intended)', () => {
  assert.deepEqual(diffRecords({ v: '' }, { v: ' ' }, text).map((c) => c.code), ['FIELD_SET']);
  assert.deepEqual(sentences(text, { v: '' }, { v: ' ' }), ['V set to " "']);
});

test('6. "é" as NFC and as NFD is a change, and the sentence says the Unicode form changed', () => {
  const nfc = 'caf\u00e9';
  const nfd = 'cafe\u0301';
  assert.equal(nfc.normalize('NFC'), nfd.normalize('NFC'));
  assert.deepEqual(diffRecords({ v: nfc }, { v: nfd }, text).map((c) => c.code), ['FIELD_CHANGED']);
  assert.deepEqual(sentences(text, { v: nfc }, { v: nfd }), [`V changed from "${nfc}" to "${nfd}" (Unicode form changed)`]);
  // Only when the two sides are equal after NFC.
  assert.deepEqual(sentences(text, { v: nfc }, { v: 'cafe' }), [`V changed from "${nfc}" to "cafe"`]);
  // It has its own message key, falling back to FIELD_CHANGED.
  const fr = describeChanges({ v: nfc }, { v: nfd }, text, { messages: { 'FIELD_CHANGED:unicode': '{field} : forme Unicode modifiée' } });
  assert.equal(fr[0]!.text, 'V : forme Unicode modifiée');
  const custom = describeChanges({ v: nfc }, { v: nfd }, text, { messages: { FIELD_CHANGED: '{field}: {before} → {after}' } });
  assert.equal(custom[0]!.text, `V: "${nfc}" → "${nfd}"`);
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

test('7. the same instant written with different offsets is a change, and the sentence shows the offsets', () => {
  const before = { at: '2026-10-05T10:00:00+05:30' };
  const after = { at: '2026-10-05T04:30:00Z' };
  assert.equal(Date.parse(before.at), Date.parse(after.at));
  assert.deepEqual(diffRecords(before, after, dates).map((c) => c.code), ['FIELD_CHANGED']);
  assert.deepEqual(sentences(dates, before, after, { locale: 'en-IN', timeZone: 'Asia/Kolkata' }), [
    'At changed from 5 Oct 2026, 10:00 am (+05:30) to 5 Oct 2026, 10:00 am (+00:00)',
  ]);
  assert.deepEqual(sentences(dates, { at: '2026-10-05T10:00:00+0530' }, after, { locale: 'en-IN', timeZone: 'Asia/Kolkata' }), [
    'At changed from 5 Oct 2026, 10:00 am (+05:30) to 5 Oct 2026, 10:00 am (+00:00)',
  ]);
});

test('7b. date-times that differ only below a minute, or in precision, are shown as written', () => {
  assert.deepEqual(sentences(dates, { at: '2026-10-05T10:00:00Z' }, { at: '2026-10-05T10:00:30Z' }, { locale: 'en-IN' }), [
    'At changed from "2026-10-05T10:00:00Z" to "2026-10-05T10:00:30Z"',
  ]);
  assert.deepEqual(sentences(dates, { at: '2026-10-05T10:00:00Z' }, { at: '2026-10-05T10:00:00.000Z' }, { locale: 'en-IN' }), [
    'At changed from "2026-10-05T10:00:00Z" to "2026-10-05T10:00:00.000Z"',
  ]);
  // Different minutes format differently, so they read as usual.
  assert.deepEqual(sentences(dates, { at: '2026-10-05T10:00:00Z' }, { at: '2026-10-05T10:05:00Z' }, { locale: 'en-IN' }), [
    'At changed from 5 Oct 2026, 10:00 am to 5 Oct 2026, 10:05 am',
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

test('9c. integers above 2^53 print as the number stored', () => {
  const before = 2 ** 60;
  const after = 2 ** 60 + 2 ** 10;
  // String(2 ** 60) is "1152921504606846976"; Intl rounds it to 17 significant digits.
  assert.deepEqual(sentences(nums, { n: before }, { n: after }), [
    'N changed from 1,152,921,504,606,846,976 to 1,152,921,504,606,848,000',
  ]);
  assert.deepEqual(sentences(nums, { n: 1e21 }, { n: -1e21 }, { locale: 'en-IN' }), [
    'N changed from 1,00,00,00,00,00,00,00,00,00,000 to -1,00,00,00,00,00,00,00,00,00,000',
  ]);
  // Fractions and safe integers are unchanged.
  assert.deepEqual(sentences(nums, { n: 1.5 }, { n: 2 ** 53 - 1 }), ['N changed from 1.5 to 9,007,199,254,740,991']);
});

test('9d. 1 versus "1" and true versus "true" are changes, and the quotes show which is text', () => {
  assert.deepEqual(sentences(nums, { n: 1 }, { n: '1' }), ['N changed from 1 to "1"']);
  assert.deepEqual(sentences(nums, { b: true }, { b: 'true' }), ['B changed from Yes to "true"']);
});
