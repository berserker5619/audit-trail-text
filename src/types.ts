export type ChangeCode =
  | 'FIELD_SET'
  | 'FIELD_CLEARED'
  | 'FIELD_CHANGED'
  | 'ITEM_ADDED'
  | 'ITEM_REMOVED'
  | 'LIST_REORDERED'
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
  format?: 'date' | 'date-time';
  /** Label for this before value: a `oneOf` title, or the code itself for coded fields. */
  beforeLabel?: string;
  afterLabel?: string;
  /** Singular name for the list's items: "Order". */
  itemNoun?: string;
  /** Positions in `labels` that hold item names, which are data and never translated. */
  itemLabels?: number[];
}

interface NodeBase {
  title: string;
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
}

export interface ObjectNode extends NodeBase {
  kind: 'object';
  /** In schema order. */
  properties: ReadonlyMap<string, FieldNode>;
}

export interface ObjectListNode extends NodeBase {
  kind: 'objectList';
  itemNoun: string;
  /** Fields that identify an item, in key order. */
  key: readonly string[];
  /** Item name template, such as "{product}". */
  itemLabel?: string;
  item: ObjectNode;
}

export interface ValueListNode extends NodeBase {
  kind: 'valueList';
  itemNoun: string;
  item: FieldNode;
}

export type FieldNode = ValueNode | ObjectNode | ObjectListNode | ValueListNode;

/** What `diffRecords` needs from a schema. Apps with their own schema format can build one. */
export interface Adapter {
  /** Record noun, such as "Contact". */
  recordNoun: string;
  root: ObjectNode;
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
}
