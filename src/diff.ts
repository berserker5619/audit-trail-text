import { DiffError } from './errors.ts';
import type {
  Adapter,
  Change,
  ChangeDisplay,
  ChangeCode,
  DiffOptions,
  FieldNode,
  ItemRef,
  ObjectListNode,
  ObjectNode,
  ValueListNode,
} from './types.ts';
import { canonical, escapePointer, isEmpty, isPlainObject, own, setProp, titleCase } from './util.ts';

type Rec = Record<string, unknown>;

interface Ctx {
  out: Change[];
  maxChanges: number;
  ignore: ReadonlySet<string>;
  expandObjects: boolean;
}

/** Where the walk is: both record pointers, the labels path, and what a change here carries. */
interface Loc {
  bp: string;
  ap: string;
  /** Record path with `*` for list items, matched against `ignore`. */
  lp: string;
  sp: string;
  labels: string[];
  item?: ItemRef;
  /** Positions in `labels` that hold item names. */
  itemAt: number[];
  inSchema: boolean;
}

const STOP = Symbol('stop');

/**
 * Compares two versions of a record. Pure: the same input gives the same changes in the same order.
 * `before` may be null (record created) and `after` may be null (record deleted).
 */
export function diffRecords(before: unknown, after: unknown, adapter: Adapter, options: DiffOptions = {}): Change[] {
  const maxDepth = count(options.maxDepth, 32, 'maxDepth');
  const maxChanges = count(options.maxChanges, 1000, 'maxChanges');
  checkRecord(before, 'before', maxDepth);
  checkRecord(after, 'after', maxDepth);

  const ctx: Ctx = {
    out: [],
    maxChanges,
    ignore: new Set(options.ignore ?? []),
    expandObjects: options.expandObjects === true,
  };
  const root = adapter.root;
  try {
    if (before == null && after == null) return [];
    if (before == null) {
      emit(ctx, make('RECORD_CREATED', { afterPath: '', schemaPath: root.schemaPath, labels: [adapter.recordNoun], inSchema: true }, {
        after: strip(after, root, '', ctx, true),
      }, { type: 'object' }));
    } else if (after == null) {
      emit(ctx, make('RECORD_DELETED', { beforePath: '', schemaPath: root.schemaPath, labels: [adapter.recordNoun], inSchema: true }, {
        before: strip(before, root, '', ctx, true),
      }, { type: 'object' }));
    } else {
      walkObject(ctx, root, before as Rec, after as Rec, { bp: '', ap: '', lp: '', sp: root.schemaPath, labels: [], itemAt: [], inSchema: true });
    }
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return ctx.out;
}

function count(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new DiffError('INVALID_OPTION', name, `${name} must be a whole number of 0 or more, not ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------- walking

function walkObject(ctx: Ctx, node: ObjectNode | undefined, b: Rec, a: Rec, loc: Loc): void {
  const extra = new Set<string>();
  for (const o of [b, a]) for (const k of Object.keys(o)) if (!node?.properties.has(k)) extra.add(k);
  const keys = [...(node?.properties.keys() ?? []), ...[...extra].sort()];

  for (const key of keys) {
    const lp = `${loc.lp}/${key}`;
    if (ctx.ignore.has(lp)) continue;
    const bv = own(b, key);
    const av = own(a, key);
    if (bv === undefined && av === undefined) continue;
    const known = node ? childOf(node, key) : undefined;
    const child = known ?? unknownNode(key, bv, av);
    const segment = escapePointer(key);
    diffField(ctx, child, bv, av, {
      bp: `${loc.bp}/${segment}`,
      ap: `${loc.ap}/${segment}`,
      lp,
      sp: known ? child.schemaPath : '',
      labels: [...loc.labels, child.title],
      ...(loc.item && { item: loc.item }),
      itemAt: loc.itemAt,
      inSchema: loc.inSchema && known !== undefined,
    });
  }
}

/**
 * The schema node for a key: a property, else the first matching `patternProperties` entry, else
 * `additionalProperties`. Map entries are labelled with their key as written.
 */
function childOf(node: ObjectNode, key: string): FieldNode | undefined {
  const property = node.properties.get(key);
  if (property) return property;
  const entry = node.patterns?.find((p) => p.pattern.test(key))?.node ?? node.additional;
  return entry && { ...entry, title: key };
}

/** Fields the schema doesn't describe: objects are walked, everything else is one value. */
function unknownNode(key: string, bv: unknown, av: unknown): FieldNode {
  const base = { title: titleCase(key), schemaPath: '', sensitive: false, ownSensitive: false };
  const objOrNil = (v: unknown) => v == null || isPlainObject(v);
  if (objOrNil(bv) && objOrNil(av)) return { kind: 'object', ...base, properties: new Map() };
  return { kind: 'value', ...base, valueLabels: new Map() };
}

function diffField(ctx: Ctx, node: FieldNode, b: unknown, a: unknown, loc: Loc): void {
  const objOrNil = (v: unknown) => v == null || isPlainObject(v);
  const listOrNil = (v: unknown) => v == null || Array.isArray(v);
  // A value of the wrong shape for its schema falls through to a plain value comparison.
  if (node.kind === 'object' && objOrNil(b) && objOrNil(a)) return diffObjectField(ctx, node, b as Rec, a as Rec, loc);
  if (node.kind === 'objectList' && listOrNil(b) && listOrNil(a)) return diffObjectList(ctx, node, b as unknown[], a as unknown[], loc);
  if (node.kind === 'valueList' && listOrNil(b) && listOrNil(a)) return diffValueList(ctx, node, b as unknown[], a as unknown[], loc);
  diffValue(ctx, node, b, a, loc);
}

function diffValue(ctx: Ctx, node: FieldNode, b: unknown, a: unknown, loc: Loc): void {
  const bs = strip(b, node, loc.lp, ctx, false);
  const as = strip(a, node, loc.lp, ctx, false);
  const bEmpty = isEmpty(bs);
  const aEmpty = isEmpty(as);
  if (bEmpty && aEmpty) return;
  let code: ChangeCode;
  if (bEmpty) code = 'FIELD_SET';
  else if (aEmpty) code = 'FIELD_CLEARED';
  else if (canonical(bs) === canonical(as)) return;
  else code = 'FIELD_CHANGED';
  emitField(ctx, node, code, b, a, loc);
}

function diffObjectField(ctx: Ctx, node: ObjectNode, b: Rec | null | undefined, a: Rec | null | undefined, loc: Loc): void {
  // Emptiness is checked after ignored fields are stripped.
  const bEmpty = isEmpty(strip(b, node, loc.lp, ctx, false));
  const aEmpty = isEmpty(strip(a, node, loc.lp, ctx, false));
  if (bEmpty && aEmpty) return;
  if ((bEmpty || aEmpty) && !ctx.expandObjects) {
    return emitField(ctx, node, bEmpty ? 'FIELD_SET' : 'FIELD_CLEARED', b, a, loc);
  }
  walkObject(ctx, node, b ?? {}, a ?? {}, loc);
}

function emitField(ctx: Ctx, node: FieldNode, code: ChangeCode, b: unknown, a: unknown, loc: Loc): void {
  const values: Values = node.sensitive
    ? { redacted: true }
    : { before: strip(b, node, loc.lp, ctx, true), after: strip(a, node, loc.lp, ctx, true) };
  emit(ctx, make(code, at(loc, true, true), values, displayOf(loc.inSchema ? node : undefined, values)));
}

// ---------------------------------------------------------------- lists

interface Indexed {
  ids: string[];
  byId: Map<string, { index: number; item: Rec; key: unknown }>;
}

function diffObjectList(ctx: Ctx, node: ObjectListNode, b: unknown[] | null | undefined, a: unknown[] | null | undefined, loc: Loc): void {
  const bi = indexItems(node, b ?? [], loc.bp, 'before');
  const ai = indexItems(node, a ?? [], loc.ap, 'after');
  const itemLp = `${loc.lp}/*`;

  for (const id of ai.ids) {
    const was = bi.byId.get(id);
    if (!was) continue;
    const now = ai.byId.get(id)!;
    const ref = itemRef(node, now.item, now.key);
    walkObject(ctx, node.item, was.item, now.item, {
      bp: `${loc.bp}/${was.index}`,
      ap: `${loc.ap}/${now.index}`,
      lp: itemLp,
      sp: node.item.schemaPath,
      ...named(loc, ref),
      ...(ref && { item: ref }),
      inSchema: loc.inSchema,
    });
  }

  const whole = (code: ChangeCode, entry: { index: number; item: Rec; key: unknown }, side: 'before' | 'after') => {
    const ref = itemRef(node, entry.item, entry.key);
    const path = `${side === 'before' ? loc.bp : loc.ap}/${entry.index}`;
    const values: Values = node.sensitive
      ? { redacted: true }
      : { [side]: strip(entry.item, node.item, itemLp, ctx, true), ...(ref && { item: ref }) };
    emit(ctx, make(code, {
      ...(side === 'before' ? { beforePath: path } : { afterPath: path }),
      schemaPath: node.item.schemaPath,
      ...named(loc, ref),
      inSchema: loc.inSchema,
    }, values, displayOf(node.item, values, node.itemNoun)));
  };
  for (const id of bi.ids) if (!ai.byId.has(id)) whole('ITEM_REMOVED', bi.byId.get(id)!, 'before');
  for (const id of ai.ids) if (!bi.byId.has(id)) whole('ITEM_ADDED', ai.byId.get(id)!, 'after');

  const beforeOrder = bi.ids.filter((id) => ai.byId.has(id));
  const afterOrder = ai.ids.filter((id) => bi.byId.has(id));
  if (beforeOrder.some((id, i) => id !== afterOrder[i])) {
    // Only the items that moved are stored: those outside a longest run kept in the same order.
    const moved = movedItems(beforeOrder, afterOrder);
    const kept = afterOrder.filter((id) => moved.has(id)).slice(0, MAX_REORDER_KEYS);
    const shown = new Set(kept);
    const keys = (ids: string[], index: Indexed) => ids.filter((id) => shown.has(id)).map((id) => index.byId.get(id)!.key);
    emit(ctx, make('LIST_REORDERED', at(loc, true, true), node.sensitive
      ? { redacted: true }
      : { before: keys(beforeOrder, bi), after: keys(afterOrder, ai) }, { type: 'array', itemNoun: node.itemNoun, moved: moved.size }));
  }
}

/** At most this many moved keys are stored in a LIST_REORDERED change; `display.moved` has the count. */
const MAX_REORDER_KEYS = 100;

/**
 * The items that moved between two orders of the same items: all but a longest subsequence
 * kept in the same relative order. O(n log n).
 */
function movedItems(beforeOrder: string[], afterOrder: string[]): Set<string> {
  const position = new Map(beforeOrder.map((id, i) => [id, i]));
  const seq = afterOrder.map((id) => position.get(id)!);
  const tails: number[] = []; // index into seq of the smallest tail of each run length
  const prev: number[] = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const stayed = new Set<string>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) stayed.add(afterOrder[i]!);
  return new Set(afterOrder.filter((id) => !stayed.has(id)));
}

function indexItems(node: ObjectListNode, list: unknown[], path: string, side: 'before' | 'after'): Indexed {
  const ids: string[] = [];
  const byId: Indexed['byId'] = new Map();
  list.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    if (!isPlainObject(item)) throw new DiffError('ITEM_KEY_MISSING', itemPath, 'list item is not an object', { side });
    const values = node.key.map((field) => {
      const v = own(item, field);
      if (v == null || v === '') throw new DiffError('ITEM_KEY_MISSING', itemPath, `item has no "${field}"`, { side });
      if (typeof v === 'object') {
        throw new DiffError('INVALID_KEY', itemPath, `key field "${field}" must be a string, number or boolean`, { side });
      }
      return v;
    });
    const key = values.length === 1 ? values[0] : values;
    const id = canonical(values);
    if (byId.has(id)) throw new DiffError('DUPLICATE_KEY', path, `two items share the key ${canonical(key)}`, { side, key });
    ids.push(id);
    byId.set(id, { index, item, key });
  });
  return { ids, byId };
}

/** Left out for sensitive lists, so keys and labels can't leak. */
function itemRef(node: ObjectListNode, item: Rec, key: unknown): ItemRef | undefined {
  if (node.sensitive) return undefined;
  // A stored code is named by its label: an address keyed by `kind: "home"` reads as "Home".
  const text = (field: string) => {
    const v = own(item, field);
    if (v == null) return '';
    const child = node.item.properties.get(field);
    const label = child?.kind === 'value' && typeof v !== 'object' ? child.valueLabels.get(String(v)) : undefined;
    return label ?? (typeof v === 'string' ? v : canonical(v));
  };
  const fallback = node.key.map(text).join(', ');
  const label = node.itemLabel ? node.itemLabel.replace(/\{([^{}]+)\}/g, (_, field: string) => text(field.trim())).trim() : '';
  return { key, label: label || fallback };
}

/** Compared by value, counting duplicates. Order is never reported. */
function diffValueList(ctx: Ctx, node: ValueListNode, b: unknown[] | null | undefined, a: unknown[] | null | undefined, loc: Loc): void {
  const bl = b ?? [];
  const al = a ?? [];
  const itemLp = `${loc.lp}/*`;
  const ids = (list: unknown[]) => list.map((v) => canonical(strip(v, node.item, itemLp, ctx, false)));
  const unmatched = (from: string[], against: string[]) => {
    const left = new Map<string, number>();
    for (const id of against) left.set(id, (left.get(id) ?? 0) + 1);
    return from.flatMap((id, index) => {
      const n = left.get(id) ?? 0;
      if (n > 0) {
        left.set(id, n - 1);
        return [];
      }
      return [index];
    });
  };
  const bIds = ids(bl);
  const aIds = ids(al);
  const whole = (code: ChangeCode, value: unknown, path: Partial<Change>) => {
    const values: Values = node.sensitive
      ? { redacted: true }
      : { [code === 'ITEM_ADDED' ? 'after' : 'before']: strip(value, node.item, itemLp, ctx, true) };
    const where = { ...path, schemaPath: node.item.schemaPath, labels: [...loc.labels], ...(loc.item && { item: loc.item }), itemAt: loc.itemAt, inSchema: loc.inSchema };
    emit(ctx, make(code, where, values, displayOf(node.item, values, node.itemNoun)));
  };
  for (const i of unmatched(bIds, aIds)) whole('ITEM_REMOVED', bl[i], { beforePath: `${loc.bp}/${i}` });
  for (const i of unmatched(aIds, bIds)) whole('ITEM_ADDED', al[i], { afterPath: `${loc.ap}/${i}` });
}

// ---------------------------------------------------------------- values

/**
 * Copies a value without ignored fields, and without sensitive fields when `dropSensitive`.
 * Normalises -0 to 0. Never mutates the input.
 */
function strip(v: unknown, node: FieldNode | undefined, lp: string, ctx: Ctx, dropSensitive: boolean): unknown {
  if (Object.is(v, -0)) return 0;
  if (Array.isArray(v)) {
    const item = node?.kind === 'objectList' || node?.kind === 'valueList' ? node.item : undefined;
    const itemLp = `${lp}/*`;
    if (ctx.ignore.has(itemLp)) return [];
    return v.map((x) => strip(x, item, itemLp, ctx, dropSensitive));
  }
  if (isPlainObject(v)) {
    const objectNode = node?.kind === 'object' ? node : undefined;
    const out: Rec = {};
    for (const key of Object.keys(v)) {
      const childLp = `${lp}/${key}`;
      if (ctx.ignore.has(childLp)) continue;
      const child = objectNode ? childOf(objectNode, key) : undefined;
      if (dropSensitive && child?.sensitive) continue;
      const x = strip(v[key], child, childLp, ctx, dropSensitive);
      if (x !== undefined) setProp(out, key, x);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- output

type Values = { before?: unknown; after?: unknown; item?: ItemRef; redacted?: true };
type Where = Pick<Change, 'beforePath' | 'afterPath' | 'schemaPath' | 'labels' | 'inSchema'> & { itemAt?: number[] };

/** Labels for an item: its name is added, except in a sensitive list, where nothing is. */
function named(loc: Loc, ref: ItemRef | undefined): { labels: string[]; itemAt: number[] } {
  return ref
    ? { labels: [...loc.labels, ref.label], itemAt: [...loc.itemAt, loc.labels.length] }
    : { labels: [...loc.labels], itemAt: loc.itemAt };
}

function at(loc: Loc, withBefore: boolean, withAfter: boolean): Where & { item?: ItemRef } {
  return {
    ...(withBefore && { beforePath: loc.bp }),
    ...(withAfter && { afterPath: loc.ap }),
    schemaPath: loc.sp,
    labels: [...loc.labels],
    ...(loc.item && { item: loc.item }),
    itemAt: loc.itemAt,
    inSchema: loc.inSchema,
  };
}

/** Builds a change with a fixed key order and no undefined members, so stored JSON is stable. */
function make(code: ChangeCode, where: Partial<Where> & { item?: ItemRef }, values: Values, display: ChangeDisplay): Change {
  const ordered: Partial<Change> = { code };
  if (where.beforePath !== undefined) ordered.beforePath = where.beforePath;
  if (where.afterPath !== undefined) ordered.afterPath = where.afterPath;
  if (where.inSchema !== false && where.schemaPath !== undefined) ordered.schemaPath = where.schemaPath;
  ordered.labels = where.labels ?? [];
  if (!values.redacted) {
    if (values.before !== undefined) ordered.before = values.before;
    if (values.after !== undefined) ordered.after = values.after;
  }
  const item = values.item ?? where.item;
  if (item && !values.redacted) ordered.item = { key: item.key, label: item.label };
  ordered.display = where.itemAt?.length ? { ...display, itemLabels: [...where.itemAt] } : display;
  if (values.redacted) ordered.redacted = true;
  ordered.inSchema = where.inSchema ?? true;
  return ordered as Change;
}

const DISPLAY_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

/** Freezes what `describe` needs from the schema: type, format, the labels for these values, item noun. */
function displayOf(node: FieldNode | undefined, values: Values, itemNoun?: string): ChangeDisplay {
  const d: ChangeDisplay = {};
  if (node) {
    const type = node.kind === 'value' ? node.type : node.kind === 'object' ? 'object' : 'array';
    if (type !== undefined && DISPLAY_TYPES.has(type)) d.type = type as ChangeDisplay['type'];
    if (node.kind === 'value') {
      if (node.format === 'date' || node.format === 'date-time') d.format = node.format;
      if (node.coded && !values.redacted) {
        const label = (v: unknown) =>
          v == null || v === '' || typeof v === 'object' ? undefined : (node.valueLabels.get(String(v)) ?? String(v));
        const beforeLabel = label(values.before);
        const afterLabel = label(values.after);
        if (beforeLabel !== undefined) d.beforeLabel = beforeLabel;
        if (afterLabel !== undefined) d.afterLabel = afterLabel;
      }
    }
  }
  if (itemNoun !== undefined) d.itemNoun = itemNoun;
  return d;
}

function emit(ctx: Ctx, change: Change): void {
  if (ctx.out.length >= ctx.maxChanges) {
    ctx.out.push({ code: 'TRUNCATED', labels: [], display: {}, inSchema: true });
    throw STOP;
  }
  ctx.out.push(change);
}

// ---------------------------------------------------------------- input checks

function checkRecord(record: unknown, side: 'before' | 'after', maxDepth: number): void {
  if (record == null) return;
  if (!isPlainObject(record)) throw new DiffError('INVALID_RECORD', '', 'a record must be a plain object or null', { side });
  checkJson(record, '', 1, new Set(), side, maxDepth);
}

function checkJson(v: unknown, path: string, depth: number, stack: Set<object>, side: 'before' | 'after', maxDepth: number): void {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new DiffError('NOT_JSON', path, `${v} is not a JSON number`, { side });
    return;
  }
  if (typeof v !== 'object') throw new DiffError('NOT_JSON', path, `a ${typeof v} is not a JSON value`, { side });
  if (depth > maxDepth) throw new DiffError('TOO_DEEP', path, `nested deeper than maxDepth (${maxDepth})`, { side });
  if (stack.has(v)) throw new DiffError('NOT_JSON', path, 'the value contains a cycle', { side });
  stack.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (!(i in v) || v[i] === undefined) throw new DiffError('NOT_JSON', `${path}/${i}`, 'undefined is not a JSON value', { side });
      checkJson(v[i], `${path}/${i}`, depth + 1, stack, side, maxDepth);
    }
  } else if (isPlainObject(v)) {
    for (const key of Object.keys(v)) {
      if (v[key] !== undefined) checkJson(v[key], `${path}/${escapePointer(key)}`, depth + 1, stack, side, maxDepth);
    }
  } else {
    const name = (v as object).constructor?.name ?? 'object';
    throw new DiffError('NOT_JSON', path, `a ${name} is not a JSON value; convert it first`, { side });
  }
  stack.delete(v);
}
