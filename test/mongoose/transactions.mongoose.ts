// Entries are held on the session and written only after the transaction commits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditTrail } from '../../src/mongoose/index.ts';
import { database, entries, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('transactions');

function orderModel(options: Record<string, unknown> = {}) {
  const schema = new mongoose.Schema({ customer: String, status: String });
  schema.plugin(auditTrail, { logger: quietLogger(), ...options });
  return model(conn, 'Order', schema);
}

test('an aborted transaction leaves no entry', async () => {
  const Order = orderModel();
  await Order.createCollection();
  const session = await conn.startSession();
  session.startTransaction();
  const [doc] = await Order.create([{ customer: 'A' }], { session });
  await Order.updateOne({ _id: doc._id }, { status: 'paid' }, { session });
  await Order.insertMany([{ customer: 'B' }, { customer: 'C' }], { session });
  await session.abortTransaction();
  await session.endSession();
  assert.equal(await Order.countDocuments(), 0);
  assert.deepEqual(await entries(Order), []);
});

test('a committed transaction leaves its entries, written after the commit', async () => {
  const Order = orderModel();
  await Order.createCollection();
  const doc = await Order.create({ customer: 'A', status: 'open' });
  const session = await conn.startSession();
  session.startTransaction();
  await Order.updateOne({ _id: doc._id }, { status: 'paid' }, { session });
  const loaded = await Order.findById(doc._id).session(session);
  loaded.customer = 'B';
  await loaded.save();
  await Order.deleteOne({ _id: doc._id }, { session });
  // Nothing is written while the transaction is open.
  assert.equal((await entries(Order)).length, 1);
  await session.commitTransaction();
  await session.endSession();
  const all = await entries(Order);
  assert.deepEqual(all.map((e) => e.operation), ['create', 'update', 'update', 'delete']);
  // The reads ran in the session: each entry sees the transaction's own state.
  assert.deepEqual(all[2]!.changes.map((c) => [c.before, c.after]), [['A', 'B']]);
});

test('a withTransaction retry does not duplicate entries', async () => {
  const Order = orderModel();
  await Order.createCollection();
  const doc = await Order.create({ customer: 'A', status: 'open' });
  const session = await conn.startSession();
  let attempts = 0;
  await session.withTransaction(async () => {
    attempts++;
    await Order.updateOne({ _id: doc._id }, { status: `paid${attempts}` }, { session });
    if (attempts === 1) {
      const error = new mongoose.mongo.MongoError('try again');
      error.addErrorLabel('TransientTransactionError');
      throw error;
    }
  });
  await session.endSession();
  assert.equal(attempts, 2);
  const updates = (await entries(Order)).filter((e) => e.operation === 'update');
  assert.deepEqual(updates.map((e) => e.changes.map((c) => c.after)), [['paid2']]);
});

test('connection.transaction() commits its entries', async () => {
  const Order = orderModel();
  await Order.createCollection();
  await conn.transaction(async (session: any) => {
    await Order.create([{ customer: 'T' }], { session });
  });
  assert.deepEqual((await entries(Order)).map((e) => e.operation), ['create']);
});

test('a failing audit write never aborts the app\'s transaction', async () => {
  const errors: any[] = [];
  const Order = orderModel({ collection: 'bad$name' });
  Order.on('auditError', (e: any) => errors.push(e));
  await Order.createCollection();
  const session = await conn.startSession();
  await session.withTransaction(async () => {
    await Order.create([{ customer: 'A' }], { session });
  });
  await session.endSession();
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'write');
  assert.equal(errors[0].entry.operation, 'create');
});
