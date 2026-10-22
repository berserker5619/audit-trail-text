#!/usr/bin/env node
// Runs the spec's example against the built package. Used on the oldest supported Node.
import assert from 'node:assert/strict';
import { describeChanges, jsonSchemaAdapter } from '../dist/index.js';

const schema = {
  title: 'Contact',
  type: 'object',
  properties: {
    phone: { type: 'string', title: 'Phone' },
    status: { type: 'string', title: 'Status', oneOf: [{ const: 'lead', title: 'Lead' }, { const: 'active', title: 'Active customer' }] },
    orders: {
      type: 'array', title: 'Orders', 'x-key': 'id', 'x-label': '{product}',
      items: { type: 'object', title: 'Order', properties: { id: { type: 'string' }, product: { type: 'string' }, qty: { type: 'integer', title: 'Quantity' } } },
    },
  },
};
const before = { phone: '98400 11111', status: 'lead', orders: [{ id: 'A1', product: 'Blue kurta', qty: 2 }, { id: 'A2', product: 'Red saree', qty: 1 }] };
const after = { phone: '98400 22222', status: 'active', orders: [{ id: 'A1', product: 'Blue kurta', qty: 3 }] };

assert.deepEqual(describeChanges(before, after, jsonSchemaAdapter(schema), { locale: 'en-IN' }).map((s) => s.text), [
  'Phone changed from "98400 11111" to "98400 22222"',
  'Status changed from Lead to Active customer',
  'Orders \u203a Blue kurta: Quantity changed from 2 to 3',
  'Order "Red saree" removed from Orders',
]);

// 1.2: a recursive schema, a move across parents, an atomic option and a language map.
const style = {
  type: 'object',
  properties: { parts: { $ref: '#/$defs/list' }, status: { type: 'object', 'x-atomic': true, 'x-key': '$key', 'x-label': '@lang', 'x-title': { en: 'Status', de: 'Status' } } },
  $defs: {
    list: { title: 'Parts', type: 'array', 'x-key': 'id', 'x-key-scope': 'tree', items: { $ref: '#/$defs/part' } },
    part: { title: 'Part', type: 'object', properties: { id: { type: 'string' }, parts: { $ref: '#/$defs/list' } } },
  },
};
assert.deepEqual(
  describeChanges(
    { parts: [{ id: 'Sleeve', parts: [{ id: 'Cuff' }] }, { id: 'Collar' }], status: { $key: 'lead', en: 'Lead', de: 'Interessent' } },
    { parts: [{ id: 'Sleeve' }, { id: 'Collar', parts: [{ id: 'Cuff' }] }], status: { $key: 'active', en: 'Active', de: 'Aktiv' } },
    jsonSchemaAdapter(style),
    { language: 'de' },
  ).map((s) => s.text),
  ['Part "Cuff" moved from Sleeve to Collar', 'Status changed from Interessent to Aktiv'],
);
console.log(`✔ built package works on Node ${process.version}`);
