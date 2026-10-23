// Reading history: newest first, paging by entry _id, describeEntries, historyMethod.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditTrail, describeEntries } from '../../src/mongoose/index.ts';
import { database, entries, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('history');

test('200 entries sharing one `at` page through `after` with none skipped or repeated', async () => {
  const schema = new mongoose.Schema({ n: Number });
  schema.plugin(auditTrail, { logger: quietLogger() });
  const M = model(conn, 'Counter', schema);
  const doc = await M.create({ n: 0 });
  const at = new Date('2020-01-01T09:00:00Z');
  const audit = conn.db!.collection('audit_trail');
  await audit.insertMany(
    Array.from({ length: 200 }, (_, i) => ({
      model: M.modelName, docId: doc._id, operation: 'update', at,
      changes: [{ code: 'FIELD_CHANGED', labels: ['N'], before: i, after: i + 1, display: { type: 'number' }, inSchema: true }], v: 1,
    })),
  );
  const seen: string[] = [];
  let after: unknown;
  for (;;) {
    const page = await M.history(doc._id, { limit: 30, after });
    if (page.length === 0) break;
    seen.push(...page.map((e: any) => String(e._id)));
    after = page.at(-1)._id;
  }
  assert.equal(seen.length, 201);
  assert.equal(new Set(seen).size, 201);
  // Newest first: the create, at its own (later) time, then the inserted entries, highest _id first.
  const first = await M.history(doc._id, { limit: 3 });
  assert.equal(first[0].operation, 'create');
  assert.deepEqual(first.slice(1).map((e: any) => e.sentences), [['N changed from 199 to 200'], ['N changed from 198 to 199']]);
  // A string id pages too.
  const fromString = await M.history(String(doc._id), { limit: 2, after: String(first[1]._id) });
  assert.equal(String(fromString[0]._id), String(first[2]._id));
});

test('history passes describe options; describeEntries describes entries an app queried itself', async () => {
  const schema = new mongoose.Schema({ status: { type: String, title: { en: 'Status', de: 'Zustand' } } });
  schema.plugin(auditTrail, { logger: quietLogger() });
  const M = model(conn, 'Lang', schema);
  const doc = await M.create({ status: 'a' });
  await M.updateOne({ _id: doc._id }, { status: 'b' });
  assert.deepEqual((await M.history(doc._id, { language: 'de', limit: 1 }))[0].sentences, ['Zustand changed from "a" to "b"']);
  const mine = await entries(M);
  assert.deepEqual(describeEntries(mine, { language: 'de' }).map((e) => e.sentences), [[`${M.modelName} created`], ['Zustand changed from "a" to "b"']]);
});

test('historyMethod names the static; an existing static of that name is left alone, with a warning', async () => {
  const logger = quietLogger();
  const a = new mongoose.Schema({ n: Number });
  a.plugin(auditTrail, { historyMethod: 'auditHistory', logger });
  const A = model(conn, 'Named', a);
  const doc = await A.create({ n: 1 });
  assert.equal((await A.auditHistory(doc._id)).length, 1);
  assert.equal(A.history, undefined);

  const b = new mongoose.Schema({ n: Number });
  b.static('history', () => 'mine');
  b.plugin(auditTrail, { logger });
  const B = model(conn, 'Taken', b);
  assert.equal(B.history(), 'mine');
  assert.match(logger.messages.join('\n'), /already has a static called "history"/);
});

test('the plugin creates its indexes, following autoIndex', async () => {
  const schema = new mongoose.Schema({ n: Number });
  schema.plugin(auditTrail, { logger: quietLogger(), collection: 'audit_indexed' });
  const M = model(conn, 'Indexed', schema);
  await M.create({ n: 1 });
  let indexes: any[] = [];
  for (let i = 0; i < 50 && indexes.length < 3; i++) {
    indexes = await conn.db!.collection('audit_indexed').indexes();
    await new Promise((r) => setTimeout(r, 20));
  }
  const keys = indexes.map((ix) => JSON.stringify(ix.key));
  assert.ok(keys.includes(JSON.stringify({ model: 1, docId: 1, at: -1, _id: -1 })), keys.join());
  const imported = indexes.find((ix) => JSON.stringify(ix.key) === JSON.stringify({ importedFrom: 1 }));
  assert.equal(imported?.sparse, true);
});
