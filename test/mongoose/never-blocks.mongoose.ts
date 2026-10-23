// Each failure in the "Never blocks the app" table, forced: the app's write still succeeds and
// returns its normal result every time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditFlush, auditTrail } from '../../src/mongoose/index.ts';
import { database, entries, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('never-blocks');

function orderModel(options: Record<string, unknown> = {}, definition: Record<string, unknown> = { customer: String, status: String }) {
  const schema = new mongoose.Schema(definition);
  schema.plugin(auditTrail, { logger: quietLogger(), ...options });
  return model(conn, 'Order', schema);
}

function collect(M: any): any[] {
  const errors: any[] = [];
  M.on('auditError', (e: any) => errors.push(e));
  return errors;
}

/** A query whose result never arrives, standing in for a slow database. */
function stalled(): any {
  const chain: any = new Proxy({}, { get: (_t, key) => (key === 'exec' ? () => new Promise(() => {}) : key === 'then' ? undefined : () => chain) });
  return chain;
}

test('a schema that can\'t be read at startup: the model works normally, the list is recorded whole', async () => {
  const logger = quietLogger();
  const schema = new mongoose.Schema({ lines: [new mongoose.Schema({ sku: String }, { _id: false })] });
  schema.plugin(auditTrail, { logger });
  const M = model(conn, 'Startup', schema);
  // Logged when the model is compiled, before any write.
  assert.equal(logger.messages.length, 1);
  assert.match(logger.messages[0]!, /lines is recorded as one whole value/);
  const doc = await M.create({ lines: [{ sku: 'A' }] });
  assert.equal(doc.lines[0].sku, 'A');
  assert.equal((await entries(M)).length, 1);
  assert.equal(logger.messages.length, 1);
});

test('a failed before read: the write runs as usual, with its original filter; no entry', async () => {
  const Order = orderModel();
  const errors = collect(Order);
  const doc = await Order.create({ customer: 'A', status: 'open' });
  const findOne = Order.findOne;
  Order.findOne = () => {
    throw new Error('read failed');
  };
  try {
    const res = await Order.updateOne({ customer: 'A' }, { status: 'paid' });
    assert.equal(res.modifiedCount, 1);
    const updated = await Order.findOneAndUpdate({ customer: 'A' }, { status: 'shipped' }, { returnDocument: 'after' });
    assert.equal(updated.status, 'shipped');
  } finally {
    Order.findOne = findOne;
  }
  assert.equal((await Order.findById(doc._id)).status, 'shipped');
  assert.deepEqual(errors.map((e) => e.stage), ['before', 'before']);
  assert.equal((await entries(Order)).length, 1);
});

test('a failed diff (a duplicate _id): the write runs as usual; auditError has the error code', async () => {
  const Order = orderModel({}, { items: [{ sku: String }] });
  const errors = collect(Order);
  const doc = await Order.create({ items: [{ sku: 'A' }] });
  const id = doc.items[0]._id;
  const res = await Order.updateOne({ _id: doc._id }, { $push: { items: { _id: id, sku: 'B' } } });
  assert.equal(res.modifiedCount, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'diff');
  assert.equal(errors[0].error.code, 'DUPLICATE_KEY');
  assert.equal(errors[0].operation, 'update');
  assert.equal(String(errors[0].docId), String(doc._id));
});

test('a failed audit write: the write has already succeeded; auditError carries the entry', async () => {
  const Order = orderModel({ collection: 'bad$name' });
  const errors = collect(Order);
  const doc = await Order.create({ customer: 'A' });
  assert.equal((await Order.findById(doc._id)).customer, 'A');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'write');
  assert.equal(errors[0].entry.changes[0].code, 'RECORD_CREATED');
  assert.equal(String(errors[0].docId), String(doc._id));
});

test('a slow audit database: at most auditTimeoutMS extra per write, then auditError', async () => {
  const Order = orderModel({ auditTimeoutMS: 150 });
  const errors = collect(Order);
  const doc = await Order.create({ customer: 'A', status: 'open' });
  // The setup write is the first to the audit collection, which creates it: under load that can
  // take longer than this test's tight budget. Only the writes below are under test.
  errors.length = 0;
  const findOne = Order.findOne;
  Order.findOne = () => stalled();
  const started = Date.now();
  try {
    const res = await Order.updateOne({ _id: doc._id }, { status: 'paid' });
    assert.equal(res.modifiedCount, 1);
  } finally {
    Order.findOne = findOne;
  }
  const took = Date.now() - started;
  assert.ok(took < 1000, `took ${took} ms`);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'before');
  assert.equal(errors[0].error.name, 'AuditTimeoutError');

  // A stalled audit write: the budget covers it too.
  const collection = conn.collection.bind(conn);
  (conn as any).collection = (name: string, ...rest: unknown[]) =>
    name === 'audit_trail' ? { insertOne: () => new Promise(() => {}), createIndex: async () => {} } : collection(name, ...(rest as []));
  const t = Date.now();
  try {
    await Order.create({ customer: 'B' });
  } finally {
    (conn as any).collection = collection;
  }
  assert.ok(Date.now() - t < 1000);
  assert.equal(errors.length, 2);
  assert.equal(errors[1].stage, 'write');
  assert.equal(errors[1].error.name, 'AuditTimeoutError');
});

test('without a listener, failures log at most once a minute per model, with a count', async () => {
  const logger = quietLogger();
  const Order = orderModel({ collection: 'bad$name', logger });
  for (let i = 0; i < 5; i++) await Order.create({ customer: String(i) });
  assert.equal(await Order.countDocuments(), 5);
  assert.equal(logger.messages.length, 1);
  assert.match(logger.messages[0]!, /write failed/);
});

test('a throwing auditError listener never reaches the app', async () => {
  const Order = orderModel({ collection: 'bad$name' });
  Order.on('auditError', () => {
    throw new Error('listener bug');
  });
  const doc = await Order.create({ customer: 'A' });
  assert.ok(doc._id);
});

test('background: true writes after the call returns; auditFlush waits for it', async () => {
  const Order = orderModel({ background: true });
  const doc = await Order.create({ customer: 'A', status: 'open' });
  await Order.updateOne({ _id: doc._id }, { status: 'paid' });
  await auditFlush();
  assert.deepEqual((await entries(Order)).map((e) => e.operation), ['create', 'update']);
  // The after value of a save is taken when save returns, not when the entry is written.
  doc.status = 'shipped';
  await doc.save();
  doc.status = 'changed later';
  await auditFlush();
  const last = (await entries(Order)).at(-1)!;
  assert.deepEqual(last.changes.map((c) => c.after), ['shipped']);
});
