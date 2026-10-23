// Scale: 10,000 records with 50-row arrays and three levels of nesting. Reports the latency the
// plugin adds per write path (p50, p95, p99; off, on, on with background: true), and the memory a
// find() of all 10,000 documents holds with captureOnLoad on and off.
//
//   node --expose-gc bench/bench.ts [--samples 200]
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { EntityFormConfig } from '@dynamic-entity/core';
import { diffEntityRecords, entityAuditAdapter } from '@dynamic-entity/core/history';
import { auditFlush, auditTrail } from 'audit-trail-text/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { looseSchema, typedLabels, typedSchema } from '../harness/schemas.ts';

const SAMPLES_ARG = process.argv.includes('--samples') ? Number(process.argv[process.argv.indexOf('--samples') + 1]) : 200;
const arg = (name: string, fallback: number) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : fallback);
const RECORDS = arg('--records', 10_000);
const SAMPLES = SAMPLES_ARG;
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');

const label = (en: string) => ({ en });
// Tab → group → rows (50) → parts (2): three levels below the tab.
const BENCH: EntityFormConfig = {
  entity: 'bench',
  version: 1,
  tabs: [
    {
      id: 'main',
      label: label('Main'),
      fields: [
        { id: 'title', type: 'text', label: label('Title') },
        { id: 'total', type: 'currency', label: label('Total') },
        {
          id: 'details',
          type: 'group',
          label: label('Details'),
          children: [
            { id: 'owner', type: 'text', label: label('Owner') },
            {
              id: 'rows',
              type: 'array',
              label: label('Rows'),
              children: [
                { id: 'ref', type: 'text', label: label('Ref') },
                { id: 'qty', type: 'number', label: label('Quantity') },
                { id: 'parts', type: 'array', label: label('Parts'), children: [{ id: 'ref', type: 'text', label: label('Ref') }, { id: 'count', type: 'number', label: label('Count') }] },
              ],
            },
          ],
        },
      ],
    },
  ],
} as EntityFormConfig;

const adapter = entityAuditAdapter(BENCH);
const diff = (before: any, after: any) => diffEntityRecords(before, after, BENCH, { adapter });

function makeRecord(i: number) {
  return {
    main: {
      title: `Record ${i}`,
      total: i * 10,
      details: {
        owner: `owner-${i % 97}`,
        rows: Array.from({ length: 50 }, (_, r) => ({
          $rowId: `r${r}`,
          ref: `R${r}`,
          qty: (i + r) % 13,
          parts: [{ $rowId: `p${r}a`, ref: 'A', count: r }, { $rowId: `p${r}b`, ref: 'B', count: r + 1 }],
        })),
      },
    },
  };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const ms = (x: number) => x.toFixed(2);

if (process.argv.includes('--memory-child')) {
  const [uri, storage, variant] = process.argv.slice(process.argv.indexOf('--memory-child') + 1) as [string, 'typed' | 'loose', string];
  const child = await mongoose.createConnection(uri, { dbName: 'bench' }).asPromise();
  const schema = storage === 'typed' ? typedSchema(mongoose, BENCH) : looseSchema(mongoose);
  if (variant !== 'off') {
    schema.plugin(auditTrail, { diff, logger: { warn() {} }, captureOnLoad: variant === 'true', ...(storage === 'typed' && { labels: typedLabels(BENCH) }) });
  }
  const model = child.model('mem', schema, `memory_${storage}`);
  await model.find().limit(10); // warm up the model and the connection
  gc();
  gc();
  const before = process.memoryUsage().heapUsed;
  const docs: unknown[] = await model.find();
  gc();
  gc();
  const held = process.memoryUsage().heapUsed - before;
  if (docs.length !== RECORDS) throw new Error(`found ${docs.length}`);
  console.log(held);
  await child.close();
  process.exit(0);
}

const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const conn = await mongoose.createConnection(rs.getUri(), { dbName: 'bench' }).asPromise();
const quiet = { warn() {} };

type Mode = 'off' | 'on' | 'background';
type Storage = 'typed' | 'loose';

function benchModel(storage: Storage, mode: Mode, extra: Record<string, unknown> = {}, name = `${storage}_${mode}`) {
  const schema = storage === 'typed' ? typedSchema(mongoose, BENCH) : looseSchema(mongoose);
  if (mode !== 'off') {
    schema.plugin(auditTrail, {
      diff,
      many: true,
      logger: quiet,
      background: mode === 'background',
      ...(storage === 'typed' && { labels: typedLabels(BENCH) }),
      ...extra,
    });
  }
  return conn.model(name, schema, `records_${storage}_${mode}`);
}

const doc = (storage: Storage, i: number) => ({ ...(storage === 'loose' && { entity: 'bench' }), ...makeRecord(i) });

async function seed(model: any, storage: Storage) {
  // Seeded straight through the driver: the benchmark measures the writes after.
  const batch = Math.min(1000, RECORDS);
  for (let i = 0; i < RECORDS; i += batch) {
    await model.collection.insertMany(Array.from({ length: Math.min(batch, RECORDS - i) }, (_, k) => ({ _id: new mongoose.Types.ObjectId(), ...doc(storage, i + k), __v: 0 })));
  }
}

const PATHS = ['create', 'save', 'updateOne', 'findOneAndUpdate after', 'findOneAndUpdate before', 'replaceOne', 'deleteOne', 'insertMany ×10', 'updateMany ×20'] as const;

async function samples(model: any, storage: Storage, path: (typeof PATHS)[number], ids: unknown[], count = SAMPLES): Promise<number[]> {
  const out: number[] = [];
  for (let s = 0; s < count; s++) {
    const id = ids.pop();
    const r = s % 50;
    const start = performance.now();
    switch (path) {
      case 'create':
        await model.create(doc(storage, RECORDS + s));
        break;
      case 'save': {
        const d = await model.findById(id);
        const t = performance.now();
        d.set(`main.details.rows.${r}.qty`, 1000 + s);
        await d.save();
        out.push(performance.now() - t); // the save, not the load
        continue;
      }
      case 'updateOne':
        await model.updateOne({ _id: id }, { $set: { [`main.details.rows.${r}.qty`]: 1000 + s } });
        break;
      case 'findOneAndUpdate after':
        await model.findOneAndUpdate({ _id: id }, { $set: { [`main.details.rows.${r}.qty`]: 1000 + s } }, { returnDocument: 'after' });
        break;
      case 'findOneAndUpdate before':
        await model.findOneAndUpdate({ _id: id }, { $set: { [`main.details.rows.${r}.qty`]: 1000 + s } }, { returnDocument: 'before' });
        break;
      case 'replaceOne':
        await model.replaceOne({ _id: id }, { ...doc(storage, s), main: { ...makeRecord(s).main, title: `Replaced ${s}` } });
        break;
      case 'deleteOne':
        await model.deleteOne({ _id: id });
        break;
      case 'insertMany ×10':
        await model.insertMany(Array.from({ length: 10 }, (_, k) => doc(storage, RECORDS + s * 10 + k)));
        break;
      case 'updateMany ×20': {
        const owner = `owner-${s % 97}`;
        // About 20 documents per owner among the first 2,000.
        await model.updateMany({ 'main.details.owner': owner, 'main.total': { $lt: 20_000 } }, { $inc: { 'main.total': 1 } });
        break;
      }
    }
    out.push(performance.now() - start);
  }
  return out;
}

const results: Record<string, Record<Mode, number[]>> = {};
const MEMORY_ONLY = process.argv.includes('--memory-only');
for (const storage of MEMORY_ONLY ? [] : (['typed', 'loose'] as const)) {
  const models = { off: benchModel(storage, 'off'), on: benchModel(storage, 'on'), background: benchModel(storage, 'background') };
  for (const mode of ['off', 'on', 'background'] as const) await seed(models[mode], storage);
  for (const path of PATHS) {
    const key = `${storage} ${path}`;
    results[key] = { off: [], on: [], background: [] };
    for (const mode of ['off', 'on', 'background'] as const) {
      const ids = (await models[mode].find({}, { _id: 1 }).lean()).map((d: any) => d._id).sort(() => Math.random() - 0.5);
      // Warm up, then measure.
      await samples(models[mode], storage, path, ids.slice(0, 20), 20);
      results[key]![mode] = await samples(models[mode], storage, path, ids.slice(20));
      await auditFlush();
    }
  }
}

console.log(`\n## Latency, ${SAMPLES} samples per path (ms)\n`);
console.log('| Storage, write | off p50 / p95 / p99 | on p50 / p95 / p99 | background p50 / p95 / p99 | added p50 (on, background) |');
console.log('| --- | --- | --- | --- | --- |');
for (const [key, r] of Object.entries(results)) {
  const cell = (xs: number[]) => `${ms(quantile(xs, 0.5))} / ${ms(quantile(xs, 0.95))} / ${ms(quantile(xs, 0.99))}`;
  const added = (xs: number[]) => ms(quantile(xs, 0.5) - quantile(r.off, 0.5));
  console.log(`| ${key} | ${cell(r.off)} | ${cell(r.on)} | ${cell(r.background)} | +${added(r.on)}, +${added(r.background)} |`);
}

// Memory: a find() of all 10,000 documents, held, with captureOnLoad on and off. Each variant is
// measured in its own process, so nothing from an earlier measurement is still on the heap.
console.log(`
## Memory: find() of ${RECORDS.toLocaleString('en')} documents, held (MB of heap)
`);
console.log('| Storage | plugin off | captureOnLoad: true | captureOnLoad: false |');
console.log('| --- | --- | --- | --- |');
for (const storage of ['typed', 'loose'] as const) {
  const collection = `memory_${storage}`;
  const off = conn.model(`mem_${storage}_off`, storage === 'typed' ? typedSchema(mongoose, BENCH) : looseSchema(mongoose), collection);
  await seed(off, storage);
  const row: string[] = [];
  for (const variant of ['off', 'true', 'false']) {
    const out = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--memory-child', rs.getUri(), storage, variant, '--records', String(RECORDS)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    row.push((Number(out.trim().split(/\r?\n/).pop()) / 1024 / 1024).toFixed(1));
  }
  console.log(`| ${storage} | ${row.join(' | ')} |`);
}

await conn.close();
await rs.stop();
