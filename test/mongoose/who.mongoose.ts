// Who and why: per query, per document, per request, merged; and skipping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { auditContext, auditTrail } from '../../src/mongoose/index.ts';
import { database, entries, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('who');

function orderModel() {
  const schema = new mongoose.Schema({ customer: String, status: String });
  schema.plugin(auditTrail, { logger: quietLogger() });
  return model(conn, 'Order', schema);
}

test('auditContext holds across awaits, and concurrent requests never mix users up', async () => {
  const Order = orderModel();
  const docs = await Order.create(Array.from({ length: 20 }, (_, i) => ({ customer: String(i), status: 'open' })));
  await Promise.all(
    docs.map((doc: any, i: number) =>
      auditContext.run({ user: `u_${i}` }, async () => {
        await sleep(Math.random() * 20);
        await Order.updateOne({ _id: doc._id }, { status: 'paid' });
        await sleep(Math.random() * 20);
        const loaded = await Order.findById(doc._id);
        loaded.status = 'shipped';
        await loaded.save();
      }),
    ),
  );
  const updates = (await entries(Order)).filter((e) => e.operation === 'update');
  assert.equal(updates.length, 40);
  for (const e of updates) {
    const doc = docs.find((d: any) => String(d._id) === String(e.docId));
    assert.equal(e.user, `u_${doc.customer}`);
  }
});

test('nested contexts merge: an inner reason keeps the outer user', async () => {
  const Order = orderModel();
  const doc = await Order.create({ customer: 'A', status: 'open' });
  await auditContext.run({ user: 'u_outer', reason: 'Outer' }, () =>
    auditContext.run({ reason: 'Refund' }, () => Order.updateOne({ _id: doc._id }, { status: 'refunded' })),
  );
  const [, update] = await entries(Order);
  assert.equal(update!.user, 'u_outer');
  assert.equal(update!.reason, 'Refund');
});

test('per-query and per-document values win over the request context', async () => {
  const Order = orderModel();
  await auditContext.run({ user: 'u_request', reason: 'Request' }, async () => {
    const doc = new Order({ customer: 'A' });
    doc.$locals.audit = { user: 'u_doc' };
    await doc.save();
    await Order.updateOne({ _id: doc._id }, { status: 'paid' }, { audit: { user: 'u_query', reason: 'Query' } } as any);
    await Order.findOneAndUpdate({ _id: doc._id }, { status: 'shipped' }).setOptions({ audit: { reason: 'Set options' } });
  });
  const [created, viaOption, viaSetOptions] = await entries(Order);
  assert.deepEqual([created!.user, created!.reason], ['u_doc', 'Request']);
  assert.deepEqual([viaOption!.user, viaOption!.reason], ['u_query', 'Query']);
  assert.deepEqual([viaSetOptions!.user, viaSetOptions!.reason], ['u_request', 'Set options']);
});

test('with no who, user and reason are left out and the change is still recorded', async () => {
  const Order = orderModel();
  await Order.create({ customer: 'A' });
  const [entry] = await entries(Order);
  assert.ok(!('user' in entry!) && !('reason' in entry!));
});

test('skip records nothing, on a query or for a whole context', async () => {
  const Order = orderModel();
  const doc = await Order.create({ customer: 'A' });
  await Order.updateOne({ _id: doc._id }, { status: 'x' }, { audit: { skip: true } } as any);
  await auditContext.run({ skip: true }, async () => {
    await Order.create({ customer: 'Seed' });
    await Order.deleteOne({ _id: doc._id });
  });
  assert.equal((await entries(Order)).length, 1);
});
