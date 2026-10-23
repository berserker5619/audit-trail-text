// Each row of the schema table, and the options read from a path.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiffError } from '../../src/index.ts';
import { auditTrail, mongooseSchemaAdapter } from '../../src/mongoose/index.ts';
import { database, entries, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('schema');
const { Schema } = mongoose;

/** The model's history as sentences, oldest first. */
async function sentences(M: any, id: unknown, options = {}): Promise<string[][]> {
  return (await M.history(id, options)).reverse().map((h: { sentences: string[] }) => h.sentences);
}

function audited(definition: Record<string, unknown>, schemaOptions: Record<string, unknown> = {}, pluginOptions: Record<string, unknown> = {}) {
  const schema = new Schema(definition, schemaOptions);
  schema.plugin(auditTrail, { logger: quietLogger(), ...pluginOptions });
  return schema;
}

test('String, Number and Boolean read as text, number and Yes/No; enum values as codes with labels', async () => {
  const M = model(conn, 'Plain', audited(
    { name: String, qty: Number, active: Boolean, status: { type: String, enum: ['open', 'paid'] } },
    {},
    { labels: { '/status=paid': 'Paid' } },
  ));
  const doc = await M.create({ name: 'Rose', qty: 1200, active: false, status: 'open' });
  await M.updateOne({ _id: doc._id }, { name: 'Lily', qty: 1500.5, active: true, status: 'paid' });
  const [, update] = await sentences(M, doc._id);
  assert.deepEqual(update, ['Name changed from "Rose" to "Lily"', 'Qty changed from 1,200 to 1,500.5', 'Active changed from No to Yes', 'Status changed from open to Paid']);
});

test('Date as a date-time in the reader\'s time zone; auditFormat: "date" for date-only paths', async () => {
  const M = model(conn, 'Dates', audited({ due: Date, birthday: { type: Date, auditFormat: 'date' } }));
  const doc = await M.create({ due: new Date('2026-10-23T09:12:00Z'), birthday: new Date('1990-05-01T00:00:00Z') });
  await M.updateOne({ _id: doc._id }, { due: new Date('2026-10-24T18:30:00Z'), birthday: new Date('1990-05-02T00:00:00Z') });
  const [, update] = await sentences(M, doc._id, { timeZone: 'Asia/Kolkata' });
  assert.deepEqual(update, ['Due changed from Oct 23, 2026, 2:42 PM to Oct 25, 2026, 12:00 AM', 'Birthday changed from May 1, 1990 to May 2, 1990']);
  const [entry] = await entries(M);
  assert.deepEqual(entry!.changes[0]!.after, { due: '2026-10-23T09:12:00.000Z', birthday: '1990-05-01', _id: String(doc._id) });
});

test('ObjectId as its id; populated documents are stored as their id', async () => {
  const Customer = model(conn, 'Customer', new Schema({ name: String }));
  const M = model(conn, 'Ref', audited({ customer: { type: Schema.Types.ObjectId, ref: Customer.modelName, title: 'Customer' } }));
  const [a, b] = await Customer.create([{ name: 'A' }, { name: 'B' }]);
  const doc = await M.create({ customer: a._id });
  const loaded = await M.findById(doc._id).populate('customer');
  assert.equal(loaded.customer.name, 'A');
  loaded.customer = b;
  await loaded.save();
  const [, update] = await entries(M);
  assert.deepEqual(update!.changes.map((c) => [c.before, c.after]), [[String(a._id), String(b._id)]]);
});

test('Decimal128 and BigInt print as numbers, with every digit kept', async () => {
  const M = model(conn, 'Money', audited({ price: { type: Schema.Types.Decimal128, title: 'Price' }, units: BigInt }));
  const doc = await M.create({ price: '12.00', units: 9007199254740993n });
  await M.updateOne({ _id: doc._id }, { price: '1234.50', units: 9007199254740995n });
  const [, update] = await sentences(M, doc._id);
  assert.deepEqual(update, ['Price changed from 12.00 to 1,234.50', 'Units changed from 9,007,199,254,740,993 to 9,007,199,254,740,995']);
});

test('Buffer is compared by its bytes and reported as changed without its value', async () => {
  const M = model(conn, 'Bytes', audited({ blob: Buffer }));
  const doc = await M.create({ blob: Buffer.from('secret one') });
  await M.updateOne({ _id: doc._id }, { blob: Buffer.from('secret one') });
  await M.updateOne({ _id: doc._id }, { blob: Buffer.from('secret two') });
  const all = await entries(M);
  assert.equal(all.length, 2);
  assert.deepEqual((await sentences(M, doc._id))[1], ['Blob changed']);
  assert.doesNotMatch(JSON.stringify(all), /secret/);
});

test('Mixed is one value compared whole, even when edited in place', async () => {
  const M = model(conn, 'Mixed', audited({ meta: {}, extra: Schema.Types.Mixed }));
  const doc = await M.create({ meta: { a: { b: 1 } }, extra: 'x' });
  const loaded = await M.findById(doc._id);
  loaded.meta.a.b = 2;
  loaded.markModified('meta');
  await loaded.save();
  const [, update] = await entries(M);
  assert.deepEqual(update!.changes.map((c) => [c.code, c.before, c.after]), [['FIELD_CHANGED', { a: { b: 1 } }, { a: { b: 2 } }]]);
  assert.deepEqual((await sentences(M, doc._id))[1], ['Meta changed']);
});

test('Map: one change per key', async () => {
  const M = model(conn, 'Maps', audited({ stock: { type: Map, of: Number }, notes: { type: Map, of: new Schema({ text: String }, { _id: false }) } }));
  const doc = await M.create({ stock: { red: 1, blue: 2 }, notes: { a: { text: 'x' } } });
  const loaded = await M.findById(doc._id);
  loaded.stock.set('red', 5);
  loaded.stock.delete('blue');
  loaded.notes.get('a').text = 'y';
  await loaded.save();
  assert.deepEqual((await sentences(M, doc._id))[1], ['Stock: blue cleared (was 2)', 'Stock: red changed from 1 to 5', 'Notes › a: Text changed from "x" to "y"']);
});

test('nested paths and single subdocuments are nested objects', async () => {
  const M = model(conn, 'Nested', audited({ address: { city: { type: String, title: 'City' } }, billing: new Schema({ zip: String }) }));
  const doc = await M.create({ address: { city: 'Chennai' }, billing: { zip: '600001' } });
  await M.updateOne({ _id: doc._id }, { 'address.city': 'Madurai', 'billing.zip': '625001' });
  assert.deepEqual((await sentences(M, doc._id))[1], ['Address: City changed from "Chennai" to "Madurai"', 'Billing: Zip changed from "600001" to "625001"']);
});

test('arrays of subdocuments are keyed by _id, nested arrays too; plain arrays compare by value with duplicates', async () => {
  const M = model(conn, 'Lists', audited(
    {
      lines: [{ sku: String, qty: Number, parts: [{ name: String, count: Number }] }],
      tags: [String],
    },
    {},
    { labels: { '/lines#label': '{sku}', '/lines/*/parts#label': '{name}' } },
  ));
  const doc = await M.create({ lines: [{ sku: 'A1', qty: 1, parts: [{ name: 'Sleeve', count: 2 }] }, { sku: 'B2', qty: 1 }], tags: ['x', 'x', 'y'] });
  const loaded = await M.findById(doc._id);
  loaded.lines[0].parts[0].count = 3;
  loaded.lines.pull(loaded.lines[1]._id);
  loaded.tags = ['x', 'y'];
  await loaded.save();
  assert.deepEqual((await sentences(M, doc._id))[1], ['Lines › A1 › Parts › Sleeve: Count changed from 2 to 3', 'Item "B2" removed from Lines', '"x" removed from Tags']);
});

test('discriminators: each document uses its own discriminator\'s schema', async () => {
  const Base = model(conn, 'Event', audited({ title: String }, { discriminatorKey: 'kind' }));
  const Click = Base.discriminator(`Click${Base.modelName}`, new Schema({ x: { type: Number, title: 'X position' } }), 'click');
  const doc = await Click.create({ title: 'a', x: 1 });
  await Base.updateOne({ _id: doc._id }, { x: 2 }, { strict: false });
  await Click.updateOne({ _id: doc._id }, { x: 3 });
  const all = await entries(Base);
  assert.ok(all.every((e) => e.model === Base.modelName));
  assert.deepEqual((await sentences(Base, doc._id)).slice(1), [['X position changed from 1 to 2'], ['X position changed from 2 to 3']]);
});

test('a schema toObject transform changes nothing that is recorded', async () => {
  const schema = audited({ name: String, secretNote: String }, {
    toObject: { transform: (_doc: unknown, ret: Record<string, unknown>) => { delete ret['name']; ret['added'] = 1; return ret; } },
  });
  const M = model(conn, 'Transform', schema);
  const doc = await M.create({ name: 'A', secretNote: 'n' });
  doc.name = 'B';
  await doc.save();
  const [created, update] = await entries(M);
  assert.deepEqual(Object.keys(created!.changes[0]!.after as object).sort(), ['_id', 'name', 'secretNote']);
  assert.deepEqual(update!.changes.map((c) => [c.before, c.after]), [['A', 'B']]);
});

test('_id: false lists: mongooseSchemaAdapter refuses them; the plugin logs once and records them whole', async () => {
  const definition = { lines: [new Schema({ sku: String, qty: Number }, { _id: false })] };
  assert.throws(() => mongooseSchemaAdapter(new Schema(definition)), (e: unknown) => e instanceof DiffError && e.code === 'LIST_KEY_MISSING');
  assert.doesNotThrow(() => mongooseSchemaAdapter(new Schema(definition), { labels: { '/lines#key': 'sku' } }));

  const logger = quietLogger();
  const M = model(conn, 'NoIds', audited(definition, {}, { logger }));
  const doc = await M.create({ lines: [{ sku: 'A', qty: 1 }] });
  await M.updateOne({ _id: doc._id }, { lines: [{ sku: 'A', qty: 2 }] });
  await M.updateOne({ _id: doc._id }, { lines: [{ sku: 'A', qty: 3 }] });
  assert.deepEqual((await sentences(M, doc._id)).slice(1), [['Lines changed'], ['Lines changed']]);
  assert.equal(logger.messages.filter((m) => m.includes('/lines is recorded as one whole value')).length, 1);
});

test('a recursive schema is read to any depth', async () => {
  const category = new Schema({ name: String });
  category.add({ children: [category] });
  const M = model(conn, 'Tree', audited({ root: category }, {}, { labels: { '$defs/s1/children#label': '{name}' } }));
  const doc = await M.create({ root: { name: 'All', children: [{ name: 'Wear', children: [{ name: 'Sarees' }] }] } });
  const loaded = await M.findById(doc._id);
  loaded.root.children[0].children[0].name = 'Silk sarees';
  await loaded.save();
  assert.deepEqual((await sentences(M, doc._id))[1], ['Root › Children › Wear › Children › Silk sarees: Name changed from "Sarees" to "Silk sarees"']);
});

test('title as text or a language map; auditIgnore, __v and timestamps are never recorded', async () => {
  const M = model(conn, 'Titles', audited(
    { status: { type: String, title: { en: 'Status', de: 'Zustand' } }, syncedAt: { type: Date, auditIgnore: true } },
    { timestamps: true },
  ));
  const doc = await M.create({ status: 'a', syncedAt: new Date() });
  doc.status = 'b';
  doc.syncedAt = new Date(Date.now() + 1000);
  await doc.save();
  await M.updateOne({ _id: doc._id }, { syncedAt: new Date(0) });
  const [created, update] = await entries(M);
  assert.deepEqual(Object.keys(created!.changes[0]!.after as object).sort(), ['_id', 'status']);
  assert.equal((await entries(M)).length, 2);
  assert.deepEqual((await sentences(M, doc._id, { language: 'de' }))[1], ['Zustand changed from "a" to "b"']);
  assert.equal(update!.changes.length, 1);
});

test('select: false and auditSensitive: reported as changed, the value stored nowhere, including snapshots', async () => {
  const M = model(conn, 'Secrets', audited(
    { name: String, cardToken: { type: String, select: false }, pin: { type: String, auditSensitive: true }, address: { zip: { type: String, select: false } } },
    {},
    { snapshots: true },
  ));
  const doc = await M.create({ name: 'A', cardToken: 'tok_one', pin: 'pin_one', address: { zip: 'zip_one' } });
  // Through a query.
  await M.updateOne({ _id: doc._id }, { cardToken: 'tok_two', pin: 'pin_two' });
  // Through save() on a document loaded without the field.
  const loaded = await M.findById(doc._id);
  assert.equal(loaded.cardToken, undefined);
  loaded.cardToken = 'tok_three';
  loaded.set('address.zip', 'zip_two');
  loaded.name = 'B';
  await loaded.save();
  const all = await entries(M);
  assert.deepEqual((await sentences(M, doc._id)).slice(1), [
    ['Card Token changed', 'Pin changed'],
    ['Name changed from "A" to "B"', 'Card Token changed', 'Address: Zip changed'],
  ]);
  assert.ok(all[1]!.snapshot && all[2]!.snapshot, 'snapshots are stored');
  assert.doesNotMatch(JSON.stringify(all), /tok_|pin_|zip_/);
});
