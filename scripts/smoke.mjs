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
console.log(`✔ built package works on Node ${process.version}`);
