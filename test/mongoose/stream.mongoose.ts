// Stream mode through the Mongoose plugin: the who-field on every write path, transaction
// context, models refused in hooks mode, and history reading both kinds of entry.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DiffError } from '../../src/index.ts';
import { auditContext, auditTrail, startAuditWatcher } from '../../src/mongoose/index.ts';
import { database, entries, major, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('stream');
const fast = { lease: { renewMS: 100, takeoverMS: 400 } };

function orderSchema(options: Record<string, unknown> = {}) {
  const schema = new mongoose.Schema({ customer: { type: String, title: 'Customer' }, status: { type: String, title: 'Status' }, pin: { type: String, select: false } }, { timestamps: true });
  schema.plugin(auditTrail, { mode: 'stream', logger: quietLogger(), ...options });
  return schema;
}

const watchers: any[] = [];
after(async () => {
  for (const w of watchers) await w.stop();
});

async function streamModel(name: string, options: Record<string, unknown> = {}, watcherOptions: Record<string, unknown> = {}) {
  const M = model(conn, name, orderSchema(options));
  // Mongoose creates the collection itself (autoCreate); the watcher turns images on with collMod.
  await M.init();
  const watcher = await startAuditWatcher({ connection: conn, models: [M], enableImages: true, ...fast, logger: quietLogger(), ...watcherOptions });
  watchers.push(watcher);
  for (let i = 0; i < 50 && !watcher.active; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(watcher.active, 'the watcher is active');
  return { M, watcher };
}

const users = (list: any[]) => list.map((e) => [e.operation, e.user ?? null]);

test('who-field: every write path through the plugin carries its own user; deletes outside transactions have none', async () => {
  const { M, watcher } = await streamModel('WhoOrder', { whoField: '_audit' });
  const as = (user: string, fn: () => unknown) => auditContext.run({ user }, fn as () => Promise<unknown>);
  const a: any = await as('u_create', () => M.create({ customer: 'A', status: 'open' }));
  const doc = await M.findById(a._id);
  doc.status = 'paid';
  doc.$locals.audit = { user: 'u_save' };
  await doc.save();
  await as('u_updateOne', () => M.updateOne({ _id: a._id }, { status: 'shipped' }));
  await as('u_set', () => M.updateOne({ _id: a._id }, { $set: { customer: 'A2' } }));
  await as('u_pipeline', () => M.updateOne({ _id: a._id }, [{ $set: { status: 'returned' } }], { updatePipeline: true } as any));
  await as('u_foauBefore', () => M.findOneAndUpdate({ _id: a._id }, { status: 'open' }));
  await as('u_foauAfter', () => M.findOneAndUpdate({ _id: a._id }, { status: 'paid' }, { returnDocument: 'after' }));
  await as('u_replace', () => M.replaceOne({ _id: a._id }, { customer: 'A3', status: 'paid' }));
  await as('u_foar', () => M.findOneAndReplace({ _id: a._id }, { customer: 'A4', status: 'paid' }));
  await M.updateOne({ _id: a._id }, { status: 'x' }, { audit: { user: 'u_option' } } as any);
  const [b] = await as('u_insertMany', () => M.insertMany([{ customer: 'B', status: 'open' }])) as any[];
  await as('u_updateMany', () => M.updateMany({ _id: { $in: [a._id, b._id] } }, { status: 'many' }));
  const upserted = new mongoose.Types.ObjectId();
  await as('u_upsert', () => M.updateOne({ _id: upserted }, { customer: 'C' }, { upsert: true }));
  await as('u_bulk', () => M.bulkWrite([{ updateOne: { filter: { _id: b._id }, update: { $set: { status: 'bulk' } } } }, { insertOne: { document: { customer: 'D' } } }]));
  await as('u_delete', () => M.deleteOne({ _id: upserted }));
  await watcher.caughtUp();
  assert.deepEqual(users(await entries(M).then((es) => es.filter((e) => String(e.docId) === String(a._id)))), [
    ['create', 'u_create'], ['update', 'u_save'], ['update', 'u_updateOne'], ['update', 'u_set'], ['update', 'u_pipeline'],
    ['update', 'u_foauBefore'], ['update', 'u_foauAfter'], ['update', 'u_replace'], ['update', 'u_foar'], ['update', 'u_option'], ['update', 'u_updateMany'],
  ]);
  const bulk = major >= 8 ? 'u_bulk' : null; // Mongoose 7 has no bulkWrite middleware
  assert.deepEqual(users(await entries(M).then((es) => es.filter((e) => String(e.docId) === String(b._id)))), [['create', 'u_insertMany'], ['update', 'u_updateMany'], ['update', bulk]]);
  assert.deepEqual(users(await entries(M).then((es) => es.filter((e) => String(e.docId) === String(upserted)))), [['create', 'u_upsert'], ['delete', null]]);
  // The field is kept by the strict schema, hidden from reads, and in no entry.
  assert.ok((await M.collection.findOne({ _id: a._id }))._audit.writeId);
  assert.equal((await M.findById(a._id))._audit, undefined);
  assert.doesNotMatch(JSON.stringify(await entries(M)), /_audit|writeId/);
  await watcher.stop();
});

test('who-field: an update that touches the field itself still succeeds; the plugin owns it', async () => {
  const { M, watcher } = await streamModel('OwnedOrder', { whoField: '_audit' });
  const doc = await auditContext.run({ user: 'u1' }, () => M.create({ customer: 'A' }));
  await auditContext.run({ user: 'u2' }, () => M.updateOne({ _id: doc._id }, { $set: { status: 'paid', '_audit.user': 'forged' }, $unset: { _audit: 1 } }));
  await auditContext.run({ user: 'u3' }, () => M.updateOne({ _id: doc._id }, { $rename: { status: '_audit' } }));
  await auditContext.run({ user: 'u4' }, () => M.findOneAndUpdate({ _id: doc._id }, { status: 'shipped', _audit: { user: 'forged' } }));
  await watcher.caughtUp();
  assert.deepEqual(users(await entries(M)), [['create', 'u1'], ['update', 'u2'], ['update', 'u4']]);
  await watcher.stop();
});

test('who-field: an update that changed nothing still becomes a real write, and records nothing', async () => {
  const { M, watcher } = await streamModel('NoopOrder', { whoField: '_audit' });
  const doc = await M.create({ customer: 'A', status: 'open' });
  const res = await M.updateOne({ _id: doc._id }, { status: 'open' }, { timestamps: false });
  assert.equal(res.modifiedCount, 1, 'documented: the who-field changes every write');
  await watcher.caughtUp();
  assert.equal((await entries(M)).length, 1);
  await watcher.stop();
});

test('without a who-field: no user outside transactions; skip records nothing', async () => {
  const { M, watcher } = await streamModel('PlainOrder');
  const doc = await auditContext.run({ user: 'u1' }, () => M.create({ customer: 'A' }));
  await M.updateOne({ _id: doc._id }, { status: 'x' });
  await watcher.caughtUp();
  assert.deepEqual(users(await entries(M)), [['create', null], ['update', null]]);
  assert.equal((await M.collection.findOne({ _id: doc._id }))._audit, undefined, 'nothing added to the document');
  await watcher.stop();
});

test('transactions: the first write\'s user, recorded at commit, covers every write in it, deletes included; aborted leaves nothing', async () => {
  const { M, watcher } = await streamModel('TxOrder');
  const [x, y] = await M.create([{ customer: 'X' }, { customer: 'Y' }]);
  await auditContext.run({ user: 'u_tx', reason: 'Refund' }, async () => {
    const session = await conn.startSession();
    await session.withTransaction(async () => {
      await M.updateOne({ _id: x._id }, { status: 'paid' }, { session });
      await M.deleteOne({ _id: y._id }, { session });
      await M.create([{ customer: 'Z' }], { session });
    });
    await session.endSession();
  });
  const session = await conn.startSession();
  session.startTransaction();
  await M.updateOne({ _id: x._id }, { status: 'never' }, { session });
  await session.abortTransaction();
  await session.endSession();
  await watcher.caughtUp();
  const all = await entries(M);
  assert.deepEqual(all.slice(2).map((e) => [e.operation, e.user, e.reason]), [['update', 'u_tx', 'Refund'], ['delete', 'u_tx', 'Refund'], ['create', 'u_tx', 'Refund']]);
  assert.doesNotMatch(JSON.stringify(all), /never/);
  await watcher.stop();
});

test('a transaction whose context record fails carries on; its changes have no user', async () => {
  const { M, watcher } = await streamModel('BadContext', { contextCollection: 'bad$name' }, { contextCollection: 'audit_context' });
  const doc = await M.create({ customer: 'X' });
  await auditContext.run({ user: 'u' }, async () => {
    const session = await conn.startSession();
    await session.withTransaction(() => M.updateOne({ _id: doc._id }, { status: 'paid' }, { session }));
    await session.endSession();
  });
  assert.equal((await M.findById(doc._id)).status, 'paid');
  await watcher.caughtUp();
  assert.deepEqual(users(await entries(M)), [['create', null], ['update', null]]);
  await watcher.stop();
});

test('a model in hooks mode is refused, with a warning: watching it would record every write twice', async () => {
  const hooks = new mongoose.Schema({ n: Number });
  hooks.plugin(auditTrail, { logger: quietLogger() });
  const H = model(conn, 'HooksOrder', hooks);
  const logger = quietLogger();
  await assert.rejects(startAuditWatcher({ connection: conn, models: [H], logger }), /no model in stream mode/);
  assert.match(logger.messages.join('\n'), /hooks mode, so watching it too would record every write twice/);
});

test('history reads hook entries, stream entries and gaps together', async () => {
  const { M, watcher } = await streamModel('MixedOrder', { whoField: '_audit' });
  const doc = await auditContext.run({ user: 'u1' }, () => M.create({ customer: 'A', status: 'open' }));
  await watcher.caughtUp();
  // An entry recorded by 1.3's hooks mode, before the switch.
  await conn.db!.collection('audit_trail').insertOne({ model: M.modelName, docId: doc._id, operation: 'update', at: new Date(Date.now() - 60_000), changes: [{ code: 'FIELD_CHANGED', labels: ['Status'], before: 'draft', after: 'open', display: { type: 'string' }, inSchema: true }], v: 1 });
  await conn.db!.collection('audit_trail').insertOne({ model: M.modelName, operation: 'gap', at: new Date(), from: new Date(Date.now() - 30_000), to: new Date(), changes: [], stage: 'resume', source: 'stream', v: 1 });
  await auditContext.run({ user: 'u2' }, () => M.updateOne({ _id: doc._id }, { status: 'paid' }));
  await watcher.caughtUp();
  const history = await M.history(doc._id, { timeZone: 'UTC' });
  assert.deepEqual(history.map((h: any) => [h.source ?? 'hooks', h.operation, h.sentences[0].replace(/between .+ and .+ were/, 'between … were')]), [
    ['stream', 'update', 'Status changed from "open" to "paid"'],
    ['stream', 'gap', 'Changes between … were not recorded'],
    ['stream', 'create', 'Mixed Order' + M.modelName.slice('MixedOrder'.length) + ' created'],
    ['hooks', 'update', 'Status changed from "draft" to "open"'],
  ]);
  await watcher.stop();
});

test("the who-field is added with the schema's own typeKey", async () => {
  const schema = new mongoose.Schema({ name: { $type: String }, type: { $type: String } }, { typeKey: '$type' });
  schema.plugin(auditTrail, { mode: 'stream', whoField: '_audit', logger: quietLogger() });
  const M = model(conn, 'TypeKey', schema);
  assert.equal(M.schema.path('_audit')?.instance, 'Mixed');
  assert.equal(M.schema.path('_audit')?.options?.select, false);
  const doc = await M.create({ name: 'A', type: 'kind' });
  assert.ok((await M.collection.findOne({ _id: doc._id }))._audit.writeId);
});

test('stream options are checked', () => {
  const s = new mongoose.Schema({ n: Number });
  assert.throws(() => s.plugin(auditTrail, { mode: 'live' } as any), (e: unknown) => e instanceof DiffError && e.path === 'mode');
  assert.throws(() => new mongoose.Schema({}).plugin(auditTrail, { whoField: '_audit' }), (e: unknown) => e instanceof DiffError && e.path === 'whoField');
  assert.throws(() => new mongoose.Schema({}).plugin(auditTrail, { mode: 'stream', whoField: 'a.b' }), (e: unknown) => e instanceof DiffError && e.path === 'whoField');
});
