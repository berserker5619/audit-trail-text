export type ChangeCode =
  | 'FIELD_SET'
  | 'FIELD_CLEARED'
  | 'FIELD_CHANGED'
  | 'ITEM_ADDED'
  | 'ITEM_REMOVED'
  | 'LIST_REORDERED'
  | 'ITEM_MOVED'
  | 'RECORD_CREATED'
  | 'RECORD_DELETED'
  | 'TRUNCATED';

/** The list item a change belongs to. Composite keys hold their values in key order. */
export interface ItemRef {
  key: unknown;
  label: string;
}

/** One change. Plain, JSON-safe data an app can store and describe later. */
export interface Change {
  code: ChangeCode;
  /** JSON Pointer into `before`; absent for added items and created records. */
  beforePath?: string;
  /** JSON Pointer into `after`; absent for removed items and deleted records. */
  afterPath?: string;
  /** Where the field sits in the schema; absent when `inSchema` is false. */
  schemaPath?: string;
  labels: string[];
  /** Raw values, with sensitive and ignored fields stripped. Left out when redacted. */
  before?: unknown;
  after?: unknown;
  item?: ItemRef;
  /** What `describe` needs, frozen at diff time, so a stored change reads the same later. */
  display: ChangeDisplay;
  /** Sensitive field: values left out. */
  redacted?: true;
  inSchema: boolean;
}

export interface ChangeDisplay {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  /** "decimal": an exact number stored as text, such as "12.50", shown as a number. */
  format?: 'date' | 'date-time' | 'decimal';
  /** Label for this before value: a `oneOf` title, or the code itself for coded fields. */
  beforeLabel?: string;
  afterLabel?: string;
  /** Singular name for the list's items: "Order". */
  itemNoun?: string;
  /** Positions in `labels` that hold item names, which are data and never translated. */
  itemLabels?: number[];
  /** LIST_REORDERED: how many items moved; `before` and `after` hold at most 100 of their keys. */
  moved?: number;
  /** ITEM_MOVED: the labels of the place the item left, ending with its parent. */
  fromParent?: string[];
  /** ITEM_MOVED: the labels of the place the item went to: `labels` without the item's name. */
  toParent?: string[];
  /** Positions in `fromParent` that hold item names. */
  fromItemLabels?: number[];
  /** Labels in every language, where the schema or labels file gave a language map. */
  i18n?: ChangeI18n;
}

/** A label in several languages: `{ "en": "Status", "de": "Status" }`. Keys starting with `$` are not languages. */
export type LangMap = Record<string, string>;

export interface ChangeI18n {
  /** Same positions as `labels`; null where the label was a plain string. */
  labels?: (LangMap | null)[];
  beforeLabel?: LangMap;
  afterLabel?: LangMap;
  itemNoun?: LangMap;
  /** Same positions as `fromParent`. */
  fromParent?: (LangMap | null)[];
}

interface NodeBase {
  title: string;
  /** The title in every language, from `x-title` or a labels file map; `title` is its fallback text. */
  titleI18n?: LangMap;
  schemaPath: string;
  /** Marked sensitive here or by a parent. */
  sensitive: boolean;
  /** Marked sensitive by its own schema (`writeOnly` or `x-sensitive`). */
  ownSensitive: boolean;
}

export interface ValueNode extends NodeBase {
  kind: 'value';
  type?: string;
  format?: string;
  /** Stored value (as `String(value)`) → label. */
  valueLabels: ReadonlyMap<string, string>;
  /** Stored codes (`enum`, `oneOf` or labels file values): shown by label or as the code, never quoted. */
  coded?: true;
  /** Value labels in every language, by stored value. */
  valueLabelsI18n?: ReadonlyMap<string, LangMap>;
  /** An object compared and shown as one value (`x-atomic`). */
  atomic?: AtomicSpec;
}

export interface AtomicSpec {
  /** Fields that decide equality. When either side lacks one, the whole objects are compared. */
  key: readonly string[];
  /** Label template such as "{amount} {currency}", or "@lang" for an object that is a language map. */
  label?: string;
  /** Fields marked sensitive in its schema: never stored, and not compared. */
  sensitive?: readonly string[];
}

export interface ObjectNode extends NodeBase {
  kind: 'object';
  /** In schema order. */
  properties: ReadonlyMap<string, FieldNode>;
  /** `patternProperties`, in schema order: a key not in `properties` takes the first match. */
  patterns?: readonly PatternEntry[];
  /** `additionalProperties`: keys matching neither `properties` nor a pattern. */
  additional?: FieldNode;
}

export interface PatternEntry {
  pattern: RegExp;
  node: FieldNode;
}

export interface ObjectListNode extends NodeBase {
  kind: 'objectList';
  itemNoun: string;
  itemNounI18n?: LangMap;
  /** The `$ref` of a recursive list definition: lists with the same `def` are one tree. */
  def?: string;
  /** "tree": a key names one item across every list with the same `def` (or this list's schemaPath). */
  keyScope?: 'list' | 'tree';
  /** Fields that identify an item, in key order. */
  key: readonly string[];
  /** Item name template, such as "{product}". */
  itemLabel?: string;
  item: ObjectNode;
}

export interface ValueListNode extends NodeBase {
  kind: 'valueList';
  itemNoun: string;
  itemNounI18n?: LangMap;
  item: FieldNode;
}

export type FieldNode = ValueNode | ObjectNode | ObjectListNode | ValueListNode;

/** What `diffRecords` needs from a schema. Apps with their own schema format can build one. */
export interface Adapter {
  /** Record noun, such as "Contact". */
  recordNoun: string;
  /** The record noun in every language. */
  recordNounI18n?: LangMap;
  root: ObjectNode;
  /** Labels file entries that matched no field, such as typos. */
  unusedLabels?: readonly string[];
}

export interface DiffOptions {
  /** Paths never reported or stored, with `*` for list items: "/orders/*\/syncedAt". */
  ignore?: readonly string[];
  /** Default 1,000. Past it, the walk stops and adds one TRUNCATED change. */
  maxChanges?: number;
  /** List the fields of an object that appears or disappears, instead of one change. */
  expandObjects?: boolean;
  /** Default 32. Deeper records throw TOO_DEEP. */
  maxDepth?: number;
  /** Default "en". The language that language-map labels are resolved in for `labels` and `display`. */
  fallbackLanguage?: string;
}
