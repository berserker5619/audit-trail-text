# Changelog

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
