// Every covered write, with the entry it records.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditContext, auditTrail } from '../../src/mongoose/index.ts';
import { database, entries, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('writes');

function orderSchema(options: Record<string, unknown> = {}) {
  const schema = new mongoose.Schema(
    {
      customer: { type: String, title: 'Customer' },
      status: { type: String, enum: ['open', 'paid', 'shipped'], title: 'Status' },
      items: [{ product: { type: String, title: 'Product' }, qty: { type: Number, title: 'Quantity' } }],
      cardToken: { type: String, select: false },
    },
    { timestamps: true },
  );
  schema.plugin(auditTrail, { labels: { '/items#label': '{product}' }, logger: quietLogger(), ...options });
  return schema;
}

test('the spec example: one findOneAndUpdate, read back as sentences', async () => {
  const Order = model(conn, 'Order', orderSchema());
  const order = await Order.create({ customer: 'Asha', status: 'open', items: [{ product: 'Blue kurta', qty: 1 }, { product: 'Red saree', qty: 1 }] });
  await auditContext.run({ user: 'u_41' }, () =>
    Order.findOneAndUpdate({ _id: order._id }, { $set: { 'items.1.qty': 2, status: 'paid' } }),
  );
  const history = await Order.history(order._id, { language: 'en', timeZone: 'Asia/Kolkata' });
  assert.equal(history.length, 2);
  assert.equal(history[0].operation, 'update');
  assert.equal(history[0].user, 'u_41');
  assert.deepEqual(history[0].sentences, ['Status changed from open to paid', 'Items › Red saree: Quantity changed from 1 to 2']);
  assert.equal(history[1].operation, 'create');
  assert.match(history[1].sentences[0], /created$/);
  assert.ok(history[0].at instanceof Date);
});

test('doc.save(): a new document is one RECORD_CREATED, an existing one an update', async () => {
  const Order = model(conn, 'Order', orderSchema());
  const doc = new Order({ customer: 'Asha', status: 'open' });
  doc.$locals.audit = { user: 'u_1', reason: 'Phone order' };
  await doc.save();
  const loaded = await Order.findById(doc._id);
  loaded.status = 'paid';
  loaded.items.push({ product: 'Rose', qty: 3 });
  loaded.$locals.audit = { user: 'u_2' };
  await loaded.save();
  // Saving the same document again: its last saved state is the before value.
  loaded.status = 'shipped';
  await loaded.save();

  const [created, updated, again] = await entries(Order);
  assert.equal(created!.operation, 'create');
  assert.deepEqual(created!.changes.map((c) => c.code), ['RECORD_CREATED']);
  assert.equal(created!.user, 'u_1');
  assert.equal(created!.reason, 'Phone order');
  assert.equal(updated!.operation, 'update');
  assert.equal(updated!.user, 'u_2');
  assert.deepEqual(updated!.changes.map((c) => [c.code, c.before, c.after]), [
    ['FIELD_CHANGED', 'open', 'paid'],
    ['ITEM_ADDED', undefined, updated!.changes[1]!.after],
  ]);
  assert.equal(updated!.changes[1]!.item?.label, 'Rose');
  assert.deepEqual(again!.changes.map((c) => [c.before, c.after]), [['paid', 'shipped']]);
});

test('Model.create() and insertMany(): one create entry per document', async () => {
  const Order = model(conn, 'Order', orderSchema());
  await Order.create([{ customer: 'A' }, { customer: 'B' }]);
  await Order.insertMany([{ customer: 'C' }, { customer: 'D' }, { customer: 'E' }]);
  const all = await entries(Order);
  assert.equal(all.length, 5);
  assert.ok(all.every((e) => e.operation === 'create' && e.changes[0]!.code === 'RECORD_CREATED'));
  assert.deepEqual(all.map((e) => (e.changes[0]!.after as { customer: string }).customer).sort(), ['A', 'B', 'C', 'D', 'E']);
});

test('insertMany with ordered: false records only the documents actually inserted', async () => {
  const Order = model(conn, 'Order', orderSchema());
  const first = await Order.create({ customer: 'A' });
  const before = (await entries(Order)).length;
  await assert.rejects(Order.insertMany([{ customer: 'B' }, { _id: first._id, customer: 'dup' }, { customer: 'C' }], { ordered: false }));
  const created = (await entries(Order)).slice(before);
  assert.deepEqual(created.map((e) => (e.changes[0]!.after as { customer: string }).customer).sort(), ['B', 'C']);
});

test('findOneAndUpdate, updateOne, findOneAndReplace and replaceOne record updates', async () => {
  const Order = model(conn, 'Order', orderSchema());
  const doc = await Order.create({ customer: 'A', status: 'open' });
  await Order.updateOne({ _id: doc._id }, { status: 'paid' });
  await Order.findOneAndReplace({ _id: doc._id }, { customer: 'B', status: 'paid' });
  await Order.replaceOne({ _id: doc._id }, { customer: 'C', status: 'paid' });
  await Order.findByIdAndUpdate(doc._id, { $set: { status: 'shipped' } }, { returnDocument: 'after' });
  const updates = (await entries(Order)).filter((e) => e.operation === 'update');
  assert.deepEqual(updates.map((e) => e.changes.map((c) => [c.labels.join(' › '), c.before, c.after])), [
    [['Status', 'open', 'paid']],
    [['Customer', 'A', 'B']],
    [['Customer', 'B', 'C']],
    [['Status', 'paid', 'shipped']],
  ]);
});

test('an upsert that inserts is recorded as a create, with every way Mongoose returns it', async () => {
  const Order = model(conn, 'Order', orderSchema());
  await Order.updateOne({ customer: 'U1' }, { $set: { status: 'open' } }, { upsert: true });
  await Order.findOneAndUpdate({ customer: 'U2' }, { $set: { status: 'open' } }, { upsert: true, returnDocument: 'after' });
  await Order.findOneAndUpdate({ customer: 'U3' }, { $set: { status: 'open' } }, { upsert: true, returnDocument: 'before' });
  await Order.findOneAndUpdate({ customer: 'U4' }, { $set: { status: 'open' } }, { upsert: true, includeResultMetadata: true, rawResult: true } as any);
  await Order.replaceOne({ customer: 'U5' }, { customer: 'U5', status: 'open' }, { upsert: true });
  // An upsert that matches is an update.
  await Order.updateOne({ customer: 'U1' }, { $set: { status: 'paid' } }, { upsert: true });
  const all = await entries(Order);
  assert.deepEqual(all.map((e) => e.operation), ['create', 'create', 'create', 'create', 'create', 'update']);
  assert.deepEqual(all.slice(0, 5).map((e) => (e.changes[0]!.after as { customer: string }).customer), ['U1', 'U2', 'U3', 'U4', 'U5']);
});

test('an update that changes nothing recordable writes no entry', async () => {
  const Order = model(conn, 'Order', orderSchema());
  const doc = await Order.create({ customer: 'A', status: 'open' });
  await Order.updateOne({ _id: doc._id }, { status: 'open' }); // same value
  await Order.updateOne({ _id: doc._id }, { $set: { updatedAt: new Date(0) } }, { timestamps: false }); // only an ignored field
  await Order.updateOne({ customer: 'nobody' }, { status: 'paid' }); // matches nothing
  const loaded = await Order.findById(doc._id);
  await loaded.save(); // nothing modified
  assert.equal((await entries(Order)).length, 1);
});

test('findOneAndDelete, deleteOne on a query and on a document record deletes', async () => {
  const Order = model(conn, 'Order', orderSchema());
  const [a, b, c] = await Order.create([{ customer: 'A' }, { customer: 'B' }, { customer: 'C' }]);
  await Order.findOneAndDelete({ _id: a._id });
  await Order.deleteOne({ _id: b._id });
  const doc = await Order.findById(c._id);
  doc.$locals.audit = { user: 'u_doc' };
  await doc.deleteOne();
  await Order.deleteOne({ customer: 'nobody' });
  const deletes = (await entries(Order)).filter((e) => e.operation === 'delete');
  assert.equal(deletes.length, 3);
  assert.deepEqual(deletes.map((e) => e.changes.map((c) => c.code)), [['RECORD_DELETED'], ['RECORD_DELETED'], ['RECORD_DELETED']]);
  assert.deepEqual(deletes.map((e) => (e.changes[0]!.before as { customer: string }).customer), ['A', 'B', 'C']);
  assert.equal(deletes[2]!.user, 'u_doc');
});

test('updateMany and deleteMany are skipped with a one-time warning unless many: true', async () => {
  const logger = quietLogger();
  const Order = model(conn, 'Order', orderSchema({ logger }));
  await Order.create([{ customer: 'A', status: 'open' }, { customer: 'B', status: 'open' }]);
  await Order.updateMany({}, { status: 'paid' });
  await Order.updateMany({}, { status: 'shipped' });
  await Order.deleteMany({});
  assert.equal((await entries(Order)).length, 2);
  assert.equal(logger.messages.filter((m) => m.includes('updateMany is not recorded')).length, 1);
  assert.equal(logger.messages.filter((m) => m.includes('deleteMany is not recorded')).length, 1);
});

test('many: true records one entry per document; above maxMany the write runs unaudited with auditError', async () => {
  const Order = model(conn, 'Order', orderSchema({ many: true, maxMany: 3 }));
  await Order.create([{ customer: 'A', status: 'open' }, { customer: 'B', status: 'open' }, { customer: 'C', status: 'paid' }]);
  await Order.updateMany({ status: 'open' }, { status: 'paid' });
  let all = await entries(Order);
  assert.deepEqual(all.slice(3).map((e) => [e.operation, e.changes[0]!.before, e.changes[0]!.after]), [
    ['update', 'open', 'paid'],
    ['update', 'open', 'paid'],
  ]);
  await Order.create({ customer: 'D' });
  const errors: any[] = [];
  Order.on('auditError', (e: any) => errors.push(e));
  const res = await Order.updateMany({}, { status: 'shipped' });
  assert.equal(res.modifiedCount, 4);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'maxMany');
  all = await entries(Order);
  assert.equal(all.length, 6);
  await Order.deleteMany({ customer: { $in: ['A', 'B'] } });
  const deletes = (await entries(Order)).filter((e) => e.operation === 'delete');
  assert.deepEqual(deletes.map((e) => (e.changes[0]!.before as { customer: string }).customer).sort(), ['A', 'B']);
});

test('narrowed filters: a filter matching several documents, with sort, records the document written', async () => {
  const Order = model(conn, 'Order', orderSchema());
  await Order.create([{ customer: 'A', status: 'open' }, { customer: 'B', status: 'open' }, { customer: 'C', status: 'open' }]);
  const written = await Order.findOneAndUpdate({ status: 'open' }, { status: 'paid' }, { sort: { customer: -1 }, returnDocument: 'after' });
  assert.equal(written.customer, 'C');
  // updateOne takes a sort from MongoDB 8.0; before, the server refuses it, plugin or not.
  const server = Number(String((await conn.db!.admin().command({ buildInfo: 1 })).version).split('.')[0]);
  if (server >= 8) await Order.updateOne({ status: 'open' }, { status: 'shipped' }, { sort: { customer: 1 } } as any);
  else await Order.findOneAndUpdate({ status: 'open' }, { status: 'shipped' }, { sort: { customer: 1 } });
  const updates = (await entries(Order)).filter((e) => e.operation === 'update');
  assert.equal(String(updates[0]!.docId), String(written._id));
  const shipped = await Order.findOne({ status: 'shipped' });
  assert.equal(String(updates[1]!.docId), String(shipped._id));
  assert.deepEqual(updates[1]!.changes.map((c) => c.after), ['shipped']);
  // The filter on _id the app wrote stays in force.
  const res = await Order.updateOne({ _id: { $in: [written._id] }, status: 'paid' }, { customer: 'Z' });
  assert.equal(res.modifiedCount, 1);
});

test('findOneAndUpdate and findOneAndReplace returning the document after: that document is the after value, not a later read', async () => {
  // Another writer changes the document on the second findOne during a write: the plugin's
  // first is its before read; a second would be a read after the write.
  const schema = orderSchema();
  let armed = false;
  let reads = 0;
  schema.pre('findOne', async function () {
    if (armed && ++reads === 2) await this.model.collection.updateOne({ _id: this.getFilter()._id }, { $set: { customer: 'Someone else' } });
  });
  const Order = model(conn, 'Order', schema);
  const race = async (write: (id: unknown) => Promise<unknown>) => {
    const doc = await Order.create({ customer: 'A', status: 'open' });
    armed = true;
    reads = 0;
    try {
      await write(doc._id);
    } finally {
      armed = false;
    }
    return (await entries(Order)).filter((e) => e.operation === 'update' && String(e.docId) === String(doc._id));
  };
  const statusOnly = [[['Status', 'paid']]];
  const changes = (es: any[]) => es.map((e) => e.changes.map((c: any) => [c.labels[0], c.after]));
  assert.deepEqual(changes(await race((id) => Order.findOneAndUpdate({ _id: id }, { status: 'paid' }, { returnDocument: 'after' }))), statusOnly);
  assert.deepEqual(changes(await race((id) => Order.findOneAndUpdate({ _id: id }, { status: 'paid' }, { new: true, lean: true }))), statusOnly);
  assert.deepEqual(changes(await race((id) => Order.findOneAndReplace({ _id: id }, { customer: 'A', status: 'paid' }, { returnDocument: 'after', includeResultMetadata: true } as any))), statusOnly);
  // A select: false path, left out of the returned document, is read on its own: still reported.
  const secret = await race((id) => Order.findOneAndUpdate({ _id: id }, { status: 'paid', cardToken: 'tok_new' }, { returnDocument: 'after' }));
  assert.deepEqual(secret.map((e: any) => e.changes.map((c: any) => [c.labels[0], c.redacted ?? c.after])), [[['Status', 'paid'], ['Card Token', true]]]);
  assert.doesNotMatch(JSON.stringify(secret), /tok_new/);
  // The control: updateOne returns no document, so the plugin reads after the write and sees the
  // other writer's change. Exact only inside a transaction.
  assert.deepEqual(changes(await race((id) => Order.updateOne({ _id: id }, { status: 'paid' }))), [[['Customer', 'Someone else'], ['Status', 'paid']]]);
});

test('findOneAndUpdate and findOneAndReplace returning the document before: that document is the before value, not the read before the write', async () => {
  // Another writer changes the document after the plugin's read and before the write.
  const schema = orderSchema();
  let armed: unknown;
  const race = async function (this: any) {
    if (armed === undefined) return;
    const id = armed;
    armed = undefined;
    await this.model.collection.updateOne({ _id: id }, { $set: { customer: 'Someone else' } });
  };
  schema.pre('findOneAndUpdate', race);
  schema.pre('findOneAndReplace', race);
  schema.pre('updateOne', race);
  const Order = model(conn, 'Order', schema);
  const changes = async (write: (id: unknown) => Promise<unknown>) => {
    const doc = await Order.create({ customer: 'A', status: 'open' });
    armed = doc._id;
    await write(doc._id);
    return (await entries(Order))
      .filter((e) => e.operation === 'update' && String(e.docId) === String(doc._id))
      .map((e) => e.changes.map((c: any) => [c.labels[0], c.after]));
  };
  const statusOnly = [[['Status', 'paid']]];
  assert.deepEqual(await changes((id) => Order.findOneAndUpdate({ _id: id }, { status: 'paid' })), statusOnly);
  assert.deepEqual(await changes((id) => Order.findOneAndUpdate({ _id: id }, { status: 'paid' }, { returnDocument: 'before', lean: true })), statusOnly);
  assert.deepEqual(await changes((id) => Order.findOneAndReplace({ _id: id }, { customer: 'Someone else', status: 'paid' }, { includeResultMetadata: true } as any)), statusOnly);
  // The control: updateOne returns nothing, so its before value is the read before the write.
  assert.deepEqual(await changes((id) => Order.updateOne({ _id: id }, { status: 'paid' })), [[['Customer', 'Someone else'], ['Status', 'paid']]]);
});
