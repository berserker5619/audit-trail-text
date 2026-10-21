import { DiffError } from './errors.ts';
import type { Adapter, FieldNode, ObjectNode, PatternEntry, ValueNode } from './types.ts';
import { escapePointer, isPlainObject, templateFields, titleCase } from './util.ts';

export interface AdapterOptions {
  /**
   * Flat key: value pairs that win over the schema. Keys are record paths with `*` for list
   * items, followed by `#key`, `#label` or `=value` where needed; `#record` names the record.
   */
  labels?: Readonly<Record<string, string>>;
  /** Refuse labels file entries that match no field, with UNKNOWN_LABEL. Default false. */
  strictLabels?: boolean;
}

type Schema = Record<string, unknown>;

interface Ctx {
  root: Schema;
  labels: ReadonlyMap<string, string>;
  /** Labels file `=value` entries, by record path. */
  valueLabels: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Labels file keys some field used. */
  used: Set<string>;
}

/** Reads a JSON Schema once into a field tree that `diffRecords` can reuse across many diffs. */
export function jsonSchemaAdapter(schema: unknown, options: AdapterOptions = {}): Adapter {
  if (!isPlainObject(schema)) throw invalid('', 'the schema must be an object');
  const labels = readLabels(options.labels);
  const valueLabels = new Map<string, Map<string, string>>();
  for (const [key, label] of labels) {
    const eq = key.indexOf('=');
    if (eq < 0) continue;
    const path = key.slice(0, eq);
    let byValue = valueLabels.get(path);
    if (!byValue) valueLabels.set(path, (byValue = new Map()));
    byValue.set(key.slice(eq + 1), label);
  }
  const ctx: Ctx = { root: schema, labels, valueLabels, used: new Set() };
  const recordNoun = label(ctx, '#record') ?? (typeof schema['title'] === 'string' ? schema['title'] : 'Record');
  const root = buildNode(ctx, schema, { lp: '', sp: '', fallbackTitle: recordNoun, inherited: false, refs: [], isRoot: true });
  if (root.kind !== 'object') throw invalid('', 'the root of the schema must describe an object');

  const unusedLabels = [...labels.keys()].filter((key) => !ctx.used.has(key));
  if (options.strictLabels && unusedLabels.length > 0) {
    throw new DiffError('UNKNOWN_LABEL', unusedLabels[0]!, `labels file entries match no field: ${unusedLabels.join(', ')}`);
  }
  return { recordNoun, root, unusedLabels };
}

function readLabels(labels: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (labels === undefined) return out;
  if (!isPlainObject(labels)) throw invalid('', 'the labels file must be an object of key: value pairs');
  for (const key of Object.keys(labels)) {
    const value = labels[key];
    if (typeof value !== 'string') throw invalid(key, 'labels file values must be strings');
    out.set(key, value);
  }
  return out;
}

/** Reads a labels file entry, noting that it matched a field. */
function label(ctx: Ctx, key: string): string | undefined {
  const value = ctx.labels.get(key);
  if (value !== undefined) ctx.used.add(key);
  return value;
}

interface At {
  /** Record path, with `*` for list items and map entries: the labels file key. */
  lp: string;
  /** Schema path as walked: "/properties/orders/items". */
  sp: string;
  fallbackTitle: string;
  inherited: boolean;
  /** $refs followed on the way here, to refuse recursion. */
  refs: readonly string[];
  isRoot?: boolean;
}

function buildNode(ctx: Ctx, raw: unknown, at: At): FieldNode {
  const resolved = resolve(ctx, raw, at.sp, at.refs);
  const { schema: s, refs } = mergeAllOf(ctx, resolved.schema, at.sp, resolved.refs);
  const ownSensitive = s['writeOnly'] === true || s['x-sensitive'] === true;
  const sensitive = at.inherited || ownSensitive;
  const title = label(ctx, at.lp) ?? (typeof s['title'] === 'string' ? s['title'] : at.fallbackTitle);
  const base = { title, schemaPath: at.sp, sensitive, ownSensitive };
  const type = pickType(s['type']);
  const props = s['properties'];
  const additional = s['additionalProperties'];
  const patterns = s['patternProperties'];
  const describesMap = isPlainObject(additional) || isPlainObject(patterns);

  if (type === 'object' || (type === undefined && (props !== undefined || describesMap || at.isRoot))) {
    if (props !== undefined && !isPlainObject(props)) throw invalid(at.sp, '"properties" must be an object');
    const properties = new Map<string, FieldNode>();
    for (const key of Object.keys(props ?? {})) {
      properties.set(
        key,
        buildNode(ctx, (props as Schema)[key], {
          lp: `${at.lp}/${key}`,
          sp: `${at.sp}/properties/${escapePointer(key)}`,
          fallbackTitle: titleCase(key),
          inherited: sensitive,
          refs,
        }),
      );
    }
    const node: ObjectNode = { kind: 'object', ...base, properties };
    // Map entries: keys not in `properties`, described by a pattern or by additionalProperties.
    const entryAt = (sp: string): At => ({ lp: `${at.lp}/*`, sp, fallbackTitle: '', inherited: sensitive, refs });
    if (isPlainObject(patterns)) {
      node.patterns = Object.keys(patterns).map((pattern): PatternEntry => ({
        pattern: compilePattern(pattern, `${at.sp}/patternProperties`),
        node: buildNode(ctx, patterns[pattern], entryAt(`${at.sp}/patternProperties/${escapePointer(pattern)}`)),
      }));
    }
    if (isPlainObject(additional)) node.additional = buildNode(ctx, additional, entryAt(`${at.sp}/additionalProperties`));
    return node;
  }

  const items = s['items'];
  if ((type === 'array' || type === undefined) && isPlainObject(items)) {
    const itemPath = `${at.lp}/*`;
    const itemSp = `${at.sp}/items`;
    const itemAt: At = { lp: itemPath, sp: itemSp, fallbackTitle: 'Item', inherited: sensitive, refs };
    const item = buildNode(ctx, items, itemAt);
    const itemNoun = item.title;

    if (item.kind !== 'object') return { kind: 'valueList', ...base, itemNoun, item };

    const key = listKey(ctx, s, at.lp);
    if (key.length === 0) {
      throw new DiffError('LIST_KEY_MISSING', at.lp, 'a list of objects needs "x-key" in the schema or "#key" in the labels file');
    }
    for (const field of key) {
      const child = item.properties.get(field);
      if (!child) throw new DiffError('KEY_NOT_IN_SCHEMA', at.lp, `key field "${field}" is not in the item schema`);
      if (child.ownSensitive) throw new DiffError('SENSITIVE_KEY', at.lp, `key field "${field}" is sensitive`);
    }
    const labelEntry = label(ctx, `${at.lp}#label`);
    const itemLabel = labelEntry ?? (typeof s['x-label'] === 'string' ? s['x-label'] : undefined);
    for (const field of itemLabel ? templateFields(itemLabel) : []) {
      if (item.properties.get(field)?.ownSensitive) {
        throw new DiffError('SENSITIVE_KEY', at.lp, `item label uses sensitive field "${field}"`);
      }
    }
    return {
      kind: 'objectList',
      ...base,
      itemNoun,
      key,
      ...(itemLabel !== undefined && { itemLabel }),
      item,
    };
  }

  // Plain values, and lists the schema doesn't describe: compared as one value.
  const valueLabels = new Map<string, string>();
  const oneOf = s['oneOf'];
  if (Array.isArray(oneOf)) {
    for (const option of oneOf) {
      if (isPlainObject(option) && 'const' in option && typeof option['title'] === 'string') {
        valueLabels.set(String(option['const']), option['title']);
      }
    }
  }
  for (const [value, text] of ctx.valueLabels.get(at.lp) ?? []) {
    valueLabels.set(value, text);
    ctx.used.add(`${at.lp}=${value}`);
  }
  const node: ValueNode = { kind: 'value', ...base, valueLabels };
  if (type !== undefined) node.type = type;
  if (typeof s['format'] === 'string') node.format = s['format'];
  if (Array.isArray(s['enum']) || valueLabels.size > 0) node.coded = true;
  return node;
}

function listKey(ctx: Ctx, s: Schema, lp: string): string[] {
  const fromLabels = label(ctx, `${lp}#key`);
  if (fromLabels !== undefined) return fromLabels.split(',').map((f) => f.trim()).filter(Boolean);
  const xKey = s['x-key'];
  if (typeof xKey === 'string') return xKey ? [xKey] : [];
  if (Array.isArray(xKey) && xKey.every((f) => typeof f === 'string' && f)) return xKey as string[];
  if (xKey !== undefined) throw invalid(lp, '"x-key" must be a field name or an array of field names');
  return [];
}

/**
 * Merges `allOf` entries into the schema. Keywords written on the schema itself win, then
 * entries in order; `properties` are combined, the first definition of a field winning.
 */
function mergeAllOf(ctx: Ctx, s: Schema, sp: string, refs: readonly string[]): { schema: Schema; refs: readonly string[] } {
  const allOf = s['allOf'];
  if (allOf === undefined) return { schema: s, refs };
  if (!Array.isArray(allOf)) throw invalid(sp, '"allOf" must be an array');
  const { allOf: _, ...merged } = s;
  let chain = refs;
  allOf.forEach((entry, i) => {
    const at = `${sp}/allOf/${i}`;
    const resolved = resolve(ctx, entry, at, refs);
    const { schema: part, refs: partRefs } = mergeAllOf(ctx, resolved.schema, at, resolved.refs);
    chain = [...new Set([...chain, ...partRefs])];
    for (const [keyword, value] of Object.entries(part)) {
      if (keyword === 'properties' && isPlainObject(value)) {
        const props: Schema = isPlainObject(merged['properties']) ? { ...merged['properties'] } : {};
        for (const key of Object.keys(value)) if (!Object.hasOwn(props, key)) props[key] = value[key];
        merged['properties'] = props;
      } else if (!Object.hasOwn(merged, keyword)) {
        merged[keyword] = value;
      }
    }
  });
  return { schema: merged, refs: chain };
}

function compilePattern(pattern: string, sp: string): RegExp {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      throw invalid(sp, `pattern "${pattern}" is not a valid regular expression`);
    }
  }
}

/** Follows local $refs, merging keywords written next to the $ref over the target. */
function resolve(ctx: Ctx, raw: unknown, sp: string, refs: readonly string[]): { schema: Schema; refs: readonly string[] } {
  let current = raw;
  let chain = refs;
  let siblings: Schema = {};
  while (isPlainObject(current) && typeof current['$ref'] === 'string') {
    const ref = current['$ref'];
    if (!ref.startsWith('#')) throw invalid(sp, `external $ref "${ref}" is not supported`);
    if (chain.includes(ref)) throw invalid(sp, `recursive $ref "${ref}" is not supported`);
    chain = [...chain, ref];
    const { $ref: _, ...rest } = current;
    siblings = { ...rest, ...siblings };
    current = lookup(ctx.root, ref, sp);
  }
  if (current === true || current === undefined) current = {};
  if (!isPlainObject(current)) throw invalid(sp, 'each schema must be an object');
  return { schema: { ...current, ...siblings }, refs: chain };
}

function lookup(root: Schema, ref: string, sp: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) throw invalid(sp, `$ref "${ref}" must be a JSON Pointer such as "#/$defs/address"`);
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) throw invalid(sp, `$ref "${ref}" points to nothing`);
    current = current[segment];
  }
  return current;
}

function pickType(type: unknown): string | undefined {
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.find((t): t is string => typeof t === 'string' && t !== 'null');
  return undefined;
}

function invalid(path: string, message: string): DiffError {
  return new DiffError('INVALID_SCHEMA', path, message);
}
