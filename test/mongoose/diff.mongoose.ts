// The diff option: the app computes the changes, such as Dynamic Entity's diffEntityRecords.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiffError, diffRecords, jsonSchemaAdapter } from '../../src/index.ts';
import { auditTrail } from '../../src/mongoose/index.ts';
import { database, entries, model, mongoose, quietLogger } from './helpers.ts';

const conn = await database('diff');

// Two kinds of record in one loose collection, each described by its own JSON Schema.
const adapters: Record<string, ReturnType<typeof jsonSchemaAdapter>> = {
  contact: jsonSchemaAdapter({ title: 'Contact', type: 'object', properties: { name: { type: 'string', title: 'Name' }, pin: { type: 'string', writeOnly: true } } }),
  deal: jsonSchemaAdapter({ title: 'Deal', type: 'object', properties: { amount: { type: 'number', title: 'Amount' } } }),
};

function looseModel(diff: unknown, options: Record<string, unknown> = {}) {
  const schema = new mongoose.Schema({ entity: String }, { strict: false });
  schema.plugin(auditTrail, { diff, logger: quietLogger(), ...options });
  return model(conn, 'Record', schema);
}

test('the app\'s diff gets plain JSON versions and the operation, per document, and its changes are stored', async () => {
  const calls: unknown[] = [];
  const Record = looseModel((before: any, after: any, context: unknown) => {
    calls.push({ before, after, context });
    const entity = (after ?? before).entity;
    return diffRecords(before, after, adapters[entity]!, { ignore: ['/entity'] });
  });
  const contact = await Record.create({ entity: 'contact', name: 'Asha', pin: '1234' });
  const deal = await Record.create({ entity: 'deal', amount: 100, closed: new Date('2026-10-23T00:00:00Z') });
  await Record.updateOne({ _id: contact._id }, { name: 'Asha K', pin: '9999' });
  await Record.updateOne({ _id: deal._id }, { amount: 250 });
  await Record.deleteOne({ _id: deal._id });

  const all = await entries(Record);
  assert.deepEqual(all.map((e) => e.operation), ['create', 'create', 'update', 'update', 'delete']);
  assert.deepEqual((await Record.history(contact._id)).map((h: any) => h.sentences), [['Name changed from "Asha" to "Asha K"', 'Pin changed'], ['Contact created']]);
  assert.deepEqual((await Record.history(deal._id)).map((h: any) => h.sentences), [['Deal deleted'], ['Amount changed from 100 to 250'], ['Deal created']]);
  // Plain JSON: ids as text, dates as ISO text; __v never reaches the diff.
  const created = calls[1] as { before: null; after: Record<string, unknown>; context: unknown };
  assert.equal(created.before, null);
  assert.deepEqual(created.context, { model: Record.modelName, operation: 'create' });
  assert.deepEqual(created.after, { entity: 'deal', amount: 100, closed: '2026-10-23T00:00:00.000Z', _id: String(deal._id) });
  assert.deepEqual((calls[4] as { context: unknown }).context, { model: Record.modelName, operation: 'delete' });
  assert.doesNotMatch(JSON.stringify(all), /1234|9999/);
});

test('no changes means no entry', async () => {
  const Record = looseModel(() => []);
  await Record.create({ entity: 'contact', name: 'A' });
  assert.deepEqual(await entries(Record), []);
});

test('a throwing diff, or one that returns no array, is an auditError at the diff stage; the write stands', async () => {
  const Record = looseModel((before: unknown) => {
    if (before === null) throw new DiffError('DUPLICATE_KEY', '/rows', 'two rows share the key "r1"');
    return 'not changes';
  });
  const errors: any[] = [];
  Record.on('auditError', (e: any) => errors.push(e));
  const doc = await Record.create({ entity: 'contact', name: 'A' });
  const res = await Record.updateOne({ _id: doc._id }, { name: 'B' });
  assert.equal(res.modifiedCount, 1);
  assert.deepEqual(errors.map((e) => [e.stage, e.operation]), [['diff', 'create'], ['diff', 'update']]);
  assert.equal(errors[0].error.code, 'DUPLICATE_KEY');
  assert.equal((await Record.findById(doc._id)).name, 'B');
  assert.deepEqual(await entries(Record), []);
});

test('snapshots come from the diff\'s own RECORD_DELETED, so they are stripped the same way', async () => {
  const Record = looseModel((before: any, after: any) => diffRecords(before, after, adapters['contact']!, { ignore: ['/entity'] }), { snapshots: true });
  const doc = await Record.create({ entity: 'contact', name: 'A', pin: 'secret-pin' });
  await Record.updateOne({ _id: doc._id }, { name: 'B' });
  const [, update] = await entries(Record);
  assert.deepEqual(update!.snapshot, { name: 'A', _id: String(doc._id) });
});

test('diff must be a function', () => {
  const schema = new mongoose.Schema({ n: Number });
  assert.throws(() => schema.plugin(auditTrail, { diff: 'diffEntityRecords' } as any), (e: unknown) => e instanceof DiffError && e.code === 'INVALID_OPTION');
});
