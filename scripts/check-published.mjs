#!/usr/bin/env node
// After a release: installs the published package into an empty folder, as an app would, and
// runs the README's order example against it.
//
//   node scripts/check-published.mjs 1.0.0
//
// Run it under each Node version to check, for example with `npx -p node@18 node scripts/...`.
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/check-published.mjs <version>');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'audit-trail-text-check-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'check', private: true, type: 'module' }));
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
execSync(`npm install audit-trail-text@${version} --no-audit --no-fund --loglevel error`, { cwd: dir, stdio: 'inherit' });

const example = `
import { describeChanges, jsonSchemaAdapter } from 'audit-trail-text';
const contactSchema = {
  title: 'Contact', type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    phone: { type: 'string', title: 'Phone' },
    status: { type: 'string', title: 'Status', oneOf: [{ const: 'lead', title: 'Lead' }, { const: 'active', title: 'Active customer' }] },
    orders: {
      type: 'array', title: 'Orders', 'x-key': 'id', 'x-label': '{product}',
      items: { type: 'object', title: 'Order', properties: { id: { type: 'string' }, product: { type: 'string' }, qty: { type: 'integer', title: 'Quantity' } } },
    },
  },
};
const before = { name: 'Rajesh Kumar', phone: '98400 11111', status: 'lead',
  orders: [{ id: 'A1', product: 'Blue kurta', qty: 2 }, { id: 'A2', product: 'Red saree', qty: 1 }] };
const after = { name: 'Rajesh Kumar', phone: '98400 22222', status: 'active',
  orders: [{ id: 'A1', product: 'Blue kurta', qty: 3 }] };
console.log(JSON.stringify(describeChanges(before, after, jsonSchemaAdapter(contactSchema), { locale: 'en-IN' }).map((s) => s.text)));
`;
writeFileSync(join(dir, 'example.mjs'), example);
const out = JSON.parse(execFileSync(process.execPath, ['example.mjs'], { cwd: dir, encoding: 'utf8' }));

assert.deepEqual(out, [
  'Phone changed from "98400 11111" to "98400 22222"',
  'Status changed from Lead to Active customer',
  'Orders › Blue kurta: Quantity changed from 2 to 3',
  'Order "Red saree" removed from Orders',
]);
const installed = execFileSync(process.execPath, ['-p', "require('./node_modules/audit-trail-text/package.json').version"], { cwd: dir, encoding: 'utf8' }).trim();
assert.equal(installed, version);
console.log(`✔ audit-trail-text@${installed} installs and runs the README example on Node ${process.version}`);
