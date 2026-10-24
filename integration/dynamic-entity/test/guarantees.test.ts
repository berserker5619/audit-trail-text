// The hard guarantees, each with its own test: transactions (with fail points), concurrency,
// never blocking (fail points and injected faults), history paging, changes stored by 1.2, and
// no secret value anywhere in the audit collection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeEntityChanges, entitySchema } from '@dynamic-entity/core/history';
import { auditContext, auditFlush, auditTrail } from 'audit-trail-text/mongoose';
import * as v12 from 'audit-trail-text-1.2';
import { ALL_TYPES, KEYED, MASKED_ROWS } from '../harness/configs.ts';
import type { Fixture } from '../harness/configs.ts';
import { failPoint, mongoose, replicaSet } from '../harness/db.ts';
import { fixtureOf, forStorage, modelFor, recordingDiff, world } from '../harness/models.ts';
import { checked, entriesOf, stored } from '../harness/oracle.ts';
import { assertNoSecretsInAudit } from '../harness/secrets.ts';
import { typedLabels, typedSchema } from '../harness/schemas.ts';

const { conn } = await replicaSet();
const all = fixtureOf(ALL_TYPES.entity);
const STORAGES = ['typed', 'loose'] as const;
const oid = () => new mongoose.Types.ObjectId();
const record = (name = 'Asha') => ({
  basics: { name, count: 1, secret: 'S3CR3T-guarantee', privateNote: 'S3CR3T-note', colour: { ...KEYED[0]! } },
  structures: { lines: [{ $rowId: 'r1', ref: 'A', qty: 1 }] },
  vault: { pin: 'S3CR3T-pin', vaultCount: 7_000_000_042 },
});

// ---------------------------------------------------------------- transactions

const tx = world(mongoose, conn, { db: 'transactions' });
for (const model of [...tx.typed.values(), tx.loose]) await model.createCollection();

for (const storage of STORAGES) {
  const model = modelFor(tx, storage, all.config.entity);
  const value = (name?: string) => forStorage(storage, all.config.entity, record(name));

  test(`${storage}: a committed transaction leaves exactly one entry per write, written after the commit`, async () => {
    const [a, b, c] = [oid(), oid(), oid()];
    await model.create([{ _id: b, ...value('B') }, { _id: c, ...value('C') }]);
    const targets = [a, b, c].map((id) => ({ model, id, fixture: all }));
    const session = await tx.conn.startSession();
    await checked(tx, targets, async () => {
      session.startTransaction();
      await model.create([{ _id: a, ...value('A') }], { session });
      await model.updateOne({ _id: b }, { $set: { 'basics.name': 'B2' } }, { session });
      await model.deleteOne({ _id: c }, { session });
      assert.equal((await entriesOf(model, a)).length, 0, 'nothing is written before the commit');
      await session.commitTransaction();
    });
    await session.endSession();
  });

  test(`${storage}: an aborted transaction leaves no entry`, async () => {
    const id = oid();
    await model.create({ _id: id, ...value() });
    const before = (await entriesOf(model, id)).length;
    const session = await tx.conn.startSession();
    session.startTransaction();
    await model.updateOne({ _id: id }, { $set: { 'basics.name': 'Never' } }, { session });
    await model.create([{ _id: oid(), ...value('Never') }], { session });
    await session.abortTransaction();
    await session.endSession();
    await auditFlush();
    assert.equal((await entriesOf(model, id)).length, before);
    assert.equal(await tx.conn.db!.collection('audit_trail').countDocuments({ 'changes.after.basics.name': 'Never' }), 0);
  });

  test(`${storage}: withTransaction retries forced by a TransientTransactionError fail point give no duplicates`, async () => {
    const id = oid();
    await model.create({ _id: id, ...value() });
    const target = [{ model, id, fixture: all }];
    let attempts = 0;
    const off = await failPoint(tx.conn, { times: 1 }, { failCommands: ['update'], errorCode: 112, errorLabels: ['TransientTransactionError'] });
    try {
      const session = await tx.conn.startSession();
      await checked(tx, target, () =>
        session.withTransaction(async () => {
          attempts++;
          await model.updateOne({ _id: id }, { $set: { 'basics.name': `Attempt ${attempts}` } }, { session });
        }),
      );
      await session.endSession();
    } finally {
      await off();
    }
    assert.equal(attempts, 2);
    const updates = (await entriesOf(model, id)).filter((e) => e.operation === 'update');
    assert.equal(updates.length, 1);
    assert.equal(JSON.stringify(updates[0]!.changes).includes('Attempt 2'), true);
  });

  test(`${storage}: a retried commit (UnknownTransactionCommitResult) writes its entries once`, async () => {
    const id = oid();
    await model.create({ _id: id, ...value() });
    const off = await failPoint(tx.conn, { times: 1 }, { failCommands: ['commitTransaction'], errorCode: 91, errorLabels: ['UnknownTransactionCommitResult'] });
    try {
      const session = await tx.conn.startSession();
      await checked(tx, [{ model, id, fixture: all }], () =>
        session.withTransaction(async () => {
          await model.updateOne({ _id: id }, { $set: { 'basics.count': 99 } }, { session });
        }),
      );
      await session.endSession();
    } finally {
      await off();
    }
  });
}

// ---------------------------------------------------------------- concurrency

type Path = 'updateOne' | 'findOneAndUpdateBefore' | 'findOneAndUpdateAfter' | 'save';

/**
 * 50 writers with their own users, 3 writes each, over 10 overlapping records. Each write sets a
 * name no other write uses, so its entry can be found. Returns the writes whose entry, holding
 * their own name, is attributed to another user, and the writes with no entry at all.
 */
let concurrentRuns = 0;

async function concurrent(storage: (typeof STORAGES)[number], paths: Path[], inTransaction: boolean) {
  const w = world(mongoose, conn, { db: `conc-${storage}-${inTransaction ? "tx" : "notx"}-${++concurrentRuns}` });
  const model = modelFor(w, storage, all.config.entity);
  await model.createCollection();
  const ids = Array.from({ length: 10 }, oid);
  await model.insertMany(ids.map((_id) => ({ _id, ...forStorage(storage, all.config.entity, record()) })));
  const writes: { user: string; name: string; path: Path }[] = [];
  const once = async (id: unknown, name: string, path: Path, session?: unknown) => {
    const options = session ? { session } : {};
    if (path === 'updateOne') await model.updateOne({ _id: id }, { $set: { 'basics.name': name } }, options);
    else if (path === 'findOneAndUpdateBefore') await model.findOneAndUpdate({ _id: id }, { $set: { 'basics.name': name } }, { ...options, returnDocument: 'before' });
    else if (path === 'findOneAndUpdateAfter') await model.findOneAndUpdate({ _id: id }, { $set: { 'basics.name': name } }, { ...options, returnDocument: 'after' });
    else {
      const doc = await model.findById(id).session(session ?? null);
      doc.set('basics.name', name);
      await doc.save();
    }
  };
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      auditContext.run({ user: `u${i}` }, async () => {
        for (let k = 0; k < 3; k++) {
          const id = ids[(i * 7 + k * 3) % ids.length];
          const name = `w${i}-${k}`;
          const path = paths[(i + k) % paths.length]!;
          if (inTransaction) {
            const session = await w.conn.startSession();
            await session.withTransaction(() => once(id, name, path, session));
            await session.endSession();
          } else {
            await once(id, name, path);
          }
          writes.push({ user: `u${i}`, name, path });
        }
      }),
    ),
  );
  await auditFlush();
  const entries = await w.conn.db!.collection('audit_trail').find({ docId: { $in: ids }, operation: 'update' }).toArray();
  const nameIn = (e: any) => e.changes.find((c: any) => c.labels.at(-1) === 'Name')?.after;
  // A write is attributed when an entry under its own user holds its name. A write whose entry
  // shows another writer's name instead is not.
  const owners = new Map<string, unknown[]>();
  for (const e of entries) owners.set(nameIn(e), [...(owners.get(nameIn(e)) ?? []), e.user]);
  const unattributed = writes.filter((x) => !(owners.get(x.name) ?? []).includes(x.user));
  return {
    entries: entries.length,
    unattributed: unattributed.map((x) => `${x.name} by ${x.user}; entries holding it are under ${JSON.stringify(owners.get(x.name) ?? [])}`),
    rate: (path: Path) => `${unattributed.filter((x) => x.path === path).length} of ${writes.filter((x) => x.path === path).length}`,
  };
}

const ALL_PATHS: Path[] = ['updateOne', 'findOneAndUpdateBefore', 'findOneAndUpdateAfter', 'save'];

for (const storage of STORAGES) {
  test(`${storage}: 50 concurrent writers in transactions, through every path: every entry has its writer, none missing`, async () => {
    const r = await concurrent(storage, ALL_PATHS, true);
    assert.equal(r.entries, 150);
    assert.deepEqual(r.unattributed, []);
  });

  test(`${storage}: 50 concurrent writers outside transactions: every write has an entry; how many are misattributed, by path`, async (t) => {
    // Outside a transaction, a write's after value (or, on Mongoose 7, a save's) is read after
    // the write, so another writer's change in between shows in this entry under this writer:
    // see "Concurrent writes" in the README. The rate is reported, not asserted.
    const r = await concurrent(storage, ALL_PATHS, false);
    assert.equal(r.entries, 150, 'every committed write has an entry');
    for (const path of ALL_PATHS) t.diagnostic(`${path}: ${r.rate(path)} writes not attributed to their writer`);
  });
}

// ---------------------------------------------------------------- never blocks

/** The same write with the plugin off, for the result to compare with. */
const plain = world(mongoose, conn, { db: 'never-blocks-off', plugin: false });

async function sameResult(storage: (typeof STORAGES)[number], run: (model: any, id: unknown) => Promise<unknown>, w: ReturnType<typeof world>, seed: Record<string, unknown> = record()) {
  const id = oid();
  const on = modelFor(w, storage, all.config.entity);
  const off = modelFor(plain, storage, all.config.entity);
  await on.create({ _id: id, ...forStorage(storage, all.config.entity, seed) });
  await off.create({ _id: id, ...forStorage(storage, all.config.entity, seed) });
  const strip = (r: unknown) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'updatedAt' || k === 'createdAt' ? undefined : v)));
  const a = strip(await run(on, id));
  const b = strip(await run(off, id));
  assert.deepEqual(a, b, 'the write result differs from the plugin-off result');
  const docOn = await stored(on, id);
  const docOff = await stored(off, id);
  const clean = (d: any) => (d ? { ...d, updatedAt: undefined, createdAt: undefined } : d);
  assert.deepEqual(clean(docOn), clean(docOff), 'the stored document differs from the plugin-off one');
  return id;
}

for (const storage of STORAGES) {
  test(`${storage}: audit insert errors (fail point): the write succeeds as usual, auditError at "write" with the entry`, async () => {
    const w = world(mongoose, conn, { db: `nb-insert-${storage}` });
    const ns = `nb-insert-${storage}.audit_trail`;
    const off = await failPoint(w.conn, 'alwaysOn', { failCommands: ['insert'], errorCode: 2, namespace: ns } as any);
    try {
      await sameResult(storage, (m, id) => m.updateOne({ _id: id }, { $set: { 'basics.name': 'X' } }), w);
    } finally {
      await off();
    }
    const stages = w.errors.map((e) => e.stage);
    assert.ok(stages.length >= 2 && stages.every((s) => s === 'write'), stages.join());
    assert.ok(w.errors.every((e) => e.entry && e.entry.changes.length > 0));
  });

  test(`${storage}: a slow audit write past auditTimeoutMS (fail point): at most the budget added, auditError at "write"`, async () => {
    const w = world(mongoose, conn, { db: `nb-slow-${storage}`, plugin_options: { auditTimeoutMS: 200 } });
    const off = await failPoint(w.conn, 'alwaysOn', { failCommands: ['insert'], blockConnection: true, blockTimeMS: 2000, namespace: `nb-slow-${storage}.audit_trail` } as any);
    let took = 0;
    try {
      await sameResult(storage, async (m, id) => {
        const t = Date.now();
        const r = await m.updateOne({ _id: id }, { $set: { 'basics.name': 'Slow' } });
        if (m.db === w.conn) took = Date.now() - t;
        return r;
      }, w);
    } finally {
      await off();
    }
    assert.ok(took < 1000, `the write took ${took} ms`);
    assert.ok(w.errors.some((e) => e.stage === 'write' && (e.error as Error).name === 'AuditTimeoutError'));
  });

  test(`${storage}: a duplicate $rowId: the write succeeds, auditError at "diff" with DUPLICATE_KEY`, async () => {
    const w = world(mongoose, conn, { db: `nb-dup-${storage}` });
    await sameResult(storage, (m, id) => m.updateOne({ _id: id }, { $push: { 'structures.lines': { $rowId: 'r1', ref: 'Again' } } }), w);
    // The diff's error; under load, a setup write's audit write may also time out, unrelated.
    assert.deepEqual(w.errors.filter((e) => e.stage !== 'write').map((e) => [e.stage, (e.error as any).code]), [['diff', 'DUPLICATE_KEY']]);
  });

  test(`${storage}: a non-JSON value (NaN): the write succeeds, auditError at "diff" with NOT_JSON`, async () => {
    const w = world(mongoose, conn, { db: `nb-nan-${storage}` });
    // On a Mixed path: a typed Number path refuses NaN itself, plugin or not.
    await sameResult(storage, (m, id) => m.updateOne({ _id: id }, { $set: { 'basics.doc': { url: 'http://a.example', name: 'x', size: Number.NaN } } }), w);
    // The diff's error; under load, a setup write's audit write may also time out, unrelated.
    assert.deepEqual(w.errors.filter((e) => e.stage !== 'write').map((e) => [e.stage, (e.error as any).code]), [['diff', 'NOT_JSON']]);
  });

  test(`${storage}: a too-deep record: the write succeeds, auditError at "diff" with TOO_DEEP`, async () => {
    const w = world(mongoose, conn, { db: `nb-deep-${storage}` });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i++) deep = { d: deep };
    // A file value is Mixed in the typed schema, and anything goes in the loose one.
    await sameResult(storage, (m, id) => m.updateOne({ _id: id }, { $set: { 'basics.doc': { url: 'http://a.example', name: 'x', deep } } }), w);
    // The diff's error; under load, a setup write's audit write may also time out, unrelated.
    assert.deepEqual(w.errors.filter((e) => e.stage !== 'write').map((e) => [e.stage, (e.error as any).code]), [['diff', 'TOO_DEEP']]);
  });
}

test('a broken schema: a list the Mongoose schema can\'t key is logged once at startup; the model works', async () => {
  const warnings: string[] = [];
  const schema = typedSchema(mongoose, ALL_TYPES);
  // No #key for the lists: the adapter built from the Mongoose schema refuses them.
  schema.plugin(auditTrail, { logger: { warn: (m: string) => void warnings.push(m) } });
  const m = conn.useDb('nb-broken').model('T_broken', schema);
  assert.ok(warnings.length >= 1 && warnings.every((x) => x.includes('is recorded as one whole value')), warnings.join('\n'));
  const count = warnings.length;
  const id = oid();
  await m.create({ _id: id, ...record() });
  await m.updateOne({ _id: id }, { $set: { 'structures.lines': [] } });
  assert.equal((await entriesOf(m, id)).length, 2);
  assert.equal(warnings.length, count, 'logged once, at startup');
});

test('a broken Dynamic Entity config (rows on a maskData tab, refused by entityAuditAdapter): writes succeed, auditError at "diff"', async () => {
  const fixture: Fixture = { config: MASKED_ROWS, seeds: [], migrations: [] };
  const w = world(mongoose, conn, { db: 'nb-masked-rows', fixtures: [] });
  const schema = typedSchema(mongoose, MASKED_ROWS);
  schema.plugin(auditTrail, { diff: recordingDiff(w, () => fixture), labels: typedLabels(MASKED_ROWS), logger: { warn() {} } });
  const m = w.conn.model('T_maskedRows', schema);
  const errors: any[] = [];
  m.on('auditError', (e: any) => errors.push(e));
  const doc = await m.create({ vault: { codes: [{ $rowId: 'r1', ref: 'S3CR3T-row' }] } });
  const res = await m.updateOne({ _id: doc._id }, { $set: { 'vault.codes': [] } });
  assert.equal(res.modifiedCount, 1);
  assert.deepEqual(errors.map((e) => [e.stage, e.error.code]), [['diff', 'SENSITIVE_KEY'], ['diff', 'SENSITIVE_KEY']]);
});

test('without a listener, repeated failures log once a minute per model', async () => {
  const warnings: string[] = [];
  const schema = typedSchema(mongoose, ALL_TYPES);
  schema.plugin(auditTrail, { diff: () => { throw new Error('diff broke'); }, labels: typedLabels(ALL_TYPES), logger: { warn: (m: string) => void warnings.push(m) } });
  const m = conn.useDb('nb-throttle').model('T_throttle', schema);
  for (let i = 0; i < 20; i++) await m.create({ basics: { name: String(i) } });
  assert.equal(await m.countDocuments(), 20);
  assert.equal(warnings.filter((x) => x.includes('diff failed')).length, 1);
});

// ---------------------------------------------------------------- history

test('500 entries sharing one `at` page through with none skipped or repeated', async () => {
  const w = world(mongoose, conn, { db: 'history' });
  const model = w.typed.get(all.config.entity);
  const id = oid();
  await model.create({ _id: id, ...record() });
  const at = new Date('2020-01-01T00:00:00Z');
  const change = (i: number) => ({ code: 'FIELD_CHANGED', labels: ['Basics', 'Count'], before: i, after: i + 1, display: { type: 'number' }, inSchema: true });
  await w.conn.db!.collection('audit_trail').insertMany(Array.from({ length: 500 }, (_, i) => ({ model: model.modelName, docId: id, operation: 'update', at, changes: [change(i)], v: 1 })));
  const seen: string[] = [];
  let after: unknown;
  for (let page = 0; page < 100; page++) {
    const entries = await model.history(id, { limit: 37, after, language: 'de' });
    if (entries.length === 0) break;
    seen.push(...entries.map((e: any) => String(e._id)));
    after = entries.at(-1)._id;
  }
  assert.equal(seen.length, 501);
  assert.equal(new Set(seen).size, 501);
});

test('changes stored by 1.2 (Dynamic Entity 3.3.1 with the published audit-trail-text) still read the same', async () => {
  const w = world(mongoose, conn, { db: 'stored-v12' });
  const model = w.typed.get(all.config.entity);
  const id = oid();
  const adapter = v12.jsonSchemaAdapter(entitySchema(ALL_TYPES));
  const before = { basics: { name: 'Asha', count: 1200, status: 'open', colour: { ...KEYED[0]! }, day: '2026-01-02', secret: 'x' }, structures: { lines: [{ $rowId: 'r1', ref: 'A', qty: 1, parts: [{ $rowId: 'p1', ref: 'Sleeve', count: 2 }] }] } };
  const after = { basics: { name: 'Asha K', count: 1500.5, status: 'paid', colour: { ...KEYED[2]! }, day: '2026-02-03', secret: 'y' }, structures: { lines: [{ $rowId: 'r1', ref: 'A', qty: 3, parts: [{ $rowId: 'p1', ref: 'Sleeve', count: 5 }] }, { $rowId: 'r2', ref: 'B' }] } };
  const changes = JSON.parse(JSON.stringify(v12.diffRecords(before, after, adapter)));
  await w.conn.db!.collection('audit_trail').insertOne({ model: model.modelName, docId: id, operation: 'update', at: new Date(), changes, v: 1 });
  for (const language of ['en', 'de']) {
    const [entry] = await model.history(id, { language });
    const by12 = v12.describe(changes, { language }).map((s: { text: string }) => s.text);
    assert.deepEqual(entry.sentences, by12);
    assert.deepEqual(entry.sentences, describeEntityChanges(changes, { config: ALL_TYPES, language }).map((s) => s.text));
  }
});

// ---------------------------------------------------------------- secrets

test('after the whole run: no value written to a password or maskData field appears anywhere in an audit collection', async () => {
  const { entries, secretsInRecords } = await assertNoSecretsInAudit(conn);
  assert.ok(entries > 100, `scanned ${entries} entries`);
  assert.ok(secretsInRecords > 10, `the records hold ${secretsInRecords} secret values, so the scan had something to find`);
});
