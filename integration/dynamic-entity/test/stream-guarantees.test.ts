// Stream mode's guarantees, each with its own test: the 50-writer headline run, a stale
// who-field, writes outside Mongoose, transactions, plugin off versus on, expired images,
// crashes, failover with fencing, resume gaps, large documents, never blocking, and no secret in
// any entry, context record or gap.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditContext, auditTrail, startAuditWatcher } from 'audit-trail-text/mongoose';
import { ALL_TYPES, KEYED } from '../harness/configs.ts';
import { failPoint, major, mongoose, replicaSet } from '../harness/db.ts';
import { fixtureOf, forStorage, modelFor, oracle, streamWorld, world } from '../harness/models.ts';
import type { World } from '../harness/models.ts';
import { clean, json, stored } from '../harness/oracle.ts';
import { assertNoSecretsInAudit } from '../harness/secrets.ts';
import { typedSchema } from '../harness/schemas.ts';

const { uri, conn } = await replicaSet();
const all = fixtureOf(ALL_TYPES.entity);
const STORAGES = ['typed', 'loose'] as const;
const oid = () => new mongoose.Types.ObjectId();
const worlds: World[] = [];
after(async () => {
  for (const w of worlds) await w.watcher?.stop();
});
const record = (name = 'Asha') => ({
  basics: { name, count: 1, secret: 'S3CR3T-stream', privateNote: 'S3CR3T-note', colour: { ...KEYED[0]! } },
  structures: { lines: [{ $rowId: 'r1', ref: 'A', qty: 1 }] },
  vault: { pin: 'S3CR3T-pin', vaultCount: 7_000_000_077 },
});
async function stream(db: string, options: Parameters<typeof streamWorld>[2] = {}): Promise<World> {
  const w = await streamWorld(mongoose, conn, { db, ...options });
  worlds.push(w);
  return w;
}
const audit = (w: World) => w.conn.db!.collection('audit_trail');
const nameIn = (e: any) => e.changes.find((c: any) => c.labels.at(-1) === 'Name');

// ---------------------------------------------------------------- the headline test

test(`the headline: 50 concurrent writers, no transactions, every write path${major >= 8 ? ' including bulkWrite' : ''}; with a who-field, zero misattributions and the exact change every time`, async (t) => {
  for (const storage of STORAGES) {
    const w = await stream(`headline-${storage}`);
    const model = modelFor(w, storage, all.config.entity);
    const ids = Array.from({ length: 10 }, oid);
    await model.insertMany(ids.map((_id) => ({ _id, ...forStorage(storage, all.config.entity, record()) })));
    const paths = ['updateOne', 'findOneAndUpdateBefore', 'findOneAndUpdateAfter', 'save', 'replaceOne', 'updateMany', ...(major >= 8 ? ['bulkWrite'] : [])];
    const writes: { id: unknown; user: string; name: string; path: string }[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        auditContext.run({ user: `u${i}` }, async () => {
          for (let k = 0; k < 3; k++) {
            const id = ids[(i * 7 + k * 3) % ids.length]!;
            const name = `w${i}-${k}`;
            const path = paths[(i + k) % paths.length]!;
            const set = { 'basics.name': name };
            if (path === 'updateOne') await model.updateOne({ _id: id }, { $set: set });
            else if (path === 'findOneAndUpdateBefore') await model.findOneAndUpdate({ _id: id }, { $set: set });
            else if (path === 'findOneAndUpdateAfter') await model.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
            else if (path === 'updateMany') await model.updateMany({ _id: id }, { $set: set });
            else if (path === 'bulkWrite') await model.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: set } } }]);
            else if (path === 'replaceOne') {
              const now = (await model.findById(id).lean()) as any;
              const { _id, __v, createdAt, updatedAt, _audit, ...rest } = now;
              await model.replaceOne({ _id: id }, { ...rest, basics: { ...rest.basics, name } });
            } else {
              const doc = await model.findById(id);
              doc.set('basics.name', name);
              await doc.save();
            }
            writes.push({ id, user: `u${i}`, name, path });
          }
        }),
      ),
    );
    await w.settle();
    const entries = await audit(w).find({ docId: { $in: ids }, operation: 'update' }).sort({ _id: 1 }).toArray();
    assert.equal(entries.length, 150, `${storage}: one entry per write`);
    const byName = new Map(entries.map((e) => [nameIn(e)?.after, e]));
    const wrong = writes.filter((x) => byName.get(x.name)?.user !== x.user);
    assert.deepEqual(wrong.map((x) => `${x.path}: ${x.name} by ${x.user}, entry says ${byName.get(x.name)?.user}`), [], `${storage}: misattributions`);
    // The exact change: per document, each entry starts where the one before it ended, and the
    // last ends at what is stored.
    for (const id of ids) {
      const mine = entries.filter((e) => String(e.docId) === String(id));
      let previous = 'Asha';
      for (const e of mine) {
        assert.deepEqual(e.changes.map((c: any) => c.labels.at(-1)), ['Name'], `${storage}: only the name changed`);
        assert.equal(nameIn(e).before, previous, `${storage} ${String(id)}: entries chain`);
        previous = nameIn(e).after;
      }
      assert.equal(previous, ((await model.findById(id).lean()) as any).basics.name);
    }
    t.diagnostic(`${storage}: 150 of 150 writes attributed to their writer, through ${paths.join(', ')}`);
  }
});

test('a stale who-field: a raw driver write between two plugin writes has no user, never the previous writer\'s', async () => {
  const w = await stream('stale');
  const model = modelFor(w, 'typed', all.config.entity);
  const doc = await auditContext.run({ user: 'u_first' }, () => model.create(record()));
  await model.collection.updateOne({ _id: doc._id }, { $set: { 'basics.count': 2 } }); // keeps _audit as it was
  await auditContext.run({ user: 'u_third' }, () => model.updateOne({ _id: doc._id }, { $set: { 'basics.count': 3 } }));
  await w.settle();
  const entries = await audit(w).find({ docId: doc._id }).sort({ _id: 1 }).toArray();
  assert.deepEqual(entries.map((e) => [e.operation, e.user ?? null]), [['create', 'u_first'], ['update', null], ['update', 'u_third']]);
});

test('writes outside Mongoose: the plain driver, bulkWrite and a raw updateMany are recorded exactly, with a user only when the who-field is set by hand', async () => {
  const w = await stream('outside');
  const model = modelFor(w, 'loose', all.config.entity);
  const raw = model.collection;
  const [a, b, c] = [oid(), oid(), oid()];
  await raw.insertOne({ _id: a, ...forStorage('loose', all.config.entity, record('A')) });
  await raw.bulkWrite([{ insertOne: { document: { _id: b, ...forStorage('loose', all.config.entity, record('B')) } } }, { updateOne: { filter: { _id: a }, update: { $set: { 'basics.count': 5 } } } }]);
  await raw.updateMany({ _id: { $in: [a, b] } }, { $set: { 'basics.name': 'Bulk' } });
  await raw.insertOne({ _id: c, ...forStorage('loose', all.config.entity, record('C')), _audit: { user: 'u_script', writeId: 'script-1' } });
  const befores = new Map<string, any>();
  for (const id of [a, b]) befores.set(String(id), clean(await stored(model, id), '_audit'));
  await raw.updateOne({ _id: b }, { $set: { 'basics.count': 9, _audit: { user: 'u_script', writeId: 'script-2' } } });
  await w.settle();
  const entries = await audit(w).find({ docId: { $in: [a, b, c] } }).sort({ _id: 1 }).toArray();
  assert.deepEqual(entries.map((e) => [String(e.docId), e.operation, e.user ?? null]), [
    [String(a), 'create', null], [String(b), 'create', null], [String(a), 'update', null], [String(a), 'update', null], [String(b), 'update', null], [String(c), 'create', 'u_script'], [String(b), 'update', 'u_script'],
  ]);
  const last = entries.at(-1)!;
  const now = clean(await stored(model, b), '_audit');
  assert.deepEqual(json(last.changes), json(oracle(all, befores.get(String(b)), now)));
});

test('transactions: context matches by lsid and txnNumber, deletes included; a failed or late context gives no user and never affects the transaction; aborted leaves nothing', async () => {
  // Each case in its own database, with its own watcher and fail point on its own audit_context:
  // a record written without waiting can't meet another case's fail point.
  const scenario = async (name: string, failure?: Record<string, unknown> & { mode: unknown }) => {
    const w = await stream(`tx-${name}`, { whoField: false, watcher: { contextWaitMS: 3000 } });
    const model = modelFor(w, 'typed', all.config.entity);
    const [x, y] = await model.create([record('X'), record('Y')]);
    const { mode, ...data } = failure ?? { mode: undefined };
    const off = failure ? await failPoint(w.conn, mode, { failCommands: ['insert'], namespace: `${w.conn.name}.audit_context`, ...data } as any) : undefined;
    try {
      await auditContext.run({ user: `u_${name}` }, async () => {
        const session = await w.conn.startSession();
        await session.withTransaction(async () => {
          await model.updateOne({ _id: x._id }, { $set: { 'basics.count': 2 } }, { session });
          await model.deleteOne({ _id: y._id }, { session });
        });
        await session.endSession();
      });
      await w.settle();
    } finally {
      await off?.();
    }
    assert.equal(((await model.findById(x._id).lean()) as any).basics.count, 2, `${name}: the transaction committed`);
    return (await audit(w).find({ docId: { $in: [x._id, y._id] }, operation: { $ne: 'create' } }).sort({ _id: 1 }).toArray()).map((e) => [e.operation, e.user ?? null]);
  };
  assert.deepEqual(await scenario('ok'), [['update', 'u_ok'], ['delete', 'u_ok']]);
  assert.deepEqual(await scenario('failed', { mode: 'alwaysOn', errorCode: 2 }), [['update', null], ['delete', null]]);
  assert.deepEqual(await scenario('late', { mode: 'alwaysOn', blockConnection: true, blockTimeMS: 8000 }), [['update', null], ['delete', null]]);
  // Aborted: nothing.
  const w = await stream('tx-aborted', { whoField: false });
  const model = modelFor(w, 'typed', all.config.entity);
  const doc = await model.create(record());
  const session = await w.conn.startSession();
  session.startTransaction();
  await model.updateOne({ _id: doc._id }, { $set: { 'basics.count': 99 } }, { session });
  await session.abortTransaction();
  await session.endSession();
  await w.settle();
  assert.equal(await audit(w).countDocuments({ docId: doc._id, operation: { $ne: 'create' } }), 0);
});

// ---------------------------------------------------------------- plugin off versus on

test('plugin off versus stream mode: identical stored data and results without a who-field; with one, only _audit and modifiedCount differ', async () => {
  const clock = () => {
    let t = Date.UTC(2026, 0, 1);
    return () => new Date((t += 1000));
  };
  const off = world(mongoose, conn, { db: 'offon-off', plugin: false, clock: clock() });
  const bare = await stream('offon-bare', { whoField: false, clock: clock() });
  const who = await stream('offon-who', { clock: clock() });
  const run = async (w: World) => {
    const model = modelFor(w, 'typed', all.config.entity);
    const id = new mongoose.Types.ObjectId('6a0000000000000000000001');
    const results: unknown[] = [];
    const strip = (r: any) => JSON.parse(JSON.stringify(r ?? null, (k, v) => (k === '_audit' ? undefined : v)));
    results.push(strip(await model.create({ _id: id, ...record() })));
    results.push(strip(await model.updateOne({ _id: id }, { $set: { 'basics.count': 2 } })));
    results.push(strip(await model.updateOne({ _id: id }, { $set: { 'basics.count': 2 } }, { timestamps: false }))); // no change
    results.push(strip(await model.findOneAndUpdate({ _id: id }, { $set: { 'basics.name': 'B' } }, { returnDocument: 'after' })));
    results.push(strip(await model.replaceOne({ _id: id }, { ...record('C') })));
    results.push(strip(await model.deleteOne({ _id: id })));
    results.push(strip(await model.create({ _id: id, ...record('D') })));
    await w.settle();
    const docs = await w.conn.db!.collection(model.collection.collectionName).find({}).toArray();
    return { results, docs };
  };
  const a = await run(off);
  const b = await run(bare);
  const c = await run(who);
  const { BSON } = mongoose.mongo;
  const bytes = (docs: any[], drop?: string) => docs.map((d) => Buffer.from(BSON.serialize(drop ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== drop)) : d)).toString('hex'));
  assert.deepEqual(b.results, a.results, 'without a who-field: the same results');
  assert.deepEqual(bytes(b.docs), bytes(a.docs), 'without a who-field: the same bytes');
  assert.deepEqual(bytes(c.docs, '_audit'), bytes(a.docs), 'with one: the same bytes but _audit');
  assert.ok(c.docs.every((d) => d['_audit']?.writeId));
  const differing = c.results.map((r, i) => JSON.stringify(r) === JSON.stringify(a.results[i]) ? null : [i, r, a.results[i]]).filter(Boolean);
  // Only the update that changed nothing: it is a real write now.
  assert.deepEqual(differing.map((d: any) => [d[0], d[1].modifiedCount, d[2].modifiedCount]), [[2, 1, 0]]);
});

// ---------------------------------------------------------------- images, crashes, failover, resume, size

test('an expired pre-image on one event gives a gap entry for that document, and the stream carries on', async () => {
  const w = await stream('expired');
  const model = modelFor(w, 'typed', all.config.entity);
  const [p, q] = await model.create([record('P'), record('Q')]);
  await w.settle();
  // Hold the watcher's reads, write, expire every pre-image, then let it read.
  await w.watcher!.stop();
  await model.updateOne({ _id: p._id }, { $set: { 'basics.count': 2 } });
  await conn.getClient().db('config').collection('system.preimages').deleteMany({});
  await model.updateOne({ _id: q._id }, { $set: { 'basics.count': 3 } });
  const watcher = await startAuditWatcher({ connection: w.conn, models: [model], lease: { renewMS: 200, takeoverMS: 1000 }, logger: { warn() {} } });
  const errors: any[] = [];
  watcher.on('auditError', (e) => errors.push(e));
  await watcher.caughtUp();
  const entries = await audit(w).find({ docId: { $in: [p._id, q._id] }, operation: { $ne: 'create' } }).sort({ _id: 1 }).toArray();
  assert.deepEqual(entries.map((e) => [String(e.docId), e.operation, e.stage ?? null]), [[String(p._id), 'gap', 'preImage'], [String(q._id), 'update', null]]);
  const history = await model.history(p._id, { timeZone: 'UTC' });
  assert.match(history[0].sentences[0], /^A change at .+ could not be recorded$/);
  assert.deepEqual(errors.map((e) => e.stage), ['preImage']);
  await watcher.stop();
});

test('crashes: the watcher killed outright at random points during a 10,000-write run, then restarted; every write has exactly one entry', async (t) => {
  const db = 'crashes';
  const w = await stream(db, { watcher: false });
  const model = modelFor(w, 'loose', all.config.entity);
  const child = fileURLToPath(new URL('../harness/watcher-child.ts', import.meta.url));
  let current: ReturnType<typeof spawn> | undefined;
  const startChild = () => {
    current = spawn(process.execPath, [child, uri, db], { stdio: ['ignore', 'pipe', 'inherit'] });
    return new Promise<void>((resolve) => current!.stdout!.once('data', () => resolve()));
  };
  await startChild();
  let kills = 0;
  const writes = Number(process.env['DE_CRASH_WRITES'] ?? 10_000);
  const ids: unknown[] = [];
  for (let i = 0; i < writes; i++) {
    if (i % 4 === 0 || ids.length === 0) {
      const _id = oid();
      ids.push(_id);
      await model.collection.insertOne({ _id, entity: all.config.entity, basics: { name: 'n', count: i } });
    } else {
      await model.collection.updateOne({ _id: ids[i % ids.length] }, { $set: { 'basics.count': i } });
    }
    if (i > 0 && i % Math.floor(writes / 12) === 0) {
      current!.kill('SIGKILL');
      kills++;
      await startChild();
    }
  }
  // A last watcher here, once the child's lease expires, catches up and checks.
  current!.kill('SIGKILL');
  const watcher = await startAuditWatcher({ connection: w.conn, models: [model], lease: { renewMS: 200, takeoverMS: 1000 }, logger: { warn() {} } });
  for (let i = 0; i < 200 && !watcher.active; i++) await new Promise((r) => setTimeout(r, 50));
  await watcher.caughtUp(120_000);
  const entries = await audit(w).countDocuments({ model: model.modelName, operation: { $in: ['create', 'update'] } });
  const unique = (await audit(w).distinct('eventId', { model: model.modelName })).length;
  t.diagnostic(`${writes} writes, ${kills} kills, ${entries} entries`);
  assert.equal(entries, writes);
  assert.equal(unique, writes);
  await watcher.stop();
});

test('failover and fencing: the active watcher paused past the takeover, then resumed: the standby takes over, the paused one can\'t overwrite its token, nothing lost or doubled', async () => {
  const w = await stream('failover', { watcher: false });
  const model = modelFor(w, 'loose', all.config.entity);
  let gate: Promise<void> | undefined;
  let open: () => void = () => {};
  const held = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t: any, key) {
        const v = t[key];
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (key === 'collection' || key === 'watch') return held(v.apply(t, args));
          if (['tryNext', 'updateOne', 'bulkWrite', 'findOneAndUpdate', 'insertOne'].includes(String(key))) return (gate ?? Promise.resolve()).then(() => v.apply(t, args));
          return v.apply(t, args);
        };
      },
    });
  const lease = { renewMS: 200, takeoverMS: 1000 };
  const a = await startAuditWatcher({ connection: { db: held(w.conn.db!) }, models: [model], lease, name: 'A', logger: { warn() {} } });
  for (let i = 0; i < 50 && !a.active; i++) await new Promise((r) => setTimeout(r, 20));
  const first = oid();
  await model.create({ _id: first, ...forStorage('loose', all.config.entity, record()) });
  await a.caughtUp();
  gate = new Promise<void>((r) => (open = r));
  const b = await startAuditWatcher({ connection: w.conn, models: [model], lease, name: 'B', logger: { warn() {} } });
  for (let i = 0; i < 200 && !b.active; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(b.active, 'B took over');
  const ids = Array.from({ length: 30 }, oid);
  for (const _id of ids) await model.create({ _id, ...forStorage('loose', all.config.entity, record()) });
  await b.caughtUp();
  const stateId = (await w.conn.db!.collection('audit_watcher_state').find({ owner: 'B' }).toArray())[0]!['_id'];
  const tokenB = (await w.conn.db!.collection('audit_watcher_state').findOne({ _id: stateId }))!['token'];
  open();
  gate = undefined;
  await new Promise((r) => setTimeout(r, 1500));
  const state = (await w.conn.db!.collection('audit_watcher_state').findOne({ _id: stateId }))!;
  assert.equal(state['owner'], 'B');
  assert.ok(String(state['token']._data) >= String(tokenB._data), 'the paused watcher did not move the token back');
  assert.equal(a.active, false);
  const entries = await audit(w).find({ docId: { $in: [first, ...ids] } }).toArray();
  assert.equal(entries.length, 31);
  assert.equal(new Set(entries.map((e) => String(e.docId))).size, 31);
  await a.stop();
  await b.stop();
});

test('resume gaps: a watcher stopped past the oplog window writes one gap per collection, with the right range, shown in Model.history, and recovers', async () => {
  const w = await stream('resume');
  const model = modelFor(w, 'typed', all.config.entity);
  const doc = await model.create(record());
  await w.settle();
  const stoppedAt = new Date();
  await w.watcher!.stop();
  await model.updateOne({ _id: doc._id }, { $set: { 'basics.count': 2 } }); // missed
  // The server's own answer once the oplog has rolled past the saved position.
  const off = await failPoint(w.conn, { times: 1 }, { failCommands: ['aggregate'], errorCode: 286 });
  const models = [...w.typed.values(), w.loose];
  const watcher = await startAuditWatcher({ connection: w.conn, models, lease: { renewMS: 200, takeoverMS: 1000 }, logger: { warn() {} } });
  try {
    for (let i = 0; i < 100 && !watcher.active; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 500));
    await model.updateOne({ _id: doc._id }, { $set: { 'basics.count': 3 } });
    await watcher.caughtUp();
    const gaps = await audit(w).find({ operation: 'gap', stage: 'resume' }).toArray();
    assert.equal(gaps.length, models.length, 'one gap per collection');
    assert.ok(gaps.every((g) => g['from'] <= stoppedAt && g['to'] >= stoppedAt));
    const history = await model.history(doc._id, { timeZone: 'UTC' });
    assert.deepEqual(history.map((h: any) => h.operation), ['update', 'gap', 'create']);
    assert.match(history[1].sentences[0], /^Changes between .+ and .+ were not recorded$/);
  } finally {
    await off();
    await watcher.stop();
  }
});

test('a document near 16 MB: both images together pass the event limit; the split event is joined', async () => {
  const w = await stream('large');
  const model = modelFor(w, 'loose', all.config.entity);
  const doc = await model.create({ ...forStorage('loose', all.config.entity, record()), blob: 'x'.repeat(9 * 1024 * 1024) });
  await model.updateOne({ _id: doc._id }, { $set: { 'basics.count': 2 } });
  await w.settle();
  const update = await audit(w).findOne({ docId: doc._id, operation: 'update' });
  assert.ok(update, 'recorded');
  assert.deepEqual(update['changes'].map((c: any) => [c.labels.at(-1), c.before, c.after]), [['Count', 1, 2]]);
});

// ---------------------------------------------------------------- never blocks

test('never blocks: with the watcher stopped, broken or slow, the app\'s writes succeed with identical results and timings', async (t) => {
  const time = async (w: World) => {
    const model = modelFor(w, 'typed', all.config.entity);
    const results: unknown[] = [];
    const ms: number[] = [];
    for (let i = 0; i < 60; i++) {
      const id = new mongoose.Types.ObjectId(`6b00000000000000000000${String(i).padStart(2, '0')}`);
      const start = performance.now();
      results.push(JSON.parse(JSON.stringify(await model.create({ _id: id, ...record() }), (k, v) => (['createdAt', 'updatedAt', '_audit', '__v'].includes(k) ? undefined : v))));
      results.push(await model.updateOne({ _id: id }, { $set: { 'basics.count': i + 2 } }));
      ms.push(performance.now() - start);
    }
    ms.sort((x, y) => x - y);
    return { results, p50: ms[Math.floor(ms.length / 2)]! };
  };
  const base = await time(world(mongoose, conn, { db: 'nb-base', plugin: false }));
  const stopped = await stream('nb-stopped', { whoField: false });
  await stopped.watcher!.stop();
  const broken = await stream('nb-broken', { whoField: false, plugin_options: { diff: () => { throw new Error('broken'); } } });
  const slow = await stream('nb-slow', { whoField: false });
  const offSlow = await failPoint(conn, 'alwaysOn', { failCommands: ['insert', 'update'], blockConnection: true, blockTimeMS: 300, namespace: `${slow.conn.name}.audit_trail` } as any);
  try {
    for (const [name, w] of [['stopped', stopped], ['broken', broken], ['slow', slow]] as const) {
      const r = await time(w);
      assert.deepEqual(r.results, base.results, `${name}: identical results`);
      t.diagnostic(`${name}: p50 ${r.p50.toFixed(2)} ms against ${base.p50.toFixed(2)} ms with the plugin off`);
      assert.ok(r.p50 < base.p50 * 2 + 5, `${name}: p50 ${r.p50.toFixed(1)} ms`);
    }
  } finally {
    await offSlow();
  }
  assert.ok(broken.errors.some((e: any) => e.stage === 'diff'));
});

test('no secret value in any entry, context record or gap', async () => {
  const { entries } = await assertNoSecretsInAudit(conn);
  assert.ok(entries > 100);
});

void typedSchema;
void auditTrail;
