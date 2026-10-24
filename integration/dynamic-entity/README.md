# Integration test: the Mongoose plugin with Dynamic Entity

Tests `audit-trail-text/mongoose` against [Dynamic Entity](https://github.com/berserker5619/Dynamic-Entity) 3.3.1 on a real MongoDB replica set. Not part of the published package.

`@dynamic-entity/core@3.3.1` comes from npm, and an `overrides` entry makes it use this checkout's `audit-trail-text`, not the published 1.2. Build the checkout first.

```sh
npm ci && npm run build            # in the repository root
cd integration/dynamic-entity
npm ci
npm test                           # DE_RUNS=2000 by default; DE_ONLY=entity,... for some configs
npm run bench                      # 10,000 records: latency and memory
npm run refresh-fixtures [tag]     # copy the demo's seed data again
```

To run on another Mongoose, `npm install --no-save mongoose@7`.

## What it checks

- **The oracle.** For every write, the plugin's stored changes must deep-equal `diffEntityRecords(before, after, config)` over the stored documents, minus `__v` and timestamps. Its sentences in `en` and `de` must equal `describeEntityChanges`. The versions it hands its `diff` must equal the stored documents, so the Mongo conversion leaves DE records unchanged.
- **Storage models.** (A) Typed: a Mongoose schema generated from each config, with rows `_id: false` keyed by `$rowId` through the labels file. (B) Loose: one `strict: false` collection with an `entity` field, and the config picked per document.
- **Generated edits** (fast-check, a fixed seed per test, shrinking): every field type set, cleared and changed; groups and nested tabs; rows added, removed, edited and reordered, nested rows, rows with no `$rowId` (3.1 data); options renamed under the same `$key`. These go through `save()`, dotted `$set`/`$unset`, `replaceOne`, `findOneAndReplace`, `findOneAndUpdate` returning before and after, and `updateOne`. The demo's seed records are edited the same way.
- **Every other path** (`test/paths.test.ts`): `$push`/`$pull`, upserts, `insertMany` with `ordered: false` partly failing, `updateMany`/`deleteMany` below and above `maxMany`, every delete, and a config version bump whose migration renames a field.
- **Plugin off and on** (`test/offon.test.ts`): generated workloads leave the same bytes and return the same results, with and without `background: true`.
- **Guarantees** (`test/guarantees.test.ts`): transactions (commit, abort, retries forced with fail points), 50 concurrent writers (every entry exact inside transactions; outside them, every write has an entry and the misattribution rate is reported per path, as the plugin README's "Concurrent writes" describes), every failure from the plugin's never-blocks table (fail points and injected faults), history paging over 500 entries with one `at`, and changes stored by the published 1.2. After each file, no secret value appears anywhere in an audit collection.

### Stream mode (1.4)

The same models in `mode: 'stream'`, with a `_audit` who-field and a watcher, recorded from MongoDB's images:

- **Stream oracle** (`test/stream-oracle.test.ts`): every event's changes must equal `diffEntityRecords(preImage, postImage, config)` for every config and both storage models, through every write path, with snapshots on. The who-field must appear in no change, payload or snapshot. `DE_STREAM_RUNS` sets the runs (default `DE_RUNS`).
- **Stream guarantees** (`test/stream-guarantees.test.ts`):
  - the 50-writer headline run with no transactions, through every write path including `bulkWrite` on Mongoose 8 and 9: every entry has its writer and its exact change
  - a stale who-field, which gets no user
  - writes outside Mongoose
  - transactions: context matched, failed, late and aborted
  - plugin off versus on, with and without a who-field
  - an expired pre-image, which becomes a gap
  - 10,000 writes with the watcher, running in its own process, killed outright 12 times (`DE_CRASH_WRITES`)
  - failover with fencing
  - lost history, which becomes a gap per collection
  - a near-16 MB document
  - never blocking, with the watcher stopped, broken or slow
  - a leak scan of entries, context records and gaps

## Fixtures

`fixtures/` holds the demo's seed data, copied by `scripts/refresh-fixtures.mjs` from `packages/demo-angular/src/app/mock/` at tag v3.3.1, along with the two configs `seed-enterprise.ts` imports and the `test_data.json` configs `seed-records.ts` is written against. `fixtures/SOURCE.json` records the commit (`0a9728c93580e8bf2a56f10841d5904e08dc230a`) and each file's sha256. The only change to the copies is `with { type: 'json' }` on JSON imports, which Node needs.

Generated configs (`harness/configs.ts`) cover what the demos don't: all 27 field types, nested tabs, a `flatData` tab, arrays in groups and in rows, a `refererField`, and `maskData` on a field, a tab and a whole config.
