// Stream mode with the plain driver: exact changes from MongoDB's images, who and why, gaps,
// resumes, crashes, failover, large documents.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonSchemaAdapter } from '../../src/index.ts';
import { startAuditWatcher } from '../../src/mongo/index.ts';
import { describeEntries } from '../../src/mongoose/index.ts';
import { dbName, entries, errorsOf, imaged, quietLogger, replicaSet } from './helpers.ts';

const { client: realClient, version } = await replicaSet();
const client: any = realClient;
const adapter = jsonSchemaAdapter({
  title: 'Order',
  type: 'object',
  properties: {
    status: { type: 'string', title: 'Status' },
    qty: { type: 'number', title: 'Quantity' },
    pin: { type: 'string', writeOnly: true },
    items: { type: 'array', title: 'Items', 'x-key': 'sku', items: { type: 'object', title: 'Item', properties: { sku: { type: 'string' }, n: { type: 'number', title: 'N' } } } },
  },
});
const fast = { lease: { renewMS: 100, takeoverMS: 400 }, logger: quietLogger() };

async function setup(name: string, spec: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const db = client.db(dbName(name));
  const orders = await imaged(db, 'orders');
  const watcher = await startAuditWatcher({ client, db: db.databaseName, collections: { orders: { adapter, model: 'Order', ...spec } }, ...fast, ...options });
  for (let i = 0; i < 50 && !watcher.active; i++) await new Promise((r) => setTimeout(r, 20));
  return { db, orders, watcher };
}

test(`MongoDB ${version}: inserts, updates, replaces and deletes are recorded exactly, at the event's wallTime`, async () => {
  const { db, orders, watcher } = await setup('basic');
  await orders.insertOne({ _id: 1, status: 'open', qty: 1, pin: 'S3CR3T', items: [{ sku: 'A', n: 1 }] });
  await orders.updateOne({ _id: 1 }, { $set: { status: 'paid', 'items.0.n': 2 } });
  await orders.replaceOne({ _id: 1 }, { status: 'shipped', qty: 1, items: [] });
  await orders.updateOne({ _id: 1 }, { $set: { status: 'shipped' } }); // no change
  await orders.deleteOne({ _id: 1 });
  await watcher.caughtUp();
  const all = await entries(db, { docId: 1 });
  assert.deepEqual(all.map((e) => e.operation), ['create', 'update', 'update', 'delete']);
  assert.ok(all.every((e) => e.source === 'stream' && typeof e.eventId === 'string' && e.at instanceof Date && e.model === 'Order'));
  assert.deepEqual(describeEntries(all).map((e) => e.sentences), [
    ['Order created'],
    ['Status changed from "open" to "paid"', 'Items › A: N changed from 1 to 2'],
    ['Status changed from "paid" to "shipped"', 'Pin cleared', 'Item "A" removed from Items'],
    ['Order deleted'],
  ]);
  assert.doesNotMatch(JSON.stringify(all), /S3CR3T/);
  assert.equal(new Set(all.map((e) => e.eventId)).size, 4);
  await watcher.stop();
});

test('writes outside any plugin, bulkWrite and updateMany included, are all recorded, with no user', async () => {
  const { db, orders, watcher } = await setup('outside');
  await orders.insertMany([{ _id: 1, qty: 1 }, { _id: 2, qty: 1 }]);
  await orders.bulkWrite([{ updateOne: { filter: { _id: 1 }, update: { $inc: { qty: 1 } } } }, { deleteOne: { filter: { _id: 2 } } }, { insertOne: { document: { _id: 3, qty: 3 } } }]);
  await orders.updateMany({}, { $set: { status: 'bulk' } });
  await watcher.caughtUp();
  const all = await entries(db);
  assert.deepEqual(all.map((e) => [e.docId, e.operation]), [[1, 'create'], [2, 'create'], [1, 'update'], [2, 'delete'], [3, 'create'], [1, 'update'], [3, 'update']]);
  assert.ok(all.every((e) => !('user' in e)));
  await watcher.stop();
});

test('the who-field: credited only when the write changed it; a write that left it is no one\'s; stripped everywhere', async () => {
  const { db, orders, watcher } = await setup('who', { whoField: '_audit', snapshots: true });
  await orders.insertOne({ _id: 1, qty: 1, _audit: { user: 'u1', reason: 'New', writeId: 'w1' } });
  await orders.updateOne({ _id: 1 }, { $set: { qty: 2, _audit: { user: 'u2', writeId: 'w2' } } });
  // A raw write that doesn't set the field, between two that do: no user, never u2's.
  await orders.updateOne({ _id: 1 }, { $set: { qty: 3 } });
  await orders.updateOne({ _id: 1 }, { $set: { qty: 4, '_audit.writeId': 'w4', '_audit.user': 'u4' } });
  // Only the who-field changed: nothing recordable.
  await orders.updateOne({ _id: 1 }, { $set: { _audit: { user: 'u5', writeId: 'w5' } } });
  await orders.replaceOne({ _id: 1 }, { qty: 6, _audit: { user: 'u6', writeId: 'w6' } });
  await orders.updateOne({ _id: 1 }, { $set: { qty: 7, _audit: { user: 'u7', writeId: 'w7', skip: true } } });
  await orders.deleteOne({ _id: 1 });
  await watcher.caughtUp();
  const all = await entries(db, { docId: 1 });
  assert.deepEqual(all.map((e) => [e.operation, e.user ?? null, e.reason ?? null]), [
    ['create', 'u1', 'New'],
    ['update', 'u2', null],
    ['update', null, null],
    ['update', 'u4', null],
    ['update', 'u6', null],
    ['delete', null, null],
  ]);
  assert.doesNotMatch(JSON.stringify(all), /_audit|writeId|w[0-9]/);
  await watcher.stop();
});

test('transaction context: matched by lsid and txnNumber, deletes included; late within contextWaitMS; missing gives no user', async () => {
  const { db, orders, watcher } = await setup('txn', {}, { contextWaitMS: 400 });
  await orders.insertMany([{ _id: 1, qty: 1 }, { _id: 2, qty: 1 }, { _id: 3, qty: 1 }]);
  const run = async (context: 'now' | 'late' | 'never', id: number) => {
    const session = client.startSession();
    session.startTransaction();
    await orders.updateOne({ _id: id }, { $set: { qty: 10 + id } }, { session });
    await orders.deleteOne({ _id: id }, { session });
    const txnNumber = Number((session as any).serverSession.txnNumber);
    const record = { lsid: session.id!['id'], txnNumber, user: `u_${context}`, createdAt: new Date() };
    await session.commitTransaction();
    await session.endSession();
    if (context === 'now') await db.collection('audit_context').insertOne(record);
    if (context === 'late') setTimeout(() => void db.collection('audit_context').insertOne(record), 150);
  };
  await run('now', 1);
  await run('late', 2);
  await run('never', 3);
  await watcher.caughtUp();
  const users = (await entries(db, { operation: { $in: ['update', 'delete'] } })).map((e) => [e.docId, e.operation, e.user ?? null]);
  assert.deepEqual(users, [[1, 'update', 'u_now'], [1, 'delete', 'u_now'], [2, 'update', 'u_late'], [2, 'delete', 'u_late'], [3, 'update', null], [3, 'delete', null]]);
  // Aborted: nothing.
  const session = client.startSession();
  session.startTransaction();
  await orders.insertOne({ _id: 9, qty: 9 }, { session });
  await session.abortTransaction();
  await session.endSession();
  await watcher.caughtUp();
  assert.equal((await entries(db, { docId: 9 })).length, 0);
  await watcher.stop();
});

test('a missing image is a gap entry for that document, and the stream carries on', async () => {
  const db = client.db(dbName('gap'));
  const orders = await imaged(db, 'orders');
  await db.createCollection('plain'); // images off
  const watcher = await startAuditWatcher({ client, db: db.databaseName, collections: { orders: { adapter, model: 'Order' }, plain: { adapter, model: 'Plain' } }, ...fast });
  const errors = errorsOf(watcher);
  await db.collection('plain').insertOne({ _id: 1, qty: 1 });
  await db.collection('plain').updateOne({ _id: 1 }, { $set: { qty: 2 } });
  await orders.insertOne({ _id: 2, qty: 1 });
  await watcher.caughtUp();
  const plain = await entries(db, { model: 'Plain' });
  assert.deepEqual(plain.map((e) => [e.operation, e.stage ?? null]), [['create', null], ['gap', 'preImage']]);
  assert.match(describeEntries(plain, { timeZone: 'UTC' })[1]!.sentences[0]!, /^A change at .+ could not be recorded$/);
  assert.equal((await entries(db, { model: 'Order' })).length, 1, 'the stream carried on');
  assert.deepEqual(errors.map((e) => e.stage), ['preImage']);
  await watcher.stop();
});

test('crashes: stopped and restarted at random points, every write has exactly one entry', async () => {
  const db = client.db(dbName('crash'));
  const orders = await imaged(db, 'orders');
  const start = () => startAuditWatcher({ client, db: db.databaseName, collections: { orders: { adapter, model: 'Order' } }, ...fast, batchSize: 7 });
  let watcher = await start();
  const writes = 600;
  for (let i = 0; i < writes; i++) {
    if (i % 2 === 0) await orders.insertOne({ _id: i, qty: 0 });
    else await orders.updateOne({ _id: i - 1 }, { $set: { qty: i } });
    if (Math.random() < 0.02) {
      // A crash: the process dies without giving up its lease or saving its last batch.
      void (watcher as any).stop();
      watcher = await start();
    }
  }
  for (let i = 0; i < 100 && !watcher.active; i++) await new Promise((r) => setTimeout(r, 50));
  await watcher.caughtUp(60_000);
  const all = await entries(db);
  assert.equal(all.length, writes);
  assert.equal(new Set(all.map((e) => e.eventId)).size, writes);
  await watcher.stop();
});

test('failover with fencing: a paused watcher can\'t overwrite the new owner\'s token, and nothing is lost or doubled', async () => {
  const name = dbName('failover');
  const db = client.db(name);
  const orders = await imaged(db, 'orders');
  // A database handle whose every call can be held, to pause watcher A as a GC pause would.
  let gate: Promise<void> | undefined;
  let open: () => void = () => {};
  const held = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t: any, key) {
        const v = t[key];
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const call = () => v.apply(t, args);
          if (key === 'collection' || key === 'watch') {
            const inner = call();
            return held(inner);
          }
          if (key === 'tryNext' || key === 'updateOne' || key === 'bulkWrite' || key === 'findOneAndUpdate') return (gate ?? Promise.resolve()).then(call);
          return call();
        };
      },
    });
  const a = await startAuditWatcher({ client, db: held(client.db(name)), collections: { orders: { adapter, model: 'Order' } }, ...fast, name: 'A' });
  await orders.insertOne({ _id: 1, qty: 1 });
  await a.caughtUp();
  gate = new Promise<void>((r) => (open = r)); // A pauses
  const b = await startAuditWatcher({ client, db: name, collections: { orders: { adapter, model: 'Order' } }, ...fast, name: 'B' });
  for (let i = 0; i < 100 && !b.active; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(b.active, 'B took over');
  for (let i = 2; i <= 20; i++) await orders.insertOne({ _id: i, qty: i });
  await b.caughtUp();
  const tokenB = (await db.collection('audit_watcher_state').findOne({ _id: `stream:${name}` }))!['token'];
  open(); // A wakes up
  gate = undefined;
  await new Promise((r) => setTimeout(r, 600));
  const state = (await db.collection('audit_watcher_state').findOne({ _id: `stream:${name}` }))!;
  assert.equal(state['owner'], 'B');
  assert.ok(state['epoch'] >= 2);
  // Tokens begin with their cluster time: B's saved position never moved back to A's.
  assert.ok(String(state['token']._data) >= String(tokenB._data), "A did not overwrite B's token");
  assert.equal(a.active, false);
  const all = await entries(db);
  assert.equal(all.length, 20);
  assert.equal(new Set(all.map((e) => String(e.docId))).size, 20);
  await a.stop();
  await b.stop();
});

test('a watcher that can\'t resume (history lost) records one gap per collection, shown in history, and recovers', async () => {
  const name = dbName('resume');
  const db = client.db(name);
  const orders = await imaged(db, 'orders');
  let watcher = await startAuditWatcher({ client, db: name, collections: { orders: { adapter, model: 'Order' } }, ...fast });
  await orders.insertOne({ _id: 1, qty: 1 });
  await watcher.caughtUp();
  await watcher.stop();
  await orders.updateOne({ _id: 1 }, { $set: { qty: 2 } }); // missed: the oplog "rolled over"
  const admin = client.db('admin');
  await admin.command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['aggregate'], errorCode: 286 } });
  try {
    watcher = await startAuditWatcher({ client, db: name, collections: { orders: { adapter, model: 'Order' } }, ...fast });
    const errors = errorsOf(watcher);
    for (let i = 0; i < 100 && !watcher.active; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    await orders.updateOne({ _id: 1 }, { $set: { qty: 3 } });
    await watcher.caughtUp();
    const all = await entries(db);
    const gap = all.find((e) => e.operation === 'gap')!;
    assert.ok(gap && gap.docId === undefined && gap.stage === 'resume' && gap.from <= gap.to);
    assert.deepEqual(all.filter((e) => e.operation !== 'gap').map((e) => e.operation), ['create', 'update']);
    assert.match(describeEntries([gap])[0]!.sentences[0]!, /^Changes between .+ and .+ were not recorded$/);
    assert.ok(errors.some((e) => e.stage === 'resume') || all.some((e) => e.stage === 'resume'));
  } finally {
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
    await watcher.stop();
  }
});

test('a document near 16 MB: both images together pass the event limit; the split event is joined', async () => {
  const { db, orders, watcher } = await setup('large');
  const errors = errorsOf(watcher);
  const big = 'x'.repeat(9 * 1024 * 1024);
  await orders.insertOne({ _id: 1, qty: 1, blob: big });
  await orders.updateOne({ _id: 1 }, { $set: { qty: 2 } });
  await orders.insertOne({ _id: 2, qty: 1 });
  await watcher.caughtUp(120_000);
  const all = await entries(db);
  const update = all.find((e) => e.docId === 1 && e.operation === 'update');
  assert.ok(update, `the large update was recorded (errors: ${errors.map((e) => e.stage).join()})`);
  assert.deepEqual(update.changes.map((c: any) => [c.labels.join(' › '), c.before, c.after]), [['Quantity', 1, 2]]);
  assert.ok(all.some((e) => e.docId === 2), 'the stream carried on');
  await watcher.stop();
});

test('a dropped collection is reported and no longer audited; the others carry on', async () => {
  const db = client.db(dbName('drop'));
  const orders = await imaged(db, 'orders');
  const other = await imaged(db, 'other');
  const watcher = await startAuditWatcher({ client, db: db.databaseName, collections: { orders: { adapter }, other: { adapter } }, ...fast });
  const errors = errorsOf(watcher);
  await orders.drop();
  await other.insertOne({ _id: 1, qty: 1 });
  await watcher.caughtUp();
  assert.ok(errors.some((e) => e.stage === 'collection' && e.collection === 'orders'));
  assert.equal((await entries(db, { model: 'other' })).length, 1);
  await watcher.stop();
});

test('enableImages turns pre- and post-images on with collMod, creating the collection if needed', async () => {
  const db = client.db(dbName('images'));
  await db.createCollection('existing');
  const watcher = await startAuditWatcher({ client, db: db.databaseName, collections: { existing: { adapter }, fresh: { adapter } }, enableImages: true, ...fast });
  const infos = await db.listCollections().toArray();
  for (const name of ['existing', 'fresh']) assert.equal((infos as any[]).find((c) => c.name === name)?.options?.changeStreamPreAndPostImages?.enabled, true, name);
  await watcher.stop();
});

test('standby: a second watcher waits, then takes over within the lease time when the first stops', async () => {
  const name = dbName('standby');
  const db = client.db(name);
  const orders = await imaged(db, 'orders');
  const a = await startAuditWatcher({ client, db: name, collections: { orders: { adapter } }, ...fast, name: 'A' });
  const b = await startAuditWatcher({ client, db: name, collections: { orders: { adapter } }, ...fast, name: 'B' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal([a.active, b.active].filter(Boolean).length, 1);
  const [active, standby] = a.active ? [a, b] : [b, a];
  await orders.insertOne({ _id: 1 });
  await active.caughtUp();
  await active.stop();
  for (let i = 0; i < 100 && !standby.active; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(standby.active);
  await orders.insertOne({ _id: 2 });
  await standby.caughtUp();
  assert.deepEqual((await entries(db)).map((e) => e.docId), [1, 2]);
  await standby.stop();
});

test('a watcher restarted with more collections keeps its position: nothing written in between is lost', async () => {
  const name = dbName('grow');
  const db = client.db(name);
  const orders = await imaged(db, 'orders');
  const customers = await imaged(db, 'customers');
  let watcher = await startAuditWatcher({ client, db: name, collections: { orders: { adapter } }, ...fast });
  await orders.insertOne({ _id: 1, qty: 1 });
  await watcher.caughtUp();
  await watcher.stop();
  await orders.updateOne({ _id: 1 }, { $set: { qty: 2 } });
  await customers.insertOne({ _id: 7, qty: 1 });
  watcher = await startAuditWatcher({ client, db: name, collections: { orders: { adapter }, customers: { adapter } }, ...fast });
  for (let i = 0; i < 100 && !watcher.active; i++) await new Promise((r) => setTimeout(r, 20));
  await watcher.caughtUp();
  assert.deepEqual((await entries(db)).map((e) => [e.model, e.docId, e.operation]), [['orders', 1, 'create'], ['orders', 1, 'update'], ['customers', 7, 'create']]);
  await watcher.stop();
});

test('a stalled step (a reply that never comes) restarts the stream from the saved position: reported, nothing lost or doubled', async () => {
  const name = dbName('stall');
  const db = client.db(name);
  const orders = await imaged(db, 'orders');
  // The first tryNext after it is armed never resolves, as a lost reply would.
  let armed = false;
  const real = client.db(name);
  const proxied = new Proxy(real, {
    get(t: any, key) {
      if (key !== 'watch') return typeof t[key] === 'function' ? t[key].bind(t) : t[key];
      return (...args: unknown[]) => {
        const stream = t.watch(...args);
        const tryNext = stream.tryNext.bind(stream);
        stream.tryNext = () => {
          if (!armed) return tryNext();
          armed = false;
          return new Promise(() => {});
        };
        return stream;
      };
    },
  });
  const watcher = await startAuditWatcher({ client, db: proxied, collections: { orders: { adapter } }, ...fast, stallTimeoutMS: 500 });
  const errors = errorsOf(watcher);
  await orders.insertOne({ _id: 1, qty: 1 });
  await watcher.caughtUp();
  armed = true;
  await orders.insertOne({ _id: 2, qty: 2 });
  await watcher.caughtUp(10_000);
  assert.deepEqual((await entries(db)).map((e) => e.docId), [1, 2]);
  assert.ok(errors.some((e) => e.stage === 'stream' && /stalled for 500 ms in tryNext/.test(String(e.error))), JSON.stringify(errors.map((e) => String(e.error))));
  await watcher.stop();
});
