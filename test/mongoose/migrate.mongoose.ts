// Moving from mongoose-audit. The fixture is written the way mongoose-audit 1.0.0 writes its
// `auditlog`: it logs in pre('save') with doc.toObject(), so "create" and "update" entries hold
// the document after the change, and "delete" (pre('remove')) the document as it was. Its own
// fields _createdAt, _updatedAt and _user are on every document; bulk entries carry a selector.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditTrail, historyFromSnapshots, importMongooseAudit, mongooseSchemaAdapter } from '../../src/mongoose/index.ts';
import type { MongooseAuditLogEntry } from '../../src/mongoose/index.ts';
import { database, entries, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('migrate');
const { Types } = mongoose;

const definition = {
  status: { type: String, title: 'Status' },
  items: [{ product: { type: String, title: 'Product' }, qty: { type: Number, title: 'Quantity' } }],
};
const labels = { '/items#label': '{product}' };

function orderModel() {
  const schema = new mongoose.Schema(definition);
  schema.plugin(auditTrail, { labels, logger: quietLogger() });
  return model(conn, 'Order', schema);
}

const t = (minute: number) => new Date(Date.UTC(2015, 5, 18, 19, minute));

function fixture(location: string) {
  const x = new Types.ObjectId();
  const y = new Types.ObjectId();
  const kurta = new Types.ObjectId();
  const saree = new Types.ObjectId();
  const doc = (id: unknown, status: string, items: unknown[], at: Date, user?: string) => ({
    _id: id, status, items, __v: 0, _createdAt: t(1), _updatedAt: at, ...(user && { _user: user }),
  });
  const log: (MongooseAuditLogEntry & { _id: unknown })[] = [
    { _id: new Types.ObjectId(), ts: t(1), operation: 'create', location, document: doc(x, 'open', [{ _id: kurta, product: 'Blue kurta', qty: 1 }], t(1), 'u_create'), user: 'u_create' },
    { _id: new Types.ObjectId(), ts: t(2), operation: 'update', location, document: doc(x, 'paid', [{ _id: kurta, product: 'Blue kurta', qty: 1 }], t(2), 'u_pay'), user: 'u_pay' },
    { _id: new Types.ObjectId(), ts: t(3), operation: 'update', location, document: doc(x, 'shipped', [{ _id: kurta, product: 'Blue kurta', qty: 1 }, { _id: saree, product: 'Red saree', qty: 2 }], t(3), 'u_ship'), user: 'u_ship' },
    { _id: new Types.ObjectId(), ts: t(4), operation: 'delete', location, document: doc(x, 'shipped', [{ _id: kurta, product: 'Blue kurta', qty: 1 }, { _id: saree, product: 'Red saree', qty: 2 }], t(3), 'u_ship'), user: 'u_delete' },
    // A document that existed before mongoose-audit: its first entry is an update.
    { _id: new Types.ObjectId(), ts: t(1), operation: 'update', location, document: doc(y, 'open', [], t(1)) },
    { _id: new Types.ObjectId(), ts: t(5), operation: 'update', location, document: doc(y, 'paid', [], t(5), 'u_y'), user: 'u_y' },
    // Saved with no change but the timestamp mongoose-audit sets: no entry.
    { _id: new Types.ObjectId(), ts: t(6), operation: 'update', location, document: doc(y, 'paid', [], t(6), 'u_y'), user: 'u_y' },
    // A bulk entry holds the operation, not a document: skipped.
    { _id: new Types.ObjectId(), ts: t(7), operation: 'delete', location, selector: { status: 'paid' }, document: {} },
    // Another collection's entry.
    { _id: new Types.ObjectId(), ts: t(1), operation: 'create', location: 'others', document: doc(new Types.ObjectId(), 'open', [], t(1)) },
  ];
  return { x, y, log };
}

test('a log with a create, updates and a delete pairs each change with its own ts and user', async () => {
  const Order = orderModel();
  const { x, y, log } = fixture(Order.collection.collectionName);
  await conn.db!.collection('auditlog').insertMany(log as any[]);
  const result = await importMongooseAudit(Order);
  assert.deepEqual(result, { read: 7, imported: 5, skipped: 0, failed: [] });

  const xs = (await entries(Order)).filter((e) => String(e.docId) === String(x));
  assert.deepEqual(xs.map((e) => [e.operation, e.user, (e.at as Date).toISOString()]), [
    ['create', 'u_create', t(1).toISOString()],
    ['update', 'u_pay', t(2).toISOString()],
    ['update', 'u_ship', t(3).toISOString()],
    ['delete', 'u_delete', t(4).toISOString()],
  ]);
  assert.deepEqual(xs.map((e) => String(e.importedFrom)), log.slice(0, 4).map((l) => String(l._id)));
  const history = (await Order.history(x)).reverse();
  assert.deepEqual(history.map((h: any) => h.sentences), [
    [`${Order.modelName} created`],
    ['Status changed from "open" to "paid"'],
    ['Status changed from "paid" to "shipped"', 'Item "Red saree" added to Items'],
    [`${Order.modelName} deleted`],
  ]);
  // mongoose-audit's own fields are never recorded.
  assert.doesNotMatch(JSON.stringify(xs), /_updatedAt|_createdAt|_user/);

  const ys = (await entries(Order)).filter((e) => String(e.docId) === String(y));
  assert.deepEqual(ys.map((e) => [e.operation, e.user, e.changes.map((c) => c.after)]), [['update', 'u_y', ['paid']]]);
});

test('imported twice gives the same entries once; the old collection is unchanged', async () => {
  const Order = orderModel();
  const { log } = fixture(Order.collection.collectionName);
  const from = 'auditlog_twice';
  await conn.db!.collection(from).insertMany(log as any[]);
  const first = await importMongooseAudit(Order, { from });
  const afterFirst = await entries(Order);
  const second = await importMongooseAudit(Order, { from });
  assert.equal(first.imported, 5);
  assert.deepEqual(second, { read: 7, imported: 0, skipped: 5, failed: [] });
  assert.deepEqual((await entries(Order)).map((e) => String(e._id)), afterFirst.map((e) => String(e._id)));
  assert.equal(await conn.db!.collection(from).countDocuments(), log.length);
});

test('historyFromSnapshots reads the log without converting it, matching the imported history', async () => {
  const Order = orderModel();
  const { x, log } = fixture(Order.collection.collectionName);
  const from = 'auditlog_read';
  await conn.db!.collection(from).insertMany(log as any[]);
  await importMongooseAudit(Order, { from });
  const imported = await Order.history(x);
  const adapter = mongooseSchemaAdapter(Order.schema, { labels, title: Order.modelName });
  const raw = await conn.db!.collection(from).find({ 'document._id': x }).toArray();
  const read = historyFromSnapshots(raw as any, adapter, { model: Order.modelName });
  assert.deepEqual(read.map((e) => [e.operation, e.user, e.sentences]), imported.map((e: any) => [e.operation, e.user, e.sentences]));
  assert.deepEqual(read.map((e) => e.changes), imported.map((e: any) => e.changes));
});

test('importMongooseAudit needs the plugin on the model', async () => {
  const Plain = model(conn, 'Plain', new mongoose.Schema({ n: Number }));
  await assert.rejects(importMongooseAudit(Plain), /does not use the auditTrail plugin/);
});
