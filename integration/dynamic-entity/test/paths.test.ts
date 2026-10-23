// The write paths a generated edit doesn't reach on its own, each checked against
// diffEntityRecords the same way: $push and $pull, upserts, insertMany with ordered: false
// partly failing, updateMany below and above maxMany, every delete, an option renamed under the
// same $key, a migration that renames a field, and rows saved by 3.1 without a $rowId.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_TYPES, KEYED, RENAMED_V1, RENAME_MIGRATIONS, RENAMED_V2 } from '../harness/configs.ts';
import { mongoose, replicaSet } from '../harness/db.ts';
import { assertNoSecretsInAudit } from '../harness/secrets.ts';
import { fixtureOf, forStorage, modelFor, world } from '../harness/models.ts';
import { checked, entriesOf, stored } from '../harness/oracle.ts';
import { SINGLE_PATHS, write } from '../harness/paths.ts';
import { typedSchema } from '../harness/schemas.ts';

const { conn } = await replicaSet();
const w = world(mongoose, conn, { db: 'paths', plugin_options: { maxMany: 5 } });
const all = fixtureOf(ALL_TYPES.entity);
const STORAGES = ['typed', 'loose'] as const;
const oid = () => new mongoose.Types.ObjectId();

const order = (ref: string, qty: number, rowId = `row-${ref}`) => ({ $rowId: rowId, ref, qty, shade: { ...KEYED[0]! } });
const record = () => ({
  basics: { name: 'Asha', count: 3, status: 'open', colour: { ...KEYED[1]! }, secret: 'S3CR3T-path' },
  structures: { lines: [order('A', 1), order('B', 2)], address: { street: 'Main', visits: [{ $rowId: 'v1', ref: 'V1', when: '2026-01-01' }] } },
});

async function created(storage: (typeof STORAGES)[number], fixture = all, value: Record<string, unknown> = record()) {
  const model = modelFor(w, storage, fixture.config.entity);
  const id = oid();
  await checked(w, [{ model, id, fixture }], () => model.create({ _id: id, ...forStorage(storage, fixture.config.entity, value) }), { operation: 'create' });
  return { model, id, target: [{ model, id, fixture }] };
}

for (const storage of STORAGES) {
  test(`${storage}: $push and $pull rows, $set and $unset single fields`, async () => {
    const { model, id, target } = await created(storage);
    await checked(w, target, () => model.updateOne({ _id: id }, { $push: { 'structures.lines': order('C', 3) } }));
    // MongoDB can't query a field named $rowId, so a row is pulled by its ref.
    await checked(w, target, () => model.updateOne({ _id: id }, { $pull: { 'structures.lines': { ref: 'A' } } }));
    await checked(w, target, () => model.updateOne({ _id: id }, { $push: { 'structures.address.visits': { $rowId: 'v2', ref: 'V2' } } }));
    await checked(w, target, () => model.updateOne({ _id: id }, { $set: { 'structures.lines.0.qty': 9, 'basics.count': 4 }, $unset: { 'basics.status': 1 } }));
    await checked(w, target, () => model.updateOne({ _id: id }, { $inc: { 'basics.count': 1 } }));
  });

  test(`${storage}: upserts that insert are creates, every way Mongoose returns them`, async () => {
    const model = modelFor(w, storage, all.config.entity);
    const value = forStorage(storage, all.config.entity, record());
    for (const run of [
      (id: unknown) => model.updateOne({ _id: id }, { $set: value }, { upsert: true }),
      (id: unknown) => model.findOneAndUpdate({ _id: id }, { $set: value }, { upsert: true, returnDocument: 'after' }),
      (id: unknown) => model.findOneAndUpdate({ _id: id }, { $set: value }, { upsert: true, returnDocument: 'before' }),
      (id: unknown) => model.replaceOne({ _id: id }, value, { upsert: true }),
      (id: unknown) => model.findOneAndReplace({ _id: id }, value, { upsert: true, returnDocument: 'after' }),
    ]) {
      const id = oid();
      await checked(w, [{ model, id, fixture: all }], () => run(id), { operation: 'create' });
    }
    // An upsert that matches is an update.
    const { id, target } = await created(storage);
    await checked(w, target, () => model.updateOne({ _id: id }, { $set: { 'basics.name': 'Upserted' } }, { upsert: true }), { operation: 'update' });
  });

  test(`${storage}: insertMany with ordered: false partly failing records exactly the documents inserted`, async () => {
    const model = modelFor(w, storage, all.config.entity);
    const { id: taken } = await created(storage);
    const ids = [oid(), taken, oid(), oid()];
    const targets = [ids[0], ids[2], ids[3]].map((id) => ({ model, id, fixture: all }));
    await checked(w, targets, async () => {
      await assert.rejects(model.insertMany(ids.map((_id) => ({ _id, ...forStorage(storage, all.config.entity, record()) })), { ordered: false }));
    });
    // The duplicate wrote nothing and got no entry.
    assert.equal((await entriesOf(model, taken)).length, 1);
  });

  test(`${storage}: updateMany and deleteMany with many: true, below and above maxMany`, async () => {
    const model = modelFor(w, storage, all.config.entity);
    const tag = `batch-${storage}-${Date.now()}`;
    const docs = await Promise.all([1, 2, 3].map(() => created(storage, all, { ...record(), basics: { ...record().basics, name: tag } })));
    const targets = docs.map((d) => ({ model, id: d.id, fixture: all }));
    await checked(w, targets, () => model.updateMany({ 'basics.name': tag }, { $set: { 'basics.count': 42 } }));
    const errorsBefore = w.errors.length;
    const many = await Promise.all([1, 2, 3, 4, 5, 6].map(() => created(storage, all, { ...record(), basics: { ...record().basics, name: `${tag}-big` } })));
    const counts = await Promise.all(many.map((d) => entriesOf(model, d.id).then((e) => e.length)));
    const res = await model.updateMany({ 'basics.name': `${tag}-big` }, { $set: { 'basics.count': 7 } });
    assert.equal(res.modifiedCount, 6);
    assert.deepEqual(await Promise.all(many.map((d) => entriesOf(model, d.id).then((e) => e.length))), counts, 'above maxMany: no entries');
    assert.deepEqual(w.errors.slice(errorsBefore).map((e) => e.stage), ['maxMany']);
    await checked(w, targets, () => model.deleteMany({ 'basics.name': tag }), { operation: 'delete' });
  });

  test(`${storage}: every delete is checked`, async () => {
    const model = modelFor(w, storage, all.config.entity);
    for (const run of [
      (id: unknown) => model.deleteOne({ _id: id }),
      (id: unknown) => model.findOneAndDelete({ _id: id }),
      (id: unknown) => model.findByIdAndDelete(id),
      async (id: unknown) => (await model.findById(id)).deleteOne(),
    ]) {
      const { id, target } = await created(storage);
      await checked(w, target, () => run(id), { operation: 'delete' });
    }
  });

  test(`${storage}: an option renamed under the same $key is no change, through every path`, async () => {
    for (const path of SINGLE_PATHS) {
      const { model, id, target } = await created(storage);
      const now = (await stored(model, id))!;
      const renamed = structuredClone(now);
      renamed['basics'].colour = { ...renamed['basics'].colour, en: 'Leaf green', de: 'Blattgrün' };
      renamed['structures'].lines[0].shade = { ...renamed['structures'].lines[0].shade, en: 'Crimson' };
      await checked(w, target, () => write(path, model, id, now, renamed));
      assert.equal((await entriesOf(model, id)).length, 1, `${path}: only the create`);
    }
  });

  test(`${storage}: rows saved by 3.1, without a $rowId, are matched by position, as Dynamic Entity does`, async () => {
    const legacy = { structures: { lines: [{ ref: 'A', qty: 1 }, { ref: 'B', qty: 2 }, { ref: 'C', qty: 3 }] } };
    for (const path of SINGLE_PATHS) {
      const { model, id, target } = await created(storage, all, legacy);
      const now = (await stored(model, id))!;
      const edited = structuredClone(now);
      edited['structures'].lines[1].qty = 20;
      edited['structures'].lines.pop();
      await checked(w, target, () => write(path, model, id, now, edited));
    }
  });
}

test('a config version bump with a migration that renames a field: no user change, no entry', async () => {
  const renamed = fixtureOf(RENAMED_V2.entity);
  assert.equal(renamed.migrations, RENAME_MIGRATIONS);
  // Typed: a schema that holds both versions' fields, as one would during the move.
  const schema = typedSchema(mongoose, RENAMED_V2);
  schema.add({ main: { oldName: String } });
  const { auditTrail } = await import('audit-trail-text/mongoose');
  const { recordingDiff } = await import('../harness/models.ts');
  schema.plugin(auditTrail, { diff: recordingDiff(w, () => renamed), logger: { warn() {} } });
  const typed = w.conn.model('T_renamed_both', schema);
  for (const [storage, model] of [['typed', typed], ['loose', w.loose]] as const) {
    for (const path of SINGLE_PATHS) {
      const id = oid();
      const v1 = { _configVersion: RENAMED_V1.version, main: { oldName: 'Asha', n: 1 } };
      await model.create({ _id: id, ...forStorage(storage, RENAMED_V2.entity, v1) });
      const now = (await stored(model, id))!;
      const migrated = { ...now, _configVersion: RENAMED_V2.version, main: { newName: 'Asha', n: 1 } };
      await checked(w, [{ model, id, fixture: renamed }], () => write(path, model, id, now, migrated));
      assert.equal((await entriesOf(model, id)).length, 1, `${storage} ${path}: only the create`);
      // A real edit after the migration is still recorded.
      const after = (await stored(model, id))!;
      await checked(w, [{ model, id, fixture: renamed }], () => write(path, model, id, after, { ...after, main: { newName: 'Asha K', n: 1 } }));
      assert.equal((await entriesOf(model, id)).length, 2, `${storage} ${path}: the real edit`);
    }
  }
});

test('no secret reached an audit collection', async () => {
  const { entries } = await assertNoSecretsInAudit(conn);
  assert.ok(entries > 0);
});
