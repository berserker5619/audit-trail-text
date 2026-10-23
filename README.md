# audit-trail-text

Give it two versions of a record and its JSON Schema, and it tells you what changed: structured changes with stable codes, and one plain sentence per change. Field names, value labels and item names come from the schema, so there is no key-to-label mapping to write by hand.

- Pure functions with zero dependencies, for Node (18 and later) and the browser.
- Nested objects, lists of plain values, and lists of objects matched by key.
- Trees of any depth, such as a bill of materials, with items moved from one parent to another.
- Labels in every language: a change keeps them all, and is read in the reader's.
- Sensitive fields are reported without their values.
- Changes are plain JSON your app can store, and describe later in any wording or language.
- A Mongoose plugin, `audit-trail-text/mongoose`, that records every change to a document and reads it back as sentences.

```sh
npm install audit-trail-text
```

The package is ESM-only: use `import`. `require('audit-trail-text')` works only on Node versions that can require ES modules, Node 20.19 and later or 22.12 and later; on Node 18 it fails with `ERR_REQUIRE_ESM`. A TypeScript project compiled to CommonJS can load it with a dynamic `import()`.

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
| `format: decimal` | An exact number stored as text, such as `"1234.50"`: shown as a number with every digit kept, "1,234.50", not quoted |
| `type: number`, `integer` | Shown with locale digits: "1,25,000" in en-IN |
| `type: boolean` | "Yes" / "No" |
| `oneOf: [{ const, title }]` | Stored code shown by its label: `active` → "Active customer" |
| `enum` | Shown as the stored code, unquoted |
| `writeOnly: true` or `x-sensitive: true` | Values never stored or shown: "Password changed" |
| `x-key` on an array | Field, or array of fields, that identifies an item |
| `x-label` on an array | Item name template: `"{firstName} {lastName}"`. Default: the key value |
| `x-key-scope: "tree"` on an array | A key names one item across every list of the same definition, so a move between parents reads as one move. Default `"list"` |
| `x-atomic: true` on an object | Compared and shown as one value, such as a chosen option: by `x-key`, named by `x-label` |
| `x-title`, `x-itemNoun` | A title, or a list's item noun, as text or a language map: `{ "en": "Status", "de": "Status" }`. Wins over `title` |
| `$ref` to `#/$defs/…` | Followed, also back into a definition it sits in, so a part can contain parts. External refs, and loops that never reach a property or item, are refused with `INVALID_SCHEMA` |
| `allOf` | Merged: keywords on the field itself win, then each entry in order; `properties` are combined |
| `patternProperties`, `additionalProperties` | Map entries, such as `{ "en": "Rose", "ta": "ரோஜா" }`: each key not in `properties` uses the first matching pattern's schema, else `additionalProperties`, and is labelled with the key as written |

Fields the schema doesn't describe are still reported, after the schema's fields, labelled from their key.

## The labels file

When you can't or don't want to put labels in the schema, pass them separately. Entries always win over the schema. Keys are record paths with `*` for list items, followed by `#key`, `#label`, `#atomic`, `#scope` or `=value` where needed. A key starting with `$defs/`, such as `"$defs/part/qty"` or `"$defs/partList#key"`, applies wherever that definition is used; a path entry still wins at its own place. Titles, item nouns, the record noun and value labels may be language maps: `"/status": { "en": "Status", "de": "Status" }`.

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

A labels file entry that matches no field, such as a typo, is listed in `adapter.unusedLabels`. Pass `strictLabels: true` to refuse it with `UNKNOWN_LABEL` instead:

```ts
jsonSchemaAdapter(plainSchema, { labels: { ...labels, '/phnoe': 'Phone' } }).unusedLabels;
// → ["/phnoe"]
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
| `ITEM_MOVED` | With `x-key-scope: "tree"`, an item now under another parent | Part "Cuff" moved from Sleeve to Collar |
| `RECORD_CREATED` | `before` is `null` | Contact created |
| `RECORD_DELETED` | `after` is `null` | Contact deleted |
| `TRUNCATED` | `maxChanges` reached | More changes not shown |

Empty means `undefined`, `null`, `""` or `{}`. A missing or `null` list counts as `[]`, so a first item is `ITEM_ADDED`. Lists of plain values are compared by value, counting duplicates, and their order is never reported.

Values are compared exactly, by design:

- A value of only spaces is not empty, so `""` to `" "` is `FIELD_SET`. Trim values before diffing if spaces don't matter to you.
- `1` and `"1"` are different values, and different item keys: an order keyed `1` that comes back keyed `"1"` reads as one order removed and another added. Store keys with one type.

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

A `LIST_REORDERED` change stores only the items that moved: all but a longest run of items that kept their order. `before` and `after` hold their keys, in each order, at most 100 of them; `display.moved` has how many moved. Swapping two orders moves one of them:

```ts
diffRecords(
  { orders: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] },
  { orders: [{ id: 'A3' }, { id: 'A1' }, { id: 'A2' }] },
  adapter,
).map((c) => [c.code, c.before, c.after, c.display.moved]);
// → [["LIST_REORDERED", ["A3"], ["A3"], 1]]
```

### Options

```ts
const diffOptions = {
  ignore: ['/updatedAt', '/orders/*/syncedAt'], // never reported, and stripped from stored values
  maxChanges: 200,      // default 1,000; past it, the walk stops and adds one TRUNCATED
  expandObjects: false, // true lists the fields of an object that appears, instead of "Address added"
  maxDepth: 32,         // deeper records throw TOO_DEEP; raise it for deep trees
  fallbackLanguage: 'en', // the language labels are stored in, from language maps
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

Errors are `DiffError` with a stable `code` and a `path`:

| Code | From | When |
| --- | --- | --- |
| `INVALID_SCHEMA` | adapter | A schema it can't read: an external `$ref`, a `$ref` loop that describes no data, an invalid pattern, `x-atomic` on a schema that isn't an object |
| `LIST_KEY_MISSING` | adapter | A list of objects with no `x-key` or `#key` |
| `KEY_NOT_IN_SCHEMA` | adapter | A key field the item schema doesn't have |
| `SENSITIVE_KEY` | adapter | A key or item label that uses a sensitive field |
| `UNKNOWN_LABEL` | adapter | With `strictLabels`, a labels file entry that matches no field |
| `ITEM_KEY_MISSING` | `diffRecords` | An item without its key, or with a key of `null` or `""` |
| `INVALID_KEY` | `diffRecords` | A key that is an object or an array; keys are strings, numbers or booleans |
| `DUPLICATE_KEY` | `diffRecords` | Two items in one list with the same key, or with tree scope, in one tree; `paths` has both |
| `INVALID_RECORD` | `diffRecords` | A record that is not a plain object or `null` |
| `TOO_DEEP` | `diffRecords` | A record nested deeper than `maxDepth` |
| `NOT_JSON` | `diffRecords` | Functions, `Date` objects, `NaN`, cycles: convert dates to strings first |
| `INVALID_OPTION` | both | An option that isn't valid, such as an unknown `timeZone`; `path` is the option's name |

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

The package ships English templates. `messages` replaces any of them, which is also how you add a language. Templates are strings with tokens `{field}`, `{parents}`, `{before}`, `{after}`, `{item}`, `{itemNoun}`, `{list}`, `{record}`, and `{from}` and `{to}` for `ITEM_MOVED`:

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

`translateLabel(label, { kind, schemaPath })` translates your own words: field and list titles, item nouns and the record noun, with `kind` set to `field`, `list`, `itemNoun` or `record`. Item names such as "Blue kurta" are data and never go through it, and neither do labels stored with a language map, which are already in the reader's language (see below). Value labels such as "Active customer" come from the schema, so translate them with language maps, or a translated schema or labels file. The package never ships translations of an app's own words.

## Labels in every language

Any title, item noun, value label or record noun can be a language map. A change keeps every language, and `describe` picks one when it writes the sentence, so the same stored history reads in German for a German user:

```ts
const intl = jsonSchemaAdapter({
  type: 'object',
  properties: {
    stage: {
      type: 'string',
      'x-title': { en: 'Stage', de: 'Phase' },
      oneOf: [
        { const: 'open', title: 'Open', 'x-title': { en: 'Open', de: 'Offen' } },
        { const: 'won', title: 'Won', 'x-title': { en: 'Won', de: 'Gewonnen' } },
      ],
    },
  },
});
const stageChanges = diffRecords({ stage: 'open' }, { stage: 'won' }, intl);

describe(stageChanges, { locale: 'de-DE', messages: { FIELD_CHANGED: '{field} von {before} zu {after} geändert' } })[0].text;
// → "Phase von Offen zu Gewonnen geändert"

[stageChanges[0].labels, stageChanges[0].display.afterLabel, stageChanges[0].display.i18n.afterLabel];
// → [["Stage"], "Won", {"en": "Won", "de": "Gewonnen"}]
```

`labels` and the labels in `display` stay plain strings, in the `diffRecords` option `fallbackLanguage` (default `en`), so code that reads them sees no difference. The maps travel in `display.i18n`. `describe` reads a map in `language` (default: the language part of `locale`), trying the exact language (`de-CH`), its base (`de`), its own `fallbackLanguage` (default `en`), then the map's first language; keys starting with `$` are never languages. A change without `display.i18n` is read with its stored labels as they are.

Sentence templates are still English: pass `messages` for another language. Item names taken from your data are never translated.

## Objects as one value

Some objects are one value, not a set of fields: a chosen option, an amount with its currency, a linked record. `x-atomic: true` compares and reports such an object as one value. `x-key` names the fields that decide equality, and `x-label` names it: a template such as `"{amount} {currency}"`, or `"@lang"` for an object that is itself a language map:

```ts
const options = jsonSchemaAdapter({
  type: 'object',
  properties: {
    status: { title: 'Status', type: 'object', 'x-atomic': true, 'x-key': '$key', 'x-label': '@lang' },
  },
});

describeChanges({ status: { $key: 'lead', en: 'Lead' } }, { status: { $key: 'active', en: 'Active' } }, options)[0].text;
// → "Status changed from Lead to Active"

diffRecords({ status: { $key: 'active', en: 'Active' } }, { status: { $key: 'active', en: 'Enabled' } }, options).length;
// → 0
```

The second edit is no change: the key is the same, and only the option was renamed. When either side lacks the key, the whole objects are compared. A list of atomic values, such as a multi-select, is matched by key: "VIP added to Tags". `"/status#atomic": "$key"` in the labels file does the same for a schema you don't control. The raw objects are stored in `before` and `after`, without sensitive and ignored fields; sentences never print them.

## Trees

A `$ref` may point back to a definition it sits inside, so a part can contain parts to any depth. Inside a tree, a nested list adds no title of its own, so paths read "Parts › Body › Sleeve", and every level shares one `schemaPath`, such as `/$defs/part/properties/qty`.

With `x-key-scope: "tree"`, a key names one item across every list of the same definition, and an item that changes parent is one `ITEM_MOVED`, followed by its own field changes at the new place:

```ts
const bom = jsonSchemaAdapter({
  type: 'object',
  properties: { parts: { $ref: '#/$defs/partList' } },
  $defs: {
    partList: { title: 'Parts', type: 'array', 'x-key': 'id', 'x-key-scope': 'tree', items: { $ref: '#/$defs/part' } },
    part: {
      title: 'Part',
      type: 'object',
      properties: { id: { type: 'string' }, qty: { type: 'integer', title: 'Quantity' }, parts: { $ref: '#/$defs/partList' } },
    },
  },
});

describeChanges(
  { parts: [{ id: 'Body', parts: [{ id: 'Sleeve', parts: [{ id: 'Cuff', qty: 2 }] }, { id: 'Collar' }] }] },
  { parts: [{ id: 'Body', parts: [{ id: 'Sleeve' }, { id: 'Collar', parts: [{ id: 'Cuff', qty: 3 }] }] }] },
  bom,
).map((s) => s.text);
// → ["Part \"Cuff\" moved from Sleeve to Collar",
//    "Parts › Body › Collar › Cuff: Quantity changed from 2 to 3"]
```

- An item is moved when its parent differs between the two versions. A child that stays under its moving parent is not moved; one that leaves for another parent in the same edit gets its own `ITEM_MOVED`.
- A moved item is named as it is after the edit. A rename shows as its own change.
- `{from}` and `{to}` name each parent by as many trailing labels as tell them apart: "from Shirt › Sleeve to Jacket › Sleeve".
- A key used twice in one tree throws `DUPLICATE_KEY` with both `paths`. Without tree scope, the same key under two parents is allowed, and a move reads as a remove and an add, as in 1.1.
- Only lists of the same definition form a tree: a line moved from an order to a quote is a remove and an add.

Sentences name at most `maxParents` enclosing items (default 3): "… › Sleeve › Cuff › Button: Quantity changed from 1 to 2". `labels` always holds the full path; pass `maxParents: Infinity` for whole paths.

The data decides the depth, up to `maxDepth` (default 32): raise it for deep trees. The walk uses no recursion, so a raised `maxDepth` can't overflow the stack. `JSON.stringify` itself fails on values nested a few thousand levels deep, so for very deep trees, store changes with a serializer that handles that depth.

## Mongoose

`audit-trail-text/mongoose` is a Mongoose plugin that records every create, update and delete made through Mongoose, in an audit collection, and reads a document's history back as sentences. It works with Mongoose 7, 8 and 9, which is an optional peer dependency: the main entry never loads it, and the plugin itself never imports Mongoose, so it uses the app's own copy. Server-only.

```js
import mongoose from 'mongoose';
import { auditTrail, auditContext } from 'audit-trail-text/mongoose';

const orderSchema = new mongoose.Schema({
  customer: { type: String, title: 'Customer' },
  status: { type: String, enum: ['open', 'paid', 'shipped'], title: 'Status' },
  items: [{ product: { type: String, title: 'Product' }, qty: { type: Number, title: 'Quantity' } }],
  cardToken: { type: String, select: false }, // recorded as changed, never with its value
}, { timestamps: true });

orderSchema.plugin(auditTrail, {
  labels: { '/items#label': '{product}' }, // the same labels file as the core
});

const Order = mongoose.model('Order', orderSchema);

// Express middleware: who made every change in this request
app.use((req, res, next) => auditContext.run({ user: req.user?.id }, next));

await Order.findOneAndUpdate({ _id: id }, { $set: { 'items.1.qty': 2, status: 'paid' } });

await Order.history(id, { language: 'en', timeZone: 'Asia/Kolkata' });
// [{ at: 2026-10-23T09:12:00Z, user: 'u_41', operation: 'update',
//    sentences: ['Status changed from open to paid', 'Items › Red saree: Quantity changed from 1 to 2'],
//    changes: [...] }, ...]
```

### What it reads from the Mongoose schema

The plugin turns each model's schema into a JSON Schema, once, and hands it to `jsonSchemaAdapter` with the plugin's `labels`, so list keys, item names and value labels follow the rules above. `mongooseSchemaAdapter(schema, { labels, title })` is exported for apps that diff documents themselves.

| Mongoose | Treated as |
| --- | --- |
| `String`, `Number`, `Boolean` | Text, number, Yes/No |
| `enum` | A stored code, labelled from the labels file: `"/status=paid": "Paid"` |
| `Date` | A date-time in the reader's time zone; `auditFormat: 'date'` on the path for a date only |
| `ObjectId` | Its id as text. Populated documents are stored as their id |
| `Decimal128`, `BigInt` | An exact number (`format: decimal`): "1,234.50" |
| `Buffer` | Compared by its bytes, reported as changed without its value |
| `Mixed` | One value, compared whole, even when edited in place |
| `Map` | One change per key |
| Nested path, single subdocument | A nested object |
| Array of subdocuments | A list keyed by `_id`; named by `#label` in the labels file, else its id |
| Array of plain values | Compared by value, counting duplicates |
| A schema that contains itself | A tree, to any depth |
| Discriminators | Each document uses its own discriminator's schema |

Options read from a path:

- `title`: the field's name, as text or a language map (`{ en: 'Status', de: 'Zustand' }`). Without one, the key in Title Case.
- `auditSensitive: true`: recorded as changed, never with its value. Paths with `select: false` are sensitive too; the plugin's own reads ask for them (`+path`) so a change is still seen, then the value is stripped.
- `auditIgnore: true`: never recorded. `__v` and the schema's `timestamps` are always ignored, and virtuals and getters never recorded: values are read with `toObject({ depopulate, flattenMaps, virtuals: false, getters: false, transform: false })`, so a schema's own `toObject.transform` changes nothing.

A list of subdocuments with `_id: false` has no key unless the labels file names one (`"/lines#key": "sku"`). `mongooseSchemaAdapter` refuses it with `LIST_KEY_MISSING`; the plugin logs that once, when the model is compiled, and records the list as one whole value.

### What is recorded

Each write gives at most one entry per document, holding what changed between the document before and after. A write that changes nothing recordable gives none.

| Write | Before value | Recorded as |
| --- | --- | --- |
| `doc.save()`, new document; `Model.create()`; `insertMany()` | — | `create`, one per document; with `ordered: false`, only those inserted |
| `doc.save()`, existing document | The raw document Mongoose loaded, kept by reference (`captureOnLoad: false` reads it from the database instead) | `update` |
| `findOneAndUpdate`, `findOneAndReplace`, `updateOne`, `replaceOne` | A read just before the write, in its session, with its `sort` and `collation`. The write's filter is then narrowed to that document's `_id`, so the entry describes the document actually written | `update`, or `create` when an upsert inserts |
| `findOneAndDelete`, `deleteOne` (query or document) | The same read and narrowing | `delete` |
| `updateMany`, `deleteMany` | A read of every matching document | Only with `many: true`, up to `maxMany` (1,000) documents |

Not recorded: `bulkWrite`, and writes that bypass Mongoose (the driver, other services, the shell).

- The before read is an ordinary `findOne`, so plugins that add conditions to queries, such as tenancy or soft deletes, apply to it too.
- An upsert keeps its own filter: narrowed, a document that stopped matching would be inserted again under the same `_id`.
- Above `maxMany`, the write runs unaudited and `auditError` is emitted with `stage: 'maxMany'`. Without `many: true`, these writes are skipped with one warning per model.
- In a transaction, entries are held on the session and written after `commitTransaction()` succeeds, outside the transaction, so a failed audit write can never abort it. On abort they are dropped, and a retried `withTransaction()` callback never adds the failed attempt's entries.
- A `select: false` field changed on a document loaded without it: just that field is read before the save. This works for fields outside lists.

### Never blocks the app

No failure in the plugin reaches the app: its write runs as usual and returns its normal result. Failures are emitted on the model as `auditError`, `{ model, docId, operation, stage, error, entry? }`, with `stage` one of `schema`, `before`, `diff`, `after`, `write` or `maxMany`. A failed audit write carries the `entry`, so the app can retry it or store it elsewhere. Without a listener, the plugin logs through `logger` (default `console`), at most one line per model per minute. No option makes audit failures throw.

`auditTimeoutMS` (default 2,000) bounds what the plugin adds to one write: the before read, the after read and the audit write together. With `background: true`, the after read and the audit write run after the app's call returns; the before read still runs first. `await auditFlush()` waits for pending entries, for tests and shutdown.

### Who and why

Most specific first:

1. Per query: `{ audit: { user, reason } }` in the query's options, or `query.setOptions({ audit })`.
2. Per document: `doc.$locals.audit = { user, reason }` before `doc.save()` or `doc.deleteOne()`.
3. Per request: `auditContext.run({ user, reason }, fn)`, through Node's `AsyncLocalStorage`. Everything inside `fn` is attributed, including awaited calls; a query returned by `fn` is executed inside it. An inner `run` adds to the outer one.

`user` is any JSON-safe value, stored as given. `{ audit: { skip: true } }` or `auditContext.run({ skip: true }, fn)` records nothing, for migrations and seed scripts.

### Reading history

```js
const page = await Order.history(id, { limit: 50, language: 'de' });
const next = await Order.history(id, { after: page.at(-1)._id });
```

Entries come newest first, each with `sentences`. `history` takes the `describe` options, `limit` (default 50), `after` (the `_id` of the last entry shown: many entries can share one `at`, so paging never uses dates) and `session`. `historyMethod` renames the static; when the schema already has one of that name, the plugin leaves it alone and warns. In TypeScript, cast the model: `Order as typeof Order & AuditedModel`.

All models on a connection share one collection, `audit_trail` (option `collection`):

```ts
interface AuditEntry {
  _id: ObjectId;
  model: string;          // "Order"; a discriminator's base model
  docId: unknown;         // the document's _id
  operation: 'create' | 'update' | 'delete';
  at: Date;
  user?: unknown;
  reason?: string;
  changes: Change[];      // stand-alone: old entries read the same after the schema changes
  snapshot?: object;      // with snapshots: true, the document before an update, stripped
  importedFrom?: unknown; // the mongoose-audit log entry it came from
  v: 1;
}
```

The plugin creates `{ model: 1, docId: 1, at: -1, _id: -1 }` and a sparse `{ importedFrom: 1 }`, following the connection's `autoIndex`. To look up changes by person, add `{ user: 1, at: -1 }` yourself and describe what you find with `describeEntries(entries, options)`.

| Option | Default | |
| --- | --- | --- |
| `labels`, `strictLabels` | | The labels file, as for `jsonSchemaAdapter` |
| `collection` | `audit_trail` | |
| `many`, `maxMany` | `false`, 1,000 | Record `updateMany` and `deleteMany` |
| `snapshots` | `false` | Also store the document before each update. Creates and deletes already carry the whole document |
| `captureOnLoad` | `true` | Keep the loaded raw document for `save()` |
| `background` | `false` | |
| `auditTimeoutMS` | 2,000 | |
| `logger` | `console` | |
| `historyMethod` | `history` | |
| `diff` | | Compute the changes yourself: see below |

### Records another library describes

When a record's shape comes from somewhere other than its Mongoose schema, pass `diff`, and the plugin uses it in place of the adapter it builds. It gets each document's two versions as plain JSON, after the conversion above, with `__v` and timestamps dropped. A create's before is `null`, and so is a delete's after. It returns the changes: none means no entry, and a throw is an `auditError` at the `diff` stage. Everything else, from the reads to transactions, `auditError` and history, works as before.

With Dynamic Entity, every entity's records can live in one loose collection, each diffed against its own config, with its migrations and row ids applied the way DE does:

```js
import { diffEntityRecords, entityAuditAdapter } from '@dynamic-entity/core/history';

const configs = { contact: contactConfig, deal: dealConfig };
const adapters = Object.fromEntries(Object.entries(configs).map(([entity, config]) => [entity, entityAuditAdapter(config)]));

const recordSchema = new mongoose.Schema({ entity: String }, { strict: false });
recordSchema.plugin(auditTrail, {
  diff(before, after) {
    const { entity } = after ?? before;
    return diffEntityRecords(before, after, configs[entity], { adapter: adapters[entity], migrations: migrations[entity] });
  },
});

const Record = mongoose.model('Record', recordSchema);
await Record.history(id, { language: 'de' }); // the same sentences as describeEntityChanges
```

With `snapshots: true`, the snapshot is the `before` of the `RECORD_DELETED` change that `diff(before, null)` returns, so it is stripped the way the diff strips a delete.

### Moving from mongoose-audit

mongoose-audit 1.0 logs to an `auditlog` collection, `{ ts, operation, location, document, user }`. It logs in `pre('save')`, so the `document` of a `create` or `update` entry is the document after that change; a `delete` entry holds the document as it was. Each update is therefore diffed with the entry before it and keeps its own `ts` and `user`. A log that starts with an update (the document predates mongoose-audit) uses that version as the starting point, with no entry of its own. Bulk entries, which carry a `selector` instead of a document, and mongoose-audit's own fields `_createdAt`, `_updatedAt` and `_user` are skipped.

- `importMongooseAudit(Order, { from: 'auditlog' })` converts a model's log once into normal entries, oldest first, each with `importedFrom`, and returns `{ read, imported, skipped, failed }`. Running it again skips what it already imported. The old collection is only read.
- `historyFromSnapshots(log, adapter, { model })` reads one document's log entries as history without converting them.

Remove mongoose-audit's plugin, add this one, then run the import; both on one schema at once is not supported. Old documents are diffed with today's schema, so a field since removed reads with its key in Title Case and `inSchema: false`. Apps still on Mongoose 6 or older upgrade to 7 first.

## Rendering

`text` and the pieces in `parts` are plain text, built from your users' data. When you show them in HTML, escape them like any other user input: set `textContent`, or let your framework escape them. Never assign them to `innerHTML`.

Values can be in any script. When a sentence mixes directions, such as Arabic or Hebrew values in an English sentence, wrap each value in its own direction isolate so the punctuation around it stays in place: render each `value` part in `<bdi>`, or between U+2068 FIRST STRONG ISOLATE and U+2069 POP DIRECTIONAL ISOLATE in plain text.

Characters that print as nothing are shown visibly in sentences, never in the stored values: a newline as ↵, a tab as ⇥, other control characters as their control pictures (␀, ␛). When two text values differ only in Unicode form, such as "é" stored as one character or two, the sentence ends "(Unicode form changed)". When two date-times are the same instant written with different offsets, the offsets are shown: "10:00 am (+05:30) to 10:00 am (+00:00)".

## License

MIT
