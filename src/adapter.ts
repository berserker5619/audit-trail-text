import { DiffError } from './errors.ts';
import type { Adapter, AtomicSpec, FieldNode, LangMap, ObjectListNode, ObjectNode, PatternEntry, ValueNode } from './types.ts';
import { escapePointer, isLangMap, isPlainObject, pickLang, templateFields, titleCase } from './util.ts';

export interface AdapterOptions {
  /**
   * Flat key: value pairs that win over the schema. Keys are record paths with `*` for list
   * items, followed by `#key`, `#label`, `#atomic`, `#scope` or `=value` where needed; `#record`
   * names the record. A key starting with `$defs/` applies wherever that definition is used.
   * Titles and value labels may be language maps: `{ "en": "Status", "de": "Status" }`.
   */
  labels?: Readonly<Record<string, string | LangMap>>;
  /** Refuse labels file entries that match no field, with UNKNOWN_LABEL. Default false. */
  strictLabels?: boolean;
}

type Schema = Record<string, unknown>;
type Text = string | LangMap;

interface Ctx {
  root: Schema;
  labels: ReadonlyMap<string, Text>;
  /** Labels file `=value` entries, by record or definition path. */
  valueLabels: ReadonlyMap<string, ReadonlyMap<string, Text>>;
  /** Labels file keys some field used. */
  used: Set<string>;
  /** Nodes of recursive definitions, built once and reused. */
  memo: Map<string, FieldNode>;
  /** Recursive definitions being built, with placeholders handed out for them. */
  building: Map<string, FieldNode[]>;
  /** Whether a $ref can reach itself. */
  recursive: Map<string, boolean>;
  /** Checks that need the whole tree built first, such as a list's key in a recursive item. */
  deferred: (() => void)[];
}

/** Reads a JSON Schema once into a field tree that `diffRecords` can reuse across many diffs. */
export function jsonSchemaAdapter(schema: unknown, options: AdapterOptions = {}): Adapter {
  if (!isPlainObject(schema)) throw invalid('', 'the schema must be an object');
  const labels = readLabels(options.labels);
  const valueLabels = new Map<string, Map<string, Text>>();
  for (const [key, text] of labels) {
    const eq = key.indexOf('=');
    if (eq < 0) continue;
    const path = key.slice(0, eq);
    let byValue = valueLabels.get(path);
    if (!byValue) valueLabels.set(path, (byValue = new Map()));
    byValue.set(key.slice(eq + 1), text);
  }
  const ctx: Ctx = { root: schema, labels, valueLabels, used: new Set(), memo: new Map(), building: new Map(), recursive: new Map(), deferred: [] };
  const recordTitle = label(ctx, '#record') ?? schemaText(schema, 'x-title', '') ?? (typeof schema['title'] === 'string' ? schema['title'] : 'Record');
  const recordNoun = text(recordTitle);
  const root = buildNode(ctx, schema, { lp: '', sp: '', fallbackTitle: recordNoun, inherited: false, refs: [], isRoot: true });
  if (root.kind !== 'object') throw invalid('', 'the root of the schema must describe an object');
  for (const check of ctx.deferred) check();

  const unusedLabels = [...labels.keys()].filter((key) => !ctx.used.has(key));
  if (options.strictLabels && unusedLabels.length > 0) {
    throw new DiffError('UNKNOWN_LABEL', unusedLabels[0]!, `labels file entries match no field: ${unusedLabels.join(', ')}`);
  }
  const adapter: Adapter = { recordNoun, root, unusedLabels };
  if (typeof recordTitle !== 'string') adapter.recordNounI18n = recordTitle;
  return adapter;
}

function readLabels(labels: unknown): Map<string, Text> {
  const out = new Map<string, Text>();
  if (labels === undefined) return out;
  if (!isPlainObject(labels)) throw invalid('', 'the labels file must be an object of key: value pairs');
  for (const key of Object.keys(labels)) {
    const value = labels[key];
    if (typeof value !== 'string' && !isLangMap(value)) {
      throw invalid(key, 'labels file values must be strings, or language maps such as { "en": "Status" }');
    }
    out.set(key, value);
  }
  return out;
}

/** Reads a labels file entry, noting that it matched a field. */
function label(ctx: Ctx, key: string): Text | undefined {
  const value = ctx.labels.get(key);
  if (value !== undefined) ctx.used.add(key);
  return value;
}

/** A labels file entry for this place: its record path first, then its definition. */
function entry(ctx: Ctx, at: At, suffix: string): Text | undefined {
  return label(ctx, `${at.lp}${suffix}`) ?? (at.dp !== undefined ? label(ctx, `${at.dp}${suffix}`) : undefined);
}

/** An entry that must be plain text, such as `#key`. */
function plainEntry(ctx: Ctx, at: At, suffix: string): string | undefined {
  const value = entry(ctx, at, suffix);
  if (value !== undefined && typeof value !== 'string') throw invalid(`${at.lp}${suffix}`, `"${suffix}" entries must be text`);
  return value;
}

/** Text for a label in the adapter's own tree: a map's English, else its first language. */
function text(value: Text): string {
  return typeof value === 'string' ? value : pickLang(value, 'en');
}

/** A schema keyword that may be text or a language map, such as `x-title`. */
function schemaText(s: Schema, keyword: string, sp: string): Text | undefined {
  const value = s[keyword];
  if (value === undefined) return undefined;
  if (typeof value === 'string' || isLangMap(value)) return value;
  throw invalid(sp, `"${keyword}" must be text or a language map such as { "en": "Status" }`);
}

interface At {
  /** Record path, with `*` for list items and map entries: the labels file key. */
  lp: string;
  /** The same place relative to the nearest definition: "$defs/part/qty". */
  dp?: string;
  /** Schema path: "/properties/orders/items", or from the definition for recursive ones. */
  sp: string;
  fallbackTitle: string;
  inherited: boolean;
  /** $refs followed while resolving this one schema, to refuse loops that describe no data. */
  refs: readonly string[];
  isRoot?: boolean;
}

function buildNode(ctx: Ctx, raw: unknown, at: At): FieldNode {
  const resolved = resolve(ctx, raw, at.sp, at.refs);
  const def = resolved.last;
  if (def !== undefined) {
    // Labels file entries for the definition apply wherever it is used.
    if (def.startsWith('#/')) at = { ...at, dp: def.slice(2).split('/').map(decodeSegment).join('/') };
    if (isRecursive(ctx, def)) {
      // A recursive definition is built once per use and reused at every depth. Its schema path
      // names the definition, so every level of a tree shares one path.
      at = { ...at, sp: def === '#' ? '' : `/${def.slice(2)}` };
      const memoKey = JSON.stringify([def, resolved.siblings, at.inherited, at.fallbackTitle]);
      // A place with labels file entries of its own is built on its own, so the entries apply there only.
      const ownEntries = [...ctx.labels.keys()].some((k) => k === at.lp || ['/', '#', '='].some((c) => k.startsWith(`${at.lp}${c}`)));
      if (!ownEntries) {
        const known = ctx.memo.get(memoKey);
        if (known) return known;
        // Met again before its node exists (a list is created after its items): a placeholder,
        // filled in with the finished node below.
        const pending = ctx.building.get(memoKey);
        if (pending) {
          const placeholder = {} as FieldNode;
          pending.push(placeholder);
          return placeholder;
        }
        const placeholders: FieldNode[] = [];
        ctx.building.set(memoKey, placeholders);
        const node = build(ctx, resolved, at, def, (n) => {
          if (!ctx.memo.has(memoKey)) ctx.memo.set(memoKey, n);
        });
        ctx.building.delete(memoKey);
        for (const placeholder of placeholders) Object.assign(placeholder, node);
        return node;
      }
    }
  }
  return build(ctx, resolved, at, def, () => {});
}

function build(ctx: Ctx, resolved: Resolved, at: At, def: string | undefined, created: (node: FieldNode) => void): FieldNode {
  const { schema: s } = mergeAllOf(ctx, resolved.schema, at.sp, resolved.refs);
  const ownSensitive = s['writeOnly'] === true || s['x-sensitive'] === true;
  const sensitive = at.inherited || ownSensitive;
  const titleText = entry(ctx, at, '') ?? schemaText(s, 'x-title', at.sp) ?? (typeof s['title'] === 'string' ? s['title'] : at.fallbackTitle);
  const base = {
    title: text(titleText),
    ...(typeof titleText !== 'string' && { titleI18n: titleText }),
    schemaPath: at.sp,
    sensitive,
    ownSensitive,
  };
  const type = pickType(s['type']);
  const props = s['properties'];
  const additional = s['additionalProperties'];
  const patterns = s['patternProperties'];
  const describesMap = isPlainObject(additional) || isPlainObject(patterns);
  // Children start a new resolution: a $ref back to an enclosing definition is recursion, not a loop.
  const child = (lp: string, dp: string | undefined, sp: string, fallbackTitle: string): At => ({
    lp,
    ...(dp !== undefined && { dp }),
    sp,
    fallbackTitle,
    inherited: sensitive,
    refs: [],
  });

  const atomic = atomicSpec(ctx, s, at, type);
  if (atomic) {
    const node: ValueNode = { kind: 'value', ...base, type: 'object', valueLabels: new Map(), atomic };
    created(node);
    return node;
  }

  if (type === 'object' || (type === undefined && (props !== undefined || describesMap || at.isRoot))) {
    if (props !== undefined && !isPlainObject(props)) throw invalid(at.sp, '"properties" must be an object');
    const properties = new Map<string, FieldNode>();
    const node: ObjectNode = { kind: 'object', ...base, properties };
    created(node);
    for (const key of Object.keys(props ?? {})) {
      properties.set(
        key,
        buildNode(ctx, (props as Schema)[key], child(`${at.lp}/${key}`, at.dp && `${at.dp}/${key}`, `${at.sp}/properties/${escapePointer(key)}`, titleCase(key))),
      );
    }
    // Map entries: keys not in `properties`, described by a pattern or by additionalProperties.
    const entryAt = (sp: string): At => child(`${at.lp}/*`, at.dp && `${at.dp}/*`, sp, '');
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
    const itemAt = child(`${at.lp}/*`, at.dp && `${at.dp}/*`, `${at.sp}/items`, 'Item');
    // The item noun: a labels file entry for the items (which titles the item), else x-itemNoun,
    // else the item schema's title.
    const nounInLabels = ctx.labels.has(itemAt.lp) || (itemAt.dp !== undefined && ctx.labels.has(itemAt.dp));
    const noun = nounInLabels ? undefined : schemaText(s, 'x-itemNoun', at.sp);
    const item = buildNode(ctx, items, itemAt);
    // An item still being built (a list whose items are the list itself) has no title yet.
    const nounText = noun ?? item.titleI18n ?? item.title ?? itemAt.fallbackTitle;
    const nouns = { itemNoun: text(nounText), ...(typeof nounText !== 'string' && { itemNounI18n: nounText }) };

    if (item.kind !== 'object') {
      const node = { kind: 'valueList' as const, ...base, ...nouns, item };
      created(node);
      return node;
    }

    const key = listKey(ctx, s, at);
    if (key.length === 0) {
      throw new DiffError('LIST_KEY_MISSING', at.lp, 'a list of objects needs "x-key" in the schema or "#key" in the labels file');
    }
    const itemLabel = plainEntry(ctx, at, '#label') ?? (typeof s['x-label'] === 'string' ? s['x-label'] : undefined);
    const scope = plainEntry(ctx, at, '#scope') ?? s['x-key-scope'];
    if (scope !== undefined && scope !== 'tree' && scope !== 'list') throw invalid(at.sp, '"x-key-scope" must be "tree" or "list"');
    const node: ObjectListNode = {
      kind: 'objectList',
      ...base,
      ...nouns,
      ...(def !== undefined && { def }),
      ...(scope === 'tree' && { keyScope: 'tree' as const }),
      key,
      ...(itemLabel !== undefined && { itemLabel }),
      item,
    };
    created(node);
    // A recursive item may still be filling in its fields, so its key is checked once every node is built.
    ctx.deferred.push(() => {
      for (const field of key) {
        const keyField = item.properties.get(field);
        if (!keyField) throw new DiffError('KEY_NOT_IN_SCHEMA', at.lp, `key field "${field}" is not in the item schema`);
        if (keyField.ownSensitive) throw new DiffError('SENSITIVE_KEY', at.lp, `key field "${field}" is sensitive`);
      }
      for (const field of itemLabel ? templateFields(itemLabel) : []) {
        if (item.properties.get(field)?.ownSensitive) {
          throw new DiffError('SENSITIVE_KEY', at.lp, `item label uses sensitive field "${field}"`);
        }
      }
    });
    return node;
  }

  // Plain values, and lists the schema doesn't describe: compared as one value.
  const valueLabels = new Map<string, string>();
  const valueLabelsI18n = new Map<string, LangMap>();
  const setLabel = (value: string, label: Text) => {
    valueLabels.set(value, text(label));
    if (typeof label === 'string') valueLabelsI18n.delete(value);
    else valueLabelsI18n.set(value, label);
  };
  const oneOf = s['oneOf'];
  if (Array.isArray(oneOf)) {
    for (const option of oneOf) {
      if (!isPlainObject(option) || !('const' in option)) continue;
      const optionTitle = schemaText(option, 'x-title', `${at.sp}/oneOf`) ?? option['title'];
      if (typeof optionTitle === 'string' || isLangMap(optionTitle)) setLabel(String(option['const']), optionTitle);
    }
  }
  for (const path of at.dp !== undefined ? [at.dp, at.lp] : [at.lp]) {
    for (const [value, label] of ctx.valueLabels.get(path) ?? []) {
      setLabel(value, label);
      ctx.used.add(`${path}=${value}`);
    }
  }
  const node: ValueNode = { kind: 'value', ...base, valueLabels };
  if (valueLabelsI18n.size > 0) node.valueLabelsI18n = valueLabelsI18n;
  if (type !== undefined) node.type = type;
  if (typeof s['format'] === 'string') node.format = s['format'];
  if (Array.isArray(s['enum']) || valueLabels.size > 0) node.coded = true;
  created(node);
  return node;
}

/** `x-atomic: true`, or a `#atomic` entry naming its key fields: an object compared as one value. */
function atomicSpec(ctx: Ctx, s: Schema, at: At, type: string | undefined): AtomicSpec | undefined {
  const fromLabels = plainEntry(ctx, at, '#atomic');
  const flag = s['x-atomic'];
  if (flag !== undefined && typeof flag !== 'boolean') throw invalid(at.sp, '"x-atomic" must be true or false');
  if (fromLabels === undefined && flag !== true) return undefined;
  if (type !== undefined && type !== 'object') throw invalid(at.sp, '"x-atomic" is for object schemas');
  const key = fromLabels !== undefined ? splitFields(fromLabels) : fieldList(s['x-key'], at.sp);
  const itemLabel = plainEntry(ctx, at, '#label') ?? (typeof s['x-label'] === 'string' ? s['x-label'] : undefined);
  const props = s['properties'];
  const sensitive = isPlainObject(props)
    ? Object.keys(props).filter((k) => {
        const field = resolve(ctx, props[k], `${at.sp}/properties/${escapePointer(k)}`, []).schema;
        return field['writeOnly'] === true || field['x-sensitive'] === true;
      })
    : [];
  for (const field of [...key, ...(itemLabel && itemLabel !== '@lang' ? templateFields(itemLabel) : [])]) {
    if (sensitive.includes(field)) throw new DiffError('SENSITIVE_KEY', at.lp, `atomic key or label uses sensitive field "${field}"`);
  }
  return { key, ...(itemLabel !== undefined && { label: itemLabel }), ...(sensitive.length > 0 && { sensitive }) };
}

function listKey(ctx: Ctx, s: Schema, at: At): string[] {
  const fromLabels = plainEntry(ctx, at, '#key');
  if (fromLabels !== undefined) return splitFields(fromLabels);
  return fieldList(s['x-key'], at.lp);
}

const splitFields = (list: string) => list.split(',').map((f) => f.trim()).filter(Boolean);

function fieldList(xKey: unknown, path: string): string[] {
  if (typeof xKey === 'string') return xKey ? [xKey] : [];
  if (Array.isArray(xKey) && xKey.every((f) => typeof f === 'string' && f)) return xKey as string[];
  if (xKey !== undefined) throw invalid(path, '"x-key" must be a field name or an array of field names');
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

interface Resolved {
  schema: Schema;
  refs: readonly string[];
  /** Keywords written next to the $refs, merged over the target. */
  siblings: Schema;
  /** The last $ref followed: the definition this schema comes from. */
  last?: string;
}

/**
 * Follows local $refs, merging keywords written next to the $ref over the target. A $ref met
 * twice before reaching a property or list item is a loop that describes no data, and is refused.
 */
function resolve(ctx: Ctx, raw: unknown, sp: string, refs: readonly string[]): Resolved {
  let current = raw;
  let chain = refs;
  let siblings: Schema = {};
  let last: string | undefined;
  while (isPlainObject(current) && typeof current['$ref'] === 'string') {
    const ref = current['$ref'];
    if (!ref.startsWith('#')) throw invalid(sp, `external $ref "${ref}" is not supported`);
    if (chain.includes(ref)) throw invalid(sp, `$ref "${ref}" loops back to itself without describing any data`);
    chain = [...chain, ref];
    last = ref;
    const { $ref: _, ...rest } = current;
    siblings = { ...rest, ...siblings };
    current = lookup(ctx.root, ref, sp);
  }
  if (current === true || current === undefined) current = {};
  if (!isPlainObject(current)) throw invalid(sp, 'each schema must be an object');
  return { schema: { ...current, ...siblings }, refs: chain, siblings, ...(last !== undefined && { last }) };
}

/** Whether a definition can reach itself through the $refs inside it. */
function isRecursive(ctx: Ctx, ref: string): boolean {
  const known = ctx.recursive.get(ref);
  if (known !== undefined) return known;
  const seen = new Set<string>();
  const queue = refsIn(lookup(ctx.root, ref, ''));
  let found = false;
  while (queue.length > 0 && !found) {
    const next = queue.pop()!;
    if (next === ref) found = true;
    else if (!seen.has(next) && next.startsWith('#')) {
      seen.add(next);
      queue.push(...refsIn(lookup(ctx.root, next, '')));
    }
  }
  ctx.recursive.set(ref, found);
  return found;
}

/** Every $ref written anywhere inside a schema. */
function refsIn(schema: unknown): string[] {
  const out: string[] = [];
  const stack = [schema];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (isPlainObject(v)) {
      for (const key of Object.keys(v)) {
        if (key === '$ref' && typeof v[key] === 'string') out.push(v[key]);
        else stack.push(v[key]);
      }
    }
  }
  return out;
}

function decodeSegment(raw: string): string {
  return decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
}

function lookup(root: Schema, ref: string, sp: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) throw invalid(sp, `$ref "${ref}" must be a JSON Pointer such as "#/$defs/address"`);
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const segment = decodeSegment(raw);
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
