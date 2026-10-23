// The plugin must never change what the app stores or sees. The same generated workload runs
// against two databases, plugin off and plugin on (with and without background: true): every
// write must return the same result, and every stored document must be the same bytes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { auditFlush } from 'audit-trail-text/mongoose';
import { recordArb } from '../harness/arbitraries.ts';
import { ALL_TYPES } from '../harness/configs.ts';
import { mongoose, replicaSet } from '../harness/db.ts';
import { assertNoSecretsInAudit } from '../harness/secrets.ts';
import { fixtureOf, forStorage, modelFor, world } from '../harness/models.ts';
import type { World } from '../harness/models.ts';
import { stored } from '../harness/oracle.ts';
import { SINGLE_PATHS, summary, write } from '../harness/paths.ts';
import { recordShape } from '../harness/shape.ts';

const RUNS = Number(process.env['DE_OFFON_RUNS'] ?? 25);
const { conn } = await replicaSet();
const { BSON } = mongoose.mongo;
const ENTITIES = [ALL_TYPES.entity, 'insuranceClaims', 'complexFullTest', 'masked'];
const STORAGES = ['typed', 'loose'] as const;

const hexId = fc.uint8Array({ minLength: 12, maxLength: 12 }).map((b) => Buffer.from(b).toString('hex'));
const where = fc.record({ storage: fc.constantFrom(...STORAGES), entity: fc.constantFrom(...ENTITIES) });
const recordFor = (entity: string) => recordArb(recordShape(fixtureOf(entity).config));

type Op =
  | { kind: 'create'; storage: (typeof STORAGES)[number]; entity: string; id: string; record: Record<string, unknown> }
  | { kind: 'edit'; pick: number; path: (typeof SINGLE_PATHS)[number]; next: Record<string, unknown>; keep: number }
  | { kind: 'insertMany'; storage: (typeof STORAGES)[number]; entity: string; ids: string[]; records: Record<string, unknown>[]; duplicate: boolean }
  | { kind: 'updateMany'; storage: (typeof STORAGES)[number]; entity: string; value: number }
  | { kind: 'upsert'; storage: (typeof STORAGES)[number]; entity: string; id: string; record: Record<string, unknown>; how: number }
  | { kind: 'delete'; pick: number; how: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: where.chain(({ storage, entity }) => fc.record({ kind: fc.constant('create' as const), storage: fc.constant(storage), entity: fc.constant(entity), id: hexId, record: recordFor(entity) })) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('edit' as const), pick: fc.nat(), path: fc.constantFrom(...SINGLE_PATHS), next: recordFor(ALL_TYPES.entity), keep: fc.nat() }) },
  { weight: 1, arbitrary: where.chain(({ storage, entity }) => fc.record({ kind: fc.constant('insertMany' as const), storage: fc.constant(storage), entity: fc.constant(entity), ids: fc.array(hexId, { minLength: 1, maxLength: 3 }), records: fc.array(recordFor(entity), { minLength: 3, maxLength: 3 }), duplicate: fc.boolean() })) },
  { weight: 1, arbitrary: where.chain(({ storage, entity }) => fc.record({ kind: fc.constant('updateMany' as const), storage: fc.constant(storage), entity: fc.constant(entity), value: fc.integer({ min: 0, max: 99 }) })) },
  { weight: 1, arbitrary: where.chain(({ storage, entity }) => fc.record({ kind: fc.constant('upsert' as const), storage: fc.constant(storage), entity: fc.constant(entity), id: hexId, record: recordFor(entity), how: fc.nat(2) })) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick: fc.nat(), how: fc.nat(3) }) },
);

/** A result or error as plain data. */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return summary(await run());
  } catch (e: any) {
    return { error: e?.name, code: e?.code, inserted: e?.insertedDocs?.length };
  }
}

/** Runs a program against one world; returns every write's outcome. */
async function play(w: World, program: Op[]): Promise<unknown[]> {
  const docs: { storage: (typeof STORAGES)[number]; entity: string; id: any }[] = [];
  const out: unknown[] = [];
  const oid = (hex: string) => new mongoose.Types.ObjectId(hex);
  for (const o of program) {
    if (o.kind === 'create') {
      const model = modelFor(w, o.storage, o.entity);
      out.push(await outcome(() => model.create({ _id: oid(o.id), ...forStorage(o.storage, o.entity, o.record) })));
      docs.push({ storage: o.storage, entity: o.entity, id: oid(o.id) });
    } else if (o.kind === 'edit' || o.kind === 'delete') {
      if (docs.length === 0) continue;
      const d = docs[o.pick % docs.length]!;
      const model = modelFor(w, d.storage, d.entity);
      const now = await stored(model, d.id);
      if (!now) continue;
      if (o.kind === 'delete') {
        const how = [
          () => model.deleteOne({ _id: d.id }),
          () => model.findOneAndDelete({ _id: d.id }),
          async () => (await model.findById(d.id))?.deleteOne(),
          () => model.deleteMany({ _id: d.id }),
        ][o.how]!;
        out.push(await outcome(how));
        continue;
      }
      // The edit: some top-level keys kept, others taken from a fresh record (only for allTypes
      // records, whose keys it has), so both databases get exactly the same change.
      const after: Record<string, unknown> = { ...now };
      if (d.entity === ALL_TYPES.entity) {
        Object.keys(o.next).forEach((key, i) => {
          if (!((o.keep >> i) & 1)) after[key] = o.next[key];
        });
      }
      out.push(await outcome(() => write(o.path, model, d.id, now, after)));
    } else if (o.kind === 'insertMany') {
      const model = modelFor(w, o.storage, o.entity);
      const ids = o.ids.map(oid);
      if (o.duplicate && docs.length > 0) ids.push(docs[0]!.id);
      const batch = ids.map((_id, i) => ({ _id, ...forStorage(o.storage, o.entity, o.records[i % o.records.length]!) }));
      out.push(await outcome(() => model.insertMany(batch, { ordered: false })));
      for (const id of ids) docs.push({ storage: o.storage, entity: o.entity, id });
    } else if (o.kind === 'updateMany') {
      const model = modelFor(w, o.storage, o.entity);
      const filter = o.storage === 'loose' ? { entity: o.entity } : {};
      out.push(await outcome(() => model.updateMany(filter, { $set: { _configVersion: o.value } })));
    } else {
      const model = modelFor(w, o.storage, o.entity);
      const value = forStorage(o.storage, o.entity, o.record);
      const how = [
        () => model.updateOne({ _id: oid(o.id) }, { $set: value }, { upsert: true }),
        () => model.findOneAndUpdate({ _id: oid(o.id) }, { $set: value }, { upsert: true, returnDocument: 'after' }),
        () => model.replaceOne({ _id: oid(o.id) }, value, { upsert: true }),
      ][o.how]!;
      out.push(await outcome(how));
      docs.push({ storage: o.storage, entity: o.entity, id: oid(o.id) });
    }
  }
  await auditFlush();
  return out;
}

/** Every stored record, as BSON bytes, by collection. */
async function bytes(w: World): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const model of [...w.typed.values(), w.loose]) {
    const docs = await w.conn.db!.collection(model.collection.collectionName).find({}).sort({ _id: 1 }).toArray();
    out.set(model.collection.collectionName, docs.map((d) => Buffer.from(BSON.serialize(d)).toString('hex')));
  }
  return out;
}

const clock = () => {
  let t = Date.UTC(2026, 0, 1);
  return () => new Date((t += 1000));
};

let pair = 0;
for (const background of [false, true]) {
  test(`plugin off and on${background ? ', background: true,' : ''} store the same bytes and return the same results`, async () => {
    let audited = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (program) => {
        pair++;
        const off = world(mongoose, conn, { plugin: false, db: `off${pair}`, clock: clock() });
        const on = world(mongoose, conn, { plugin: true, db: `on${pair}`, clock: clock(), plugin_options: { maxMany: 3, background } });
        const offResults = await play(off, program);
        const onResults = await play(on, program);
        assert.deepEqual(onResults, offResults, 'write results differ');
        assert.deepEqual(await bytes(on), await bytes(off), 'stored bytes differ');
        audited += await on.conn.db!.collection('audit_trail').countDocuments();
      }),
      { numRuns: RUNS, seed: background ? 1303 : 1302 },
    );
    assert.ok(audited > RUNS, `the plugin recorded ${audited} entries across ${RUNS} programs`);
  });
}

test('no secret reached an audit collection', async () => {
  const { entries } = await assertNoSecretsInAudit(conn);
  assert.ok(entries > 0);
});
