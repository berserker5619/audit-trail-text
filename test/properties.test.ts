import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRecords, jsonSchemaAdapter, type Change } from '../src/index.ts';
import { contactSchema } from './helpers.ts';

// Seeded so failures reproduce. Item labels come from `after`, so each product name is fixed per id
// to keep labels the same in both directions.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomRecord(r: () => number): Record<string, unknown> {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const maybe = <T>(v: T) => (r() < 0.7 ? v : pick([undefined, null, '']));
  const rec: Record<string, unknown> = {
    name: maybe(pick(['Rajesh', 'Priya', 'Arun'])),
    phone: maybe(pick(['1', '2', 3])),
    status: maybe(pick(['lead', 'active'])),
    password: maybe(pick(['a', 'b'])),
    address: pick([undefined, null, {}, { city: pick(['C', 'M']) }, { city: 'C', pin: pick(['1', '2']) }]),
    tags: pick([undefined, [], ['a'], ['a', 'a', 'b'], ['b', 'c']]),
    extras: pick([undefined, [], [1], [{ a: pick([1, 2]) }]]),
    orders: [...new Set(['A1', 'A2', 'A3', 'A4'].filter(() => r() < 0.5))]
      .sort(() => r() - 0.5)
      .map((id) => ({ id, product: `Product ${id}`, qty: pick([1, 2]), note: pick(['x', 'y']) })),
    meta: pick([undefined, { src: pick(['a', 'b']) }]),
  };
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  return rec;
}

const SWAP: Partial<Record<Change['code'], Change['code']>> = {
  ITEM_ADDED: 'ITEM_REMOVED',
  ITEM_REMOVED: 'ITEM_ADDED',
  FIELD_SET: 'FIELD_CLEARED',
  FIELD_CLEARED: 'FIELD_SET',
  RECORD_CREATED: 'RECORD_DELETED',
  RECORD_DELETED: 'RECORD_CREATED',
};

function swapped(c: Change): Change {
  const out: Record<string, unknown> = { ...c, code: SWAP[c.code] ?? c.code };
  delete out['before'];
  delete out['after'];
  delete out['beforePath'];
  delete out['afterPath'];
  if (c.before !== undefined) out['after'] = c.before;
  if (c.after !== undefined) out['before'] = c.after;
  if (c.beforePath !== undefined) out['afterPath'] = c.beforePath;
  if (c.afterPath !== undefined) out['beforePath'] = c.afterPath;
  const { beforeLabel, afterLabel, ...display } = c.display;
  out['display'] = { ...display, ...(afterLabel !== undefined && { beforeLabel: afterLabel }), ...(beforeLabel !== undefined && { afterLabel: beforeLabel }) };
  return out as unknown as Change;
}

const sorted = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]))
    : v;
const key = (c: Change) => JSON.stringify(sorted(c));
const bag = (cs: Change[]) => cs.map(key).sort();

const adapter = jsonSchemaAdapter(contactSchema);
const opts = { maxChanges: 1_000_000 };

test('diffRecords(a, a) is always empty', () => {
  const r = rng(1);
  for (let i = 0; i < 500; i++) {
    const a = randomRecord(r);
    assert.deepEqual(diffRecords(a, structuredClone(a), adapter, opts), [], JSON.stringify(a));
  }
});

test('swapping before and after swaps the codes, values and paths', () => {
  const r = rng(2);
  for (let i = 0; i < 1000; i++) {
    const b = r() < 0.05 ? null : randomRecord(r);
    const a = r() < 0.05 ? null : randomRecord(r);
    const forward = diffRecords(b, a, adapter, opts).map(swapped);
    const backward = diffRecords(a, b, adapter, opts);
    assert.deepEqual(bag(forward), bag(backward), `${JSON.stringify(b)}\n${JSON.stringify(a)}`);
  }
});

test('output is deterministic', () => {
  const r = rng(3);
  for (let i = 0; i < 200; i++) {
    const b = randomRecord(r);
    const a = randomRecord(r);
    assert.deepEqual(diffRecords(b, a, adapter), diffRecords(structuredClone(b), structuredClone(a), adapter));
  }
});
