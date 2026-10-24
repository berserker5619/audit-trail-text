// Stream mode's oracle: the same generated edits through every write path, recorded by the
// watcher from MongoDB's own images. Every entry's changes must deep-equal
// diffEntityRecords(preImage, postImage, config), with the same sentences in en and de, and the
// who-field must appear in no change, created or deleted payload, or snapshot.
//
// DE_STREAM_RUNS sets the runs per config and storage model (default: DE_RUNS, else 2,000).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fc from 'fast-check';
import { editArb } from '../harness/arbitraries.ts';
import { FIXTURES } from '../harness/configs.ts';
import { mongoose, replicaSet } from '../harness/db.ts';
import { forStorage, modelFor, streamWorld } from '../harness/models.ts';
import { checked, stats, stored } from '../harness/oracle.ts';
import { SINGLE_PATHS, write } from '../harness/paths.ts';
import { assertNoSecretsInAudit } from '../harness/secrets.ts';
import { recordShape } from '../harness/shape.ts';

const RUNS = Number(process.env['DE_STREAM_RUNS'] ?? process.env['DE_RUNS'] ?? 2000);
const only = process.env['DE_ONLY']?.split(',').filter(Boolean) ?? [];
const ONLY = only.length > 0 ? only : undefined;
const { conn } = await replicaSet();
const w = await streamWorld(mongoose, conn, { db: 'stream-oracle', plugin_options: { snapshots: true } });
after(() => w.watcher!.stop());
const seedOf = (name: string) => [...name].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 11);

for (const fixture of FIXTURES.filter((f) => !ONLY || ONLY.includes(f.config.entity))) {
  const entity = fixture.config.entity;
  const shape = recordShape(fixture.config);
  for (const storage of ['typed', 'loose'] as const) {
    const name = `stream: ${entity}, ${storage}: every event's changes match diffEntityRecords(preImage, postImage)`;
    test(name, async () => {
      await fc.assert(
        fc.asyncProperty(editArb(shape), fc.constantFrom(...SINGLE_PATHS), async ({ before, after: next }, path) => {
          const model = modelFor(w, storage, entity);
          const id = new mongoose.Types.ObjectId();
          const target = [{ model, id, fixture }];
          await checked(w, target, () => model.create({ _id: id, ...forStorage(storage, entity, before) }), { operation: 'create' });
          const now = (await stored(model, id))!;
          await checked(w, target, () => write(path, model, id, now, { ...forStorage(storage, entity, next), _id: id }));
        }),
        { numRuns: RUNS, seed: seedOf(name) },
      );
    });
  }
}

test('stream: every entry came from the watcher; the who-field is in no change, payload or snapshot; no secret leaked', async (t) => {
  const audit = w.conn.db!.collection('audit_trail');
  const all = await audit.find({}).toArray();
  t.diagnostic(`${all.length} entries; ${stats.edits} edits checked, ${stats.editsChanged} of them changes`);
  assert.ok(all.length > 0 && all.every((e) => e['source'] === 'stream' && typeof e['eventId'] === 'string'));
  assert.equal(await audit.countDocuments({ snapshot: { $exists: true } }) > 0, true, 'snapshots were stored');
  assert.doesNotMatch(JSON.stringify(all), /_audit|writeId/);
  assert.deepEqual(w.errors.map((e: any) => e.stage), []);
  await assertNoSecretsInAudit(conn);
});
