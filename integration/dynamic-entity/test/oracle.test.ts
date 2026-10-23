// Differential testing: for every config, both storage models and every single-document write
// path, generated edits are written through Mongoose and the plugin's entry must equal
// diffEntityRecords over the stored documents, with the same sentences in en and de.
//
// DE_RUNS sets the runs per config and storage model (default 2,000). Seeds are fixed per test,
// so a failure replays; fast-check shrinks it to a minimal record and edit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { editArb, editFrom } from '../harness/arbitraries.ts';
import { ALL_FIELD_TYPES, ALL_TYPES, FIXTURES, MASKED, fieldTypes } from '../harness/configs.ts';
import { mongoose, replicaSet } from '../harness/db.ts';
import { forStorage, modelFor, world } from '../harness/models.ts';
import { checked, stats, stored } from '../harness/oracle.ts';
import { assertNoSecretsInAudit } from '../harness/secrets.ts';
import { SINGLE_PATHS, write } from '../harness/paths.ts';
import { recordShape } from '../harness/shape.ts';

const RUNS = Number(process.env['DE_RUNS'] ?? 2000);
// DE_ONLY=entity,entity runs only those configs, so CI can split the suite across jobs.
// Unset or empty: every config.
const only = process.env['DE_ONLY']?.split(',').filter(Boolean) ?? [];
const ONLY = only.length > 0 ? only : undefined;
const { conn } = await replicaSet();
const w = world(mongoose, conn, { db: 'oracle' });

/** A fixed seed per test name, so every run of the suite draws the same cases. */
const seedOf = (name: string) => [...name].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

async function createThenEdit(storage: 'typed' | 'loose', fixture: (typeof FIXTURES)[number], before: Record<string, unknown>, after: Record<string, unknown>, path: (typeof SINGLE_PATHS)[number]) {
  const entity = fixture.config.entity;
  const model = modelFor(w, storage, entity);
  const id = new mongoose.Types.ObjectId();
  const target = [{ model, id, fixture }];
  await checked(w, target, () => model.create({ _id: id, ...forStorage(storage, entity, before) }), { operation: 'create' });
  const now = (await stored(model, id))!;
  await checked(w, target, () => write(path, model, id, now, { ...forStorage(storage, entity, after), _id: id }));
}

test('the configs cover every field type and every structure the record shape depends on', () => {
  assert.deepEqual([...ALL_FIELD_TYPES].filter((t) => !fieldTypes().has(t)), []);
  const json = JSON.stringify(ALL_TYPES);
  for (const needle of ['"flatData":true', '"refererField"', '"maskData":true', '"children":[{"id":"inner"', '"$key"']) assert.ok(json.includes(needle), needle);
  assert.equal(MASKED.maskData, true);
  // An array inside a group, and an array inside an array's rows.
  const structures = ALL_TYPES.tabs.find((t) => t.id === 'structures')!.fields!;
  assert.ok(structures.find((f) => f.id === 'address')!.children!.some((c) => c.type === 'array'));
  assert.ok(structures.find((f) => f.id === 'lines')!.children!.some((c) => c.type === 'array'));
});

for (const fixture of FIXTURES.filter((f) => !ONLY || ONLY.includes(f.config.entity))) {
  const entity = fixture.config.entity;
  const shape = recordShape(fixture.config);
  for (const storage of ['typed', 'loose'] as const) {
    const name = `${entity}, ${storage}: generated edits through every write path match diffEntityRecords`;
    test(name, async () => {
      await fc.assert(
        fc.asyncProperty(editArb(shape), fc.constantFrom(...SINGLE_PATHS), async ({ before, after }, path) => {
          await createThenEdit(storage, fixture, before, after, path);
        }),
        { numRuns: RUNS, seed: seedOf(name), endOnFailure: false },
      );
    });
    if (fixture.seeds.length > 0) {
      const seedName = `${entity}, ${storage}: the demo's seed records, edited, match diffEntityRecords`;
      test(seedName, async () => {
        const seeds = fixture.seeds.map(({ _id, ...rest }) => rest);
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom(...seeds).chain((seed) => editFrom(shape, seed).map((after) => ({ before: seed, after }))),
            fc.constantFrom(...SINGLE_PATHS),
            async ({ before, after }, path) => createThenEdit(storage, fixture, before, after, path),
          ),
          { numRuns: Math.max(50, Math.round(RUNS / 10)), seed: seedOf(seedName) },
        );
      });
    }
  }
}

test('the edits were real: most documents checked changed, and no secret reached the audit collection', async (t) => {
  t.diagnostic(`${stats.documents} documents checked, ${stats.changed} with changes; ${stats.edits} edits, ${stats.editsChanged} of them changes`);
  assert.ok(stats.editsChanged > stats.edits * 0.3, `${stats.editsChanged} of ${stats.edits} edits changed something`);
  assert.ok(stats.editsChanged < stats.edits, 'some edits change nothing, such as a renamed option');
  const scanned = await assertNoSecretsInAudit(conn);
  t.diagnostic(`${scanned.entries} audit entries scanned; ${scanned.secretsInRecords} secret values in the records`);
  assert.ok(scanned.secretsInRecords > 0);
});
