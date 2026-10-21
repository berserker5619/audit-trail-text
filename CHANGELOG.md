# Changelog

## 1.0.0 (2026-10-21)

First stable release. No API changes since 1.0.0-rc.1.

- `jsonSchemaAdapter`, `diffRecords`, `describe` and `describeChanges`.
- Changes with stable codes, list matching by key, redaction of sensitive fields, ignore paths and limits.
- Each change carries its own display details, so stored changes can be described later without the adapter.
- English sentences formatted with `Intl`; wording and translation through `messages` and `translateLabel`.
- Zero dependencies; Node 18 and later, and browsers.
- README: key items by fields that never change; set acronyms in the labels file; use `x-label` to name composite-key items.
