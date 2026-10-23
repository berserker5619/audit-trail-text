# Changelog

## 1.3.0 (unreleased)

A Mongoose plugin, in a new server-only entry, and one small core addition. The main entry, its zero dependencies and its stored changes are unchanged.

- **`audit-trail-text/mongoose`**: `auditTrail`, a Mongoose plugin for Mongoose 7, 8 and 9 that records creates, updates and deletes made through Mongoose as audit-trail-text changes in an `audit_trail` collection, and a `history` static that reads them back as sentences. Covers `save`, `create`, `insertMany` (including partly failed `ordered: false` inserts), `findOneAndUpdate`, `findOneAndReplace`, `updateOne`, `replaceOne`, `findOneAndDelete`, `deleteOne` on queries and documents, upserts, and with `many: true`, `updateMany` and `deleteMany` up to `maxMany`. Single-document query writes are narrowed to the document read before them; upserts keep their filter.
- The schema is read into a JSON Schema for `jsonSchemaAdapter`, with the same labels file: subdocument lists keyed by `_id`, `Map`, `Mixed`, `Decimal128`, `Buffer`, discriminators, recursive schemas, `title`, `auditSensitive`, `auditIgnore` and `auditFormat` on paths, `select: false` treated as sensitive. `mongooseSchemaAdapter` is exported.
- Transactions: entries are held on the session, written after the commit and dropped on abort; a retried `withTransaction` never duplicates them.
- Auditing never blocks the app: every failure is emitted as `auditError` on the model (or logged, at most once a minute per model), `auditTimeoutMS` bounds the time added to a write, `background: true` defers the audit write, and `auditFlush()` waits for it.
- Who and why per query (`audit` option), per document (`$locals.audit`) or per request (`auditContext.run`, nested contexts merge); `skip` records nothing.
- `describeEntries`, and `history` paging by entry `_id`.
- Moving from mongoose-audit: `importMongooseAudit` (safe to run again, entries carry `importedFrom`) and `historyFromSnapshots`.
- **Core:** `format: "decimal"` for exact numbers stored as text: "1,234.50", not quoted. `ChangeDisplay.format` may be `"decimal"`.
- `mongoose` is an optional peer dependency (`^7 || ^8 || ^9`). The plugin never imports it.

## 1.2.0 (2026-10-22)

Trees of any depth, objects compared as one value, labels in every language, and moves across parents, so the package can describe Dynamic Entity records and forms. Everything is opt-in or only triggers on schemas 1.1 refused. Changes stored by 1.0 and 1.1 describe as before, except a sentence with more than three enclosing items, which now starts with "…" (see `maxParents`).

- **Recursive schemas.** A `$ref` may point back to a definition it sits inside, so a part can contain parts; the data decides the depth, up to `maxDepth` (default still 32). A `$ref` loop that never reaches a property or list item is still `INVALID_SCHEMA`. Recursive definitions are built once and reused, and their `schemaPath` names the definition (`/$defs/part/properties/qty`), so every level shares one path. A list directly inside an item of the same definition adds no title of its own: "Parts › Body › Sleeve".
- **Labels file entries for definitions:** a key starting with `$defs/` applies wherever that definition is used, such as `"$defs/part/qty"` or `"$defs/partList#key"`. Path entries still win at their own place.
- **`maxParents`** (`describe`, default 3): a sentence names at most this many enclosing items, after "…": "… › Body › Sleeve › Cuff: Quantity changed from 2 to 3". `labels` always holds the full path. A 1.x change with more than three enclosing items reads shortened too; pass `maxParents: Infinity` for the 1.1 wording.
- **No stack overflow at any depth.** The diff walk, value copies, equality and input checks use an explicit stack, tested at `maxDepth` 10,000.
- **Objects as one value** (`x-atomic: true`, or `#atomic` in the labels file): compared by `x-key` when both sides have it, else as a whole, and named by `x-label`, a template or `"@lang"`. A renamed option under the same key is no change. Lists of atomic values are matched by key. Sensitive fields inside are stripped and not compared. `x-atomic` on a schema that isn't an object is `INVALID_SCHEMA`.
- **Labels in every language:** `x-title`, `x-itemNoun`, `oneOf` entries' `x-title`, labels file values, `"@lang"` objects, and `x-label` fields that hold language maps. `labels` and `display` labels stay strings, in the new `diffRecords` option `fallbackLanguage` (default `en`); the maps travel in the new optional `display.i18n`. `describe` takes `language` (default: the language part of `locale`) and `fallbackLanguage`, and picks the exact language, its base, the fallback, then the map's first language, skipping keys that start with `$`. `translateLabel` is not called for labels stored with a map.
- **Moves across parents** (`x-key-scope: "tree"`, or `#scope` in the labels file): an item whose parent differs between versions is one `ITEM_MOVED`, "Part "Cuff" moved from Sleeve to Collar", followed by its own field changes at the new place. It is named as it is after the edit. A child that stays under its moving parent is not moved. A key used twice in one tree throws `DUPLICATE_KEY`, with both paths in the new `DiffError.paths`. Only lists of the same definition form a tree.
- `x-label` templates whose fields hold a language-map object now read the map in the stored language; 1.1 printed the object as JSON.
- **New error cases, no new codes:** `INVALID_OPTION` for an invalid `fallbackLanguage`, `language` or `maxParents`; `INVALID_SCHEMA` for `x-atomic`, `x-key-scope`, `x-title` or `x-itemNoun` values it can't read, and for a language map where the labels file needs text (`#key`, `#label`, `#atomic`, `#scope`); `SENSITIVE_KEY` for an atomic key or label that uses a sensitive field.
- **New code** `ITEM_MOVED`, message keys `ITEM_MOVED` and `ITEM_MOVED:redacted`, and template tokens `{from}` and `{to}`.
- New optional fields: `ChangeDisplay.fromParent`, `toParent`, `fromItemLabels` and `i18n`; `Adapter.recordNounI18n`; `titleI18n` on nodes, `itemNounI18n`, `def` and `keyScope` on lists, `valueLabelsI18n` and `atomic` on values; `DiffError.paths`. New types `LangMap`, `ChangeI18n` and `AtomicSpec`.
- The bundle limit is 14 KB gzipped and 36 KB minified, up from 10 KB and 24 KB, for these features: the main entry is 12.4 KB gzipped.

## 1.1.0 (2026-10-21)

The 1.1 candidates from the 1.0.0 edge-case round (#1 to #8). Some codes, stored changes and errors differ from 1.0.x, as listed.

- **Map entries** (#3, #4): keys not in `properties` use the first matching `patternProperties` schema, else `additionalProperties`: its type, format, value labels and sensitivity, with `inSchema: true`, labelled with the key as written. In 1.0.x they were fields the schema doesn't describe.
- **`allOf`** (#5) is merged: keywords on the field itself win, then entries in order, with `properties` combined. In 1.0.x a field described only through `allOf` was compared as one value.
- **`LIST_REORDERED`** (#2) stores only the moved items' keys, at most 100, with the count in `display.moved`. In 1.0.x it stored every matched key, twice.
- **Labels file** (#6): `adapter.unusedLabels` lists entries that match no field; `strictLabels: true` refuses them with `UNKNOWN_LABEL`.
- **Inputs that are now refused.** These worked in 1.0.x, or failed with a different error, and now throw:
  - `INVALID_RECORD`: a record that is not a plain object or `null`, such as an array. 1.0.x threw `NOT_JSON`.
  - `INVALID_KEY`: an item key that is an object or an array. 1.0.x accepted it and matched by its JSON.
  - `UNKNOWN_LABEL`: a labels file entry that matches no field, only with the new `strictLabels: true`. Without it, entries are still accepted and listed in `unusedLabels`.
  - `INVALID_OPTION`: an invalid `locale`, `timeZone` or `maxValueLength` passed to `describe`, even when no change needs it, and an invalid `maxChanges` or `maxDepth` passed to `diffRecords`. 1.0.x threw a raw `RangeError`, from `describe` only when a change needed the option.
- **New error codes:** `INVALID_KEY` (#1), `INVALID_RECORD` (#7), `INVALID_OPTION` (#8) and `UNKNOWN_LABEL` (#6), as above.
- `ChangeDisplay.moved`, `Adapter.unusedLabels`, `ObjectNode.patterns` and `ObjectNode.additional` are new optional fields; `PatternEntry` is a new type.

## 1.0.1 (2026-10-21)

Sentence fixes from the 1.0.0 edge-case round. Codes and stored changes are unchanged.

- Integers above 2^53 print as the number stored, not rounded by `Intl` to 17 significant digits.
- `maxValueLength` counts user-perceived characters, so a cut never splits an emoji sequence, a flag or a letter such as Tamil "ழ்".
- Newlines in values show as ↵ and tabs as ⇥, and other control characters as their control pictures, so a sentence stays on one line and invisible differences show. Stored values are untouched.
- Two text values that differ only in Unicode form (NFC versus NFD) end with "(Unicode form changed)". It has its own message key, `FIELD_CHANGED:unicode`.
- Two date-times that are the same instant written with different offsets show their offsets: "10:00 am (+05:30) to 10:00 am (+00:00)". Date-times that differ only below a minute, or in precision, are shown as written.
- `describe` no longer throws on a change without a `display` block; it reads as untyped.
- README: rendering notes (escape `parts`, isolate mixed-direction text), the install line, values compared exactly (spaces-only values, `1` versus `"1"` keys), and ESM-only, with `require` on Node 20.19+ and 22.12+.

## 1.0.0 (2026-10-21)

First stable release. No API changes since 1.0.0-rc.1.

- `jsonSchemaAdapter`, `diffRecords`, `describe` and `describeChanges`.
- Changes with stable codes, list matching by key, redaction of sensitive fields, ignore paths and limits.
- Each change carries its own display details, so stored changes can be described later without the adapter.
- English sentences formatted with `Intl`; wording and translation through `messages` and `translateLabel`.
- Zero dependencies; Node 18 and later, and browsers.
- README: key items by fields that never change; set acronyms in the labels file; use `x-label` to name composite-key items.
