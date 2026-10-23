// Mongoose objects are typed loosely here: their types differ across Mongoose 7, 8 and 9, and
// only a few stable fields are read (`paths`, `instance`, `options`, `schema`).
import { jsonSchemaAdapter } from '../adapter.ts';
import type { AdapterOptions } from '../adapter.ts';
import { DiffError } from '../errors.ts';
import type { Adapter, LangMap } from '../types.ts';
import { titleCase } from '../util.ts';

type Json = Record<string, unknown>;
export type Any = any;

/** How a value at one place is converted before the diff. Shapes of recursive schemas refer to themselves. */
export type Shape =
  | { k: 'object'; props: Map<string, Shape>; additional?: Shape; ignored: Set<string>; strict: boolean }
  | { k: 'array'; item: Shape }
  | { k: 'mixed' }
  | { k: 'date'; dateOnly: boolean }
  | { k: 'decimal' }
  | { k: 'uuid' }
  | { k: 'value' };

export interface MongooseAdapterOptions {
  /** The labels file, as for `jsonSchemaAdapter`: `{ "/items#label": "{product}", "/status=paid": "Paid" }`. */
  labels?: AdapterOptions['labels'];
  /** Refuse labels file entries that match no field. Default false. */
  strictLabels?: boolean;
  /** The record's name in sentences, such as "Order". Default: "Record", or `#record` in the labels file. */
  title?: string | LangMap;
}

/** What the plugin needs from one schema: the adapter, how to convert values, and which paths to read explicitly. */
export interface SchemaInfo {
  adapter: Adapter;
  shape: Shape & { k: 'object' };
  /** Paths with `select: false`, as Mongoose writes them ("addr.zip"), read with `+path`. */
  selectFalse: string[];
  /** Lists recorded as one whole value because the core refused them, with the reason. */
  wholeLists: { path: string; error: DiffError }[];
}

/**
 * Turns a Mongoose schema into a JSON Schema and builds the core adapter from it, with the same
 * labels file rules. Lists of subdocuments are keyed by `_id`; a list without `_id` needs `#key` in
 * the labels file, or is refused with LIST_KEY_MISSING.
 */
export function mongooseSchemaAdapter(schema: Any, options: MongooseAdapterOptions = {}): Adapter {
  return build(schema, options, new Set()).adapter;
}

/** Codes the core gives a list it can't match item by item: the plugin records such a list whole. */
const LIST_CODES = new Set(['LIST_KEY_MISSING', 'KEY_NOT_IN_SCHEMA', 'SENSITIVE_KEY']);

/**
 * Builds the schema info for the plugin. A list the core refuses is recorded as one whole value
 * instead, so a model is never blocked by its schema.
 */
export function schemaInfo(schema: Any, options: MongooseAdapterOptions): SchemaInfo {
  const whole = new Set<string>();
  const wholeLists: SchemaInfo['wholeLists'] = [];
  for (;;) {
    try {
      return { ...build(schema, options, whole), wholeLists };
    } catch (e) {
      if (!(e instanceof DiffError) || !LIST_CODES.has(e.code) || whole.has(e.path) || whole.size > 1000) throw e;
      whole.add(e.path);
      wholeLists.push({ path: e.path, error: e });
    }
  }
}

interface Ctx {
  defs: Json;
  /** Schemas that contain themselves, by definition name. */
  recursive: Map<object, string>;
  /** Shapes of recursive schemas, shared by every use. */
  shapes: Map<object, Shape & { k: 'object' }>;
  selectFalse: string[];
  /** Record paths of lists to record whole. */
  whole: ReadonlySet<string>;
}

function build(schema: Any, options: MongooseAdapterOptions, whole: ReadonlySet<string>): Omit<SchemaInfo, 'wholeLists'> {
  const ctx: Ctx = { defs: {}, recursive: findRecursive(schema), shapes: new Map(), selectFalse: [], whole };
  const { json, shape } = objectFromSchema(ctx, schema, '', '', true);
  const root: Json = { ...json, title: 'Record' };
  if (options.title !== undefined) {
    if (typeof options.title === 'string') root['title'] = options.title;
    else root['x-title'] = options.title;
  }
  if (Object.keys(ctx.defs).length > 0) root['$defs'] = ctx.defs;
  const adapterOptions: AdapterOptions = {};
  if (options.labels !== undefined) adapterOptions.labels = options.labels;
  if (options.strictLabels !== undefined) adapterOptions.strictLabels = options.strictLabels;
  const adapter = jsonSchemaAdapter(root, adapterOptions);
  return { adapter, shape: shape as Shape & { k: 'object' }, selectFalse: ctx.selectFalse };
}

/** Sub-schemas that can reach themselves, such as a category with child categories. */
function findRecursive(root: Any): Map<object, string> {
  const out = new Map<object, string>();
  const visit = (schema: Any, stack: object[]) => {
    if (stack.includes(schema)) {
      if (!out.has(schema)) out.set(schema, `s${out.size + 1}`);
      return;
    }
    for (const child of childSchemas(schema)) visit(child, [...stack, schema]);
  };
  visit(root, []);
  return out;
}

function childSchemas(schema: Any): Any[] {
  const out: Any[] = [];
  for (const st of Object.values(schema.paths ?? {}) as Any[]) collectChildSchemas(st, out);
  return out;
}

function collectChildSchemas(st: Any, out: Any[]): void {
  if (!st) return;
  if (st.schema && (st.$isSingleNested || st.$isMongooseDocumentArray || st.instance === 'Embedded')) out.push(st.schema);
  else if (st.instance === 'Array') collectChildSchemas(itemType(st), out);
  else if (st.instance === 'Map') collectChildSchemas(st.$__schemaType, out);
}

/** The schema type of an array's items: `embeddedSchemaType` in Mongoose 9, `caster` before. */
function itemType(st: Any): Any {
  return st.embeddedSchemaType ?? st.caster;
}

interface Built {
  json: Json;
  shape: Shape;
}

/**
 * A schema as an object: its paths, nested paths as objects. A recursive schema becomes a
 * definition referred to by `$ref`, so the core handles any depth.
 */
function objectFromSchema(ctx: Ctx, schema: Any, lp: string, dotted: string, isRoot = false): Built {
  const def = ctx.recursive.get(schema);
  if (def !== undefined && !isRoot) {
    if (!ctx.shapes.has(schema)) {
      const shape: Shape & { k: 'object' } = { k: 'object', props: new Map(), ignored: new Set(), strict: true };
      ctx.shapes.set(schema, shape);
      // Inside a definition, record paths start again at the definition.
      const built = objectBody(ctx, schema, `$defs/${def}`, dotted, shape);
      ctx.defs[def] = built;
    }
    return { json: { $ref: `#/$defs/${def}` }, shape: ctx.shapes.get(schema)! };
  }
  const shape: Shape & { k: 'object' } = { k: 'object', props: new Map(), ignored: new Set(), strict: true };
  if (def !== undefined) ctx.shapes.set(schema, shape);
  return { json: objectBody(ctx, schema, lp, dotted, shape), shape };
}

/** Builds an object's properties from a schema's paths, nesting "a.b" paths. */
function objectBody(ctx: Ctx, schema: Any, lp: string, dotted: string, shape: Shape & { k: 'object' }): Json {
  shape.strict = schema.options?.strict !== false;
  const root: Json = { type: 'object', properties: {} };
  const shapes = new Map<Json, Shape & { k: 'object' }>([[root, shape]]);
  const ignored = ignoredKeys(schema);
  for (const [path, st] of Object.entries(schema.paths ?? {}) as [string, Any][]) {
    if (path.includes('.$*')) continue; // a Map's value type, read from the Map itself
    const segments = path.split('.');
    let parent = root;
    let parentShape = shape;
    let parentLp = lp;
    for (const segment of segments.slice(0, -1)) {
      parentLp = `${parentLp}/${segment}`;
      const props = parent['properties'] as Json;
      let next = props[segment] as Json | undefined;
      if (!next) {
        next = { type: 'object', properties: {} };
        props[segment] = next;
        const nestedShape: Shape & { k: 'object' } = { k: 'object', props: new Map(), ignored: new Set(), strict: shape.strict };
        parentShape.props.set(segment, nestedShape);
        shapes.set(next, nestedShape);
      }
      parent = next;
      parentShape = shapes.get(next)!;
    }
    const key = segments[segments.length - 1]!;
    const fullDotted = dotted ? `${dotted}.${path}` : path;
    if (ignored.has(path) || st.options?.auditIgnore === true) {
      parentShape.ignored.add(key);
      continue;
    }
    const built = fromType(ctx, st, `${parentLp}/${key}`, fullDotted);
    (parent['properties'] as Json)[key] = built.json;
    parentShape.props.set(key, built.shape);
  }
  return root;
}

/** `__v`, and the timestamps a schema adds: never recorded. */
function ignoredKeys(schema: Any): Set<string> {
  const out = new Set<string>();
  const versionKey = schema.options?.versionKey;
  if (versionKey !== false) out.add(typeof versionKey === 'string' ? versionKey : '__v');
  const ts = schema.options?.timestamps;
  if (ts) {
    const pick = (value: unknown, fallback: string) => (value === false ? undefined : typeof value === 'string' ? value : fallback);
    const createdAt = ts === true ? 'createdAt' : pick(ts.createdAt, 'createdAt');
    const updatedAt = ts === true ? 'updatedAt' : pick(ts.updatedAt, 'updatedAt');
    if (createdAt) out.add(createdAt);
    if (updatedAt) out.add(updatedAt);
  }
  return out;
}

/** One schema type as JSON Schema, with the options the plugin reads from a path. */
function fromType(ctx: Ctx, st: Any, lp: string, dotted: string): Built {
  const options = st?.options ?? {};
  const meta: Json = {};
  const title = options.title;
  if (typeof title === 'string' || (title && typeof title === 'object')) meta['x-title'] = title;
  if (options.auditSensitive === true || options.select === false) meta['x-sensitive'] = true;
  if (options.select === false) ctx.selectFalse.push(dotted);
  const built = typeBody(ctx, st, lp, dotted);
  return { json: { ...built.json, ...meta }, shape: built.shape };
}

function typeBody(ctx: Ctx, st: Any, lp: string, dotted: string): Built {
  const options = st?.options ?? {};
  const instance: string | undefined = st?.instance;
  if (st?.schema && (st.$isSingleNested || instance === 'Embedded')) {
    return objectFromSchema(ctx, st.schema, lp, dotted);
  }
  if (st?.$isMongooseDocumentArray) {
    if (ctx.whole.has(lp)) return { json: {}, shape: { k: 'mixed' } };
    const item = objectFromSchema(ctx, st.schema, `${lp}/*`, dotted);
    const json: Json = { type: 'array', items: item.json };
    if (st.schema.path('_id')) json['x-key'] = '_id';
    return { json, shape: { k: 'array', item: item.shape } };
  }
  switch (instance) {
    case 'Array': {
      const item = fromType(ctx, itemType(st), `${lp}/*`, dotted);
      return { json: { type: 'array', items: item.json }, shape: { k: 'array', item: item.shape } };
    }
    case 'Map': {
      const value = st.$__schemaType ? fromType(ctx, st.$__schemaType, `${lp}/*`, `${dotted}.$*`) : { json: {}, shape: { k: 'mixed' } as Shape };
      return {
        json: { type: 'object', additionalProperties: value.json },
        shape: { k: 'object', props: new Map(), additional: value.shape, ignored: new Set(), strict: true },
      };
    }
    case 'String': {
      const json: Json = { type: 'string' };
      const values = Array.isArray(st.enumValues) && st.enumValues.length > 0 ? st.enumValues : enumOption(options.enum);
      if (values) json['enum'] = values;
      return { json, shape: { k: 'value' } };
    }
    case 'Number':
    case 'Double': {
      const json: Json = { type: 'number' };
      const values = enumOption(options.enum);
      if (values) json['enum'] = values;
      return { json, shape: { k: 'value' } };
    }
    case 'Int32':
      return { json: { type: 'integer' }, shape: { k: 'value' } };
    case 'Boolean':
      return { json: { type: 'boolean' }, shape: { k: 'value' } };
    case 'Date': {
      const dateOnly = options.auditFormat === 'date';
      return { json: { type: 'string', format: dateOnly ? 'date' : 'date-time' }, shape: { k: 'date', dateOnly } };
    }
    case 'ObjectId':
    case 'ObjectID':
      return { json: { type: 'string' }, shape: { k: 'value' } };
    case 'UUID':
      return { json: { type: 'string' }, shape: { k: 'uuid' } };
    case 'Decimal128':
    case 'BigInt':
      return { json: { type: 'string', format: 'decimal' }, shape: { k: 'decimal' } };
    case 'Buffer':
      // Compared by its bytes, never stored: the converted value is only a hash of them.
      return { json: { type: 'string', 'x-sensitive': true }, shape: { k: 'value' } };
    default:
      return { json: {}, shape: { k: 'mixed' } };
  }
}

function enumOption(value: unknown): unknown[] | undefined {
  if (Array.isArray(value) && value.length > 0) return value;
  if (value && typeof value === 'object' && Array.isArray((value as Json)['values'])) return (value as Json)['values'] as unknown[];
  return undefined;
}

/** The record's name for a model: "OrderItem" → "Order Item". */
export function modelTitle(modelName: string): string {
  return titleCase(modelName);
}
