// 1.3: format "decimal", an exact number stored as text, shown as a number with every digit kept.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, describeChanges, diffRecords, jsonSchemaAdapter } from '../../src/index.ts';

const adapter = jsonSchemaAdapter({ type: 'object', properties: { price: { type: 'string', title: 'Price', format: 'decimal' } } });
const text = (before: unknown, after: unknown, locale = 'en') => describeChanges({ price: before }, { price: after }, adapter, { locale })[0]!.text;

test('a decimal prints as a number, unquoted, keeping its digits', () => {
  assert.equal(text('12.00', '12.50'), 'Price changed from 12.00 to 12.50');
  assert.equal(text('1234567.50', '-0.05'), 'Price changed from 1,234,567.50 to -0.05');
  assert.equal(text('1234567.50', '1234567.5', 'en-IN'), 'Price changed from 12,34,567.50 to 12,34,567.5');
  assert.equal(text('1234.5', '99999999999999999999.99', 'de'), 'Price changed from 1.234,5 to 99.999.999.999.999.999.999,99');
});

test('exponents as Decimal128 writes them, and -0 without its sign', () => {
  assert.equal(text('1.5E+3', '12E-4'), 'Price changed from 1,500 to 0.0012');
  assert.equal(text('1E+2', '-0.00'), 'Price changed from 100 to 0.00');
});

test('text that isn\'t a number is shown as written, quoted', () => {
  assert.equal(text('NaN', 'Infinity'), 'Price changed from "NaN" to "Infinity"');
  assert.equal(text('12,50', '1E+999'), 'Price changed from "12,50" to "1E+999"');
});

test('the format is stored in display, so a stored change reads the same later', () => {
  const [change] = diffRecords({ price: '1' }, { price: '2' }, adapter);
  assert.deepEqual(change!.display, { type: 'string', format: 'decimal' });
  assert.equal(describe([JSON.parse(JSON.stringify(change))])[0]!.text, 'Price changed from 1 to 2');
});
