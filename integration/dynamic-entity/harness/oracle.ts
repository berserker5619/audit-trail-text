// The differential check for one write: the stored documents before and after it, minus __v and
// timestamps, are diffed by Dynamic Entity itself, and the plugin's entry must hold exactly those
// changes, read back as the same sentences in en and de. The versions the plugin handed its
// diff must equal the stored documents: the Mongo conversion leaves DE records unchanged.
import assert from 'node:assert/strict';
import { describeEntityChanges } from '@dynamic-entity/core/history';
import { auditFlush } from 'audit-trail-text/mongoose';
import type { Fixture } from './configs.ts';
import { oracle } from './models.ts';
import type { World } from './models.ts';

type Rec = Record<string, any>;

/** A stored document as Dynamic Entity sees it: without Mongoose's __v and timestamps. */
export function clean(doc: Rec | null, whoField?: string): Rec | null {
  if (!doc) return null;
  const { __v: _v, createdAt: _c, updatedAt: _u, ...rest } = doc;
  // Stream mode's who-field: never part of a change.
  if (whoField) delete rest[whoField];
  return rest;
}

/** As JSON: ObjectIds as their hex text. */
export function json<T>(v: T): T {
  return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
}

export async function stored(model: any, id: unknown): Promise<Rec | null> {
  return model.db.db.collection(model.collection.collectionName).findOne({ _id: id });
}

export async function entriesOf(model: any, id: unknown): Promise<Rec[]> {
  // By model and docId: the plugin's own index, so a large audit collection stays quick to read.
  return model.db.db.collection('audit_trail').find({ model: model.baseModelName ?? model.modelName, docId: id }).sort({ _id: 1 }).toArray();
}

/** How many documents the checks looked at, and how many of them Dynamic Entity saw change. */
export const stats = { documents: 0, changed: 0, edits: 0, editsChanged: 0 };

export interface Target {
  model: any;
  id: unknown;
  fixture: Fixture;
}

/**
 * Runs `write`, then checks every target document: one entry when Dynamic Entity sees a change,
 * none when it doesn't, with exactly its changes and sentences.
 */
export async function checked<T>(w: World, targets: Target[], write: () => Promise<T>, expect: { operation?: string } = {}): Promise<T> {
  const before = await Promise.all(targets.map(async (t) => ({ doc: await stored(t.model, t.id), entries: (await entriesOf(t.model, t.id)).length })));
  for (const t of targets) w.calls.delete(String(t.id));
  const result = await write();
  await auditFlush();
  await w.settle();
  for (const [i, t] of targets.entries()) {
    const was = clean(before[i]!.doc, w.whoField);
    const now = clean(await stored(t.model, t.id), w.whoField);
    const expected = json(oracle(t.fixture, was, now));
    const fresh = (await entriesOf(t.model, t.id)).slice(before[i]!.entries);
    const where = `${t.fixture.config.entity} ${String(t.id)}`;
    stats.documents++;
    if (expected.length > 0) stats.changed++;
    if (expect.operation !== 'create') {
      stats.edits++;
      if (expected.length > 0) stats.editsChanged++;
    }
    if (expected.length === 0) {
      assert.equal(fresh.length, 0, `${where}: Dynamic Entity sees no change, but the plugin wrote ${fresh.length} entries: ${JSON.stringify(fresh.map((e) => e.changes))}`);
      continue;
    }
    assert.equal(fresh.length, 1, `${where}: expected one entry for ${JSON.stringify(expected)}, got ${fresh.length}`);
    const entry = fresh[0]!;
    assert.deepEqual(json(entry.changes), expected, `${where}: stored changes differ from diffEntityRecords`);
    if (expect.operation) assert.equal(entry.operation, expect.operation, `${where}: operation`);
    // The versions the plugin diffed are the stored documents, unchanged by its conversion.
    // The call for this entry's operation: a snapshot is a second call, as a delete.
    const call = w.calls.get(String(t.id))?.filter((c) => c.operation === entry.operation).at(-1);
    assert.ok(call, `${where}: the plugin never called its diff`);
    assert.deepEqual(call.before, json(was), `${where}: the before version the plugin diffed is not the stored document`);
    assert.deepEqual(call.after, json(now), `${where}: the after version the plugin diffed is not the stored document`);
    // History reads back as Dynamic Entity's own sentences, in both languages.
    for (const language of ['en', 'de']) {
      const [latest] = await t.model.history(t.id, { language, limit: 1 });
      const want = describeEntityChanges(expected, { config: t.fixture.config, language }).map((s) => s.text);
      assert.deepEqual(latest.sentences, want, `${where}: ${language} sentences`);
    }
  }
  return result;
}
