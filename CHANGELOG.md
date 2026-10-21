# Changelog

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
