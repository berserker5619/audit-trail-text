# audit-trail-text

Give it two versions of a record and its JSON Schema, and it tells you what changed: structured changes with stable codes, and one plain sentence per change. Field names, value labels and item names come from the schema, so there is no key-to-label mapping to write by hand.

- Pure functions with zero dependencies, for Node (18 and later) and the browser.
- Nested objects, lists of plain values, and lists of objects matched by key.
- Sensitive fields are reported without their values.
- Changes are plain JSON your app can store, and describe later in any wording or language.

```sh
npm install audit-trail-text@next   # 1.0 release candidate
```

## Before and after

```ts
import { describeChanges, diffRecords, describe, jsonSchemaAdapter } from 'audit-trail-text';

const contactSchema = {
  title: 'Contact',
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    phone: { type: 'string', title: 'Phone' },
    status: {
      type: 'string',
      title: 'Status',
      oneOf: [
        { const: 'lead', title: 'Lead' },
        { const: 'active', title: 'Active customer' },
      ],
    },
    password: { type: 'string', writeOnly: true },
    orders: {
      type: 'array',
      title: 'Orders',
      'x-key': 'id',          // matches orders across versions
      'x-label': '{product}', // names an order in sentences
      items: {
        type: 'object',
        title: 'Order',
        properties: {
          id: { type: 'string' },
          product: { type: 'string' },
          qty: { type: 'integer', title: 'Quantity' },
        },
      },
    },
  },
};

const before = {
  name: 'Rajesh Kumar', phone: '98400 11111', status: 'lead',
  orders: [
    { id: 'A1', product: 'Blue kurta', qty: 2 },
    { id: 'A2', product: 'Red saree', qty: 1 },
  ],
};
const after = {
  name: 'Rajesh Kumar', phone: '98400 22222', status: 'active',
  orders: [{ id: 'A1', product: 'Blue kurta', qty: 3 }],
};

const adapter = jsonSchemaAdapter(contactSchema); // read the schema once, reuse it

describeChanges(before, after, adapter, { locale: 'en-IN' }).map((s) => s.text);
// → ["Phone changed from \"98400 11111\" to \"98400 22222\"",
//    "Status changed from Lead to Active customer",
//    "Orders › Blue kurta: Quantity changed from 2 to 3",
//    "Order \"Red saree\" removed from Orders"]
```

Lists of objects are matched by key, never by position. Matched by position, this history would read as if the kurta became a saree. A list of objects with no key in the schema or labels file is refused with `LIST_KEY_MISSING` when the adapter is made.

Key an item by what never changes for it, such as an id. A changed key reads as one item removed and another added: with a key of `["component", "supplier"]`, switching a button's supplier gives `BOM line "Button (YKK)" removed` and `BOM line "Button (Shingora)" added`, not "Supplier changed".

## What it reads from the schema

| Keyword | Used for |
| --- | --- |
| `title` | Field name. Without one, the key in Title Case: `primaryAddress` → "Primary Address" |
| `title` at the root | Record noun: "Contact created". Default "Record" |
| `items.title` | Singular name for list items: "Order". Default "Item" |
| `format: date`, `date-time` | Shown as dates. Date-only values are never shifted by time zone |
| `type: number`, `integer` | Shown with locale digits: "1,25,000" in en-IN |
| `type: boolean` | "Yes" / "No" |
| `oneOf: [{ const, title }]` | Stored code shown by its label: `active` → "Active customer" |
| `enum` | Shown as the stored code, unquoted |
| `writeOnly: true` or `x-sensitive: true` | Values never stored or shown: "Password changed" |
| `x-key` on an array | Field, or array of fields, that identifies an item |
| `x-label` on an array | Item name template: `"{firstName} {lastName}"`. Default: the key value |
| `$ref` to `#/$defs/…` | Followed. External and recursive refs are refused with `INVALID_SCHEMA` |

Fields the schema doesn't describe are still reported, after the schema's fields, labelled from their key.

## The labels file

When you can't or don't want to put labels in the schema, pass them separately. Entries always win over the schema. Keys are record paths with `*` for list items, followed by `#key`, `#label` or `=value` where needed.

```ts
const plainSchema = {
  type: 'object',
  properties: {
    ph: { type: 'string' },
    stage: { type: 'string' },
    lines: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, size: { type: 'string' }, qty: { type: 'integer' } } } },
  },
};

const labels = {
  '#record': 'Customer',      // record noun
  '/ph': 'Phone',             // field title
  '/stage=won': 'Won',        // label for a stored value
  '/lines/*': 'Line',         // item noun
  '/lines#key': 'sku,size',   // composite key, comma-separated
  '/lines#label': '{sku} ({size})',
  '/lines/*/qty': 'Quantity', // field inside list items
};

const labelled = jsonSchemaAdapter(plainSchema, { labels });

describeChanges(
  { ph: '1', stage: 'open', lines: [{ sku: 'K1', size: 'M', qty: 1 }] },
  { ph: '2', stage: 'won', lines: [{ sku: 'K1', size: 'M', qty: 2 }, { sku: 'K1', size: 'L', qty: 1 }] },
  labelled,
).map((s) => s.text);
// → ["Phone changed from \"1\" to \"2\"",
//    "Stage changed from open to Won",
//    "Lines › K1 (M): Quantity changed from 1 to 2",
//    "Line \"K1 (L)\" added to Lines"]
```

Without a label template, an item with a composite key is named by its key values, such as "M, Regular", which reads awkwardly inside a path like "Colourways › Navy › Sizes › M, Regular: …". Give the list an `x-label` in the schema, or a `#label` entry as above, to name it the way people say it: `"{size} {fit}"` gives "M Regular".

A field with no title gets its key in Title Case, so `zohoId` reads "Zoho Id". Set acronyms and other spellings in the labels file:

```ts
const zoho = jsonSchemaAdapter({ type: 'object', properties: { zohoId: { type: 'string' } } }, { labels: { '/zohoId': 'Zoho ID' } });

describeChanges({ zohoId: 'Z-1' }, { zohoId: 'Z-2' }, zoho)[0].text;
// → "Zoho ID changed from \"Z-1\" to \"Z-2\""
```

## Changes

`diffRecords` returns a flat array of changes. Apps filter and branch on `code`, never on sentence text.

| Code | When | Default sentence |
| --- | --- | --- |
| `FIELD_SET` | Empty before, has a value after | Email set to "r.kumar@example.com". For an object: Address added |
| `FIELD_CLEARED` | Had a value, empty after | Email cleared (was "r.kumar@example.com"). For an object: Address removed |
| `FIELD_CHANGED` | Value differs | Phone changed from "98400 11111" to "98400 22222" |
| `ITEM_ADDED` | List item with no match in `before` | Order "Green dupatta" added to Orders |
| `ITEM_REMOVED` | List item with no match in `after` | Order "Red saree" removed from Orders |
| `LIST_REORDERED` | The relative order of matched items changed | Orders reordered |
| `RECORD_CREATED` | `before` is `null` | Contact created |
| `RECORD_DELETED` | `after` is `null` | Contact deleted |
| `TRUNCATED` | `maxChanges` reached | More changes not shown |

Empty means `undefined`, `null`, `""` or `{}`. A missing or `null` list counts as `[]`, so a first item is `ITEM_ADDED`. Lists of plain values are compared by value, counting duplicates, and their order is never reported.

Each change is plain, JSON-safe data:

```ts
diffRecords(before, after, adapter)[2];
// → {"code": "FIELD_CHANGED",
//    "beforePath": "/orders/0/qty",
//    "afterPath": "/orders/0/qty",
//    "schemaPath": "/properties/orders/items/properties/qty",
//    "labels": ["Orders", "Blue kurta", "Quantity"],
//    "before": 2,
//    "after": 3,
//    "item": {"key": "A1", "label": "Blue kurta"},
//    "display": {"type": "integer", "itemLabels": [1]},
//    "inSchema": true}
```

`beforePath` and `afterPath` are JSON Pointers into each version, so they differ when an item moved. `display` holds what `describe` needs: the type, the format, labels for these values, and the item noun.

### Options

```ts
const diffOptions = {
  ignore: ['/updatedAt', '/orders/*/syncedAt'], // never reported, and stripped from stored values
  maxChanges: 200,      // default 1,000; past it, the walk stops and adds one TRUNCATED
  expandObjects: false, // true lists the fields of an object that appears, instead of "Address added"
  maxDepth: 32,         // deeper records throw TOO_DEEP
};

diffRecords({ name: 'R', updatedAt: '1' }, { name: 'R', updatedAt: '2' }, adapter, diffOptions).length;
// → 0
```

### Sensitive fields

A field marked `writeOnly` or `x-sensitive` is reported without its values, and is stripped from every whole record or item a change carries, so it never reaches your audit table.

```ts
const pw = diffRecords({ password: 'old' }, { password: 'new' }, adapter)[0];
[pw.redacted, 'before' in pw, 'after' in pw];
// → [true, false, false]

describe([pw]).map((s) => s.text);
// → ["Password changed"]
```

### Errors

Errors are `DiffError` with a stable `code` and a `path`. The adapter refuses schemas it can't use: `INVALID_SCHEMA`, `LIST_KEY_MISSING`, `KEY_NOT_IN_SCHEMA`, and `SENSITIVE_KEY` (a key or item label that uses a sensitive field). `diffRecords` throws `ITEM_KEY_MISSING`, `DUPLICATE_KEY`, `TOO_DEEP` and `NOT_JSON` (functions, `Date` objects, `NaN`, cycles: convert dates to strings first).

```ts
let code = '';
try {
  diffRecords({}, { orders: [{ product: 'No id' }] }, adapter);
} catch (e) {
  code = `${e.code} at ${e.path}`;
}
code;
// → "ITEM_KEY_MISSING at /orders/0"
```

## Storing changes and describing them later

Store the changes, not the sentences. A stored change carries its own display details, so `describe` needs no adapter, and a change stored last year reads the same after the schema or labels change.

```ts
const stored = JSON.stringify(diffRecords(before, after, adapter)); // into your audit table

// Later, maybe in the browser:
describe(JSON.parse(stored), { locale: 'en-IN', timeZone: 'Asia/Kolkata' }).map((s) => s.text);
// → ["Phone changed from \"98400 11111\" to \"98400 22222\"",
//    "Status changed from Lead to Active customer",
//    "Orders › Blue kurta: Quantity changed from 2 to 3",
//    "Order \"Red saree\" removed from Orders"]
```

Each sentence also has `parts`, so a UI can bold field names or values without parsing the text:

```ts
describe(JSON.parse(stored))[0].parts;
// → [{"type": "field", "text": "Phone"},
//    {"type": "text", "text": " changed from \""},
//    {"type": "value", "text": "98400 11111"},
//    {"type": "text", "text": "\" to \""},
//    {"type": "value", "text": "98400 22222"},
//    {"type": "text", "text": "\""}]
```

Values are formatted with `Intl` for `locale` (default `en`) and `timeZone` (default `UTC`). Neither is ever read from the machine, so server and browser give the same text. Long values are cut at `maxValueLength` (default 80) with "…"; the raw values stay whole in the change.

## Wording and translation

The package ships English templates. `messages` replaces any of them, which is also how you add a language. Templates are strings with tokens `{field}`, `{parents}`, `{before}`, `{after}`, `{item}`, `{itemNoun}`, `{list}` and `{record}`:

```ts
describe(JSON.parse(stored), { messages: { FIELD_CHANGED: '{field}: {before} → {after}' } })[0].text;
// → "Phone: \"98400 11111\" → \"98400 22222\""
```

The default templates put a nested field's parents first ("Orders › Blue kurta: …"); so do templates of your own, unless they place `{parents}` themselves. Some changes have variants, such as `FIELD_CHANGED:redacted`, `FIELD_SET:whole` (an object appearing) and `ITEM_ADDED:value` (a plain value added to a list). A variant falls back to its code's template, then to English. `defaultMessages` lists every key.

When a language needs grammar a string can't express, a template can be a function of the change and its formatted values:

```ts
const fr = {
  FIELD_CHANGED: '{field} : {before} → {after}',
  ITEM_REMOVED: (change, v) => `${v.itemNoun} « ${v.item} » retirée de ${v.list}`,
};
const frLabels = { Orders: 'Commandes', Order: 'Commande', Quantity: 'Quantité', Phone: 'Téléphone', Status: 'Statut' };

describe(JSON.parse(stored), { locale: 'fr-FR', messages: fr, translateLabel: (label) => frLabels[label] ?? label })
  .map((s) => s.text);
// → ["Téléphone : \"98400 11111\" → \"98400 22222\"",
//    "Statut : Lead → Active customer",
//    "Commandes › Blue kurta: Quantité : 2 → 3",
//    "Commande « Red saree » retirée de Commandes"]
```

`translateLabel(label, { kind, schemaPath })` translates your own words: field and list titles, item nouns and the record noun, with `kind` set to `field`, `list`, `itemNoun` or `record`. Item names such as "Blue kurta" are data and never go through it. Value labels such as "Active customer" come from the schema, so translate them with a translated schema or labels file. The package never ships translations of an app's own words.

## License

MIT
