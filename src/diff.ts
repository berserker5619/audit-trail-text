import { DiffError } from './errors.ts';
import type {
  Adapter,
  AtomicSpec,
  Change,
  ChangeDisplay,
  ChangeCode,
  DiffOptions,
  FieldNode,
  ItemRef,
  LangMap,
  ObjectListNode,
  ObjectNode,
  ValueListNode,
  ValueNode,
} from './types.ts';
import { canonical, escapePointer, isEmpty, isPlainObject, langEntries, own, pickLang, setProp, templateFields, titleCase } from './util.ts';

type Rec = Record<string, unknown>;

interface Ctx {
  out: Change[];
  maxChanges: number;
  ignore: ReadonlySet<string>;
  expandObjects: boolean;
  /** The language that language-map labels are resolved in. */
  lang: string;
  /** Work still to do, last first. The walk never recurses, so no depth can overflow the stack. */
  tasks: (() => void)[];
  /** Items of tree-scoped lists in each version, when the schema has any. */
  trees?: { before: Trees; after: Trees };
  /** Tree items already reported as moved. */
  moved: Set<string>;
}

/** A label path, shared between places: each step adds one label to its parent's path. */
interface Lbl {
  text: string;
  map?: LangMap;
  /** An item's name: data, never translated. */
  item: boolean;
  prev: Lbl | null;
}

/** Where the walk is: both record pointers, the labels path, and what a change here carries. */
interface Loc {
  bp: string;
  ap: string;
  /** Record path with `*` for list items, matched against `ignore`. */
  lp: string;
  sp: string;
  labels: Lbl | null;
  item?: ItemRef;
  inSchema: boolean;
  /** The definition of the list whose item this is, so a nested list of the same tree isn't named twice. */
  list?: string;
}

const STOP = Symbol('stop');

/**
 * Compares two versions of a record. Pure: the same input gives the same changes in the same order.
 * `before` may be null (record created) and `after` may be null (record deleted).
 */
export function diffRecords(before: unknown, after: unknown, adapter: Adapter, options: DiffOptions = {}): Change[] {
  const maxDepth = count(options.maxDepth, 32, 'maxDepth');
  const maxChanges = count(options.maxChanges, 1000, 'maxChanges');
  const lang = language(options.fallbackLanguage);
  checkRecord(before, 'before', maxDepth);
  checkRecord(after, 'after', maxDepth);

  const ctx: Ctx = {
    out: [],
    maxChanges,
    ignore: new Set(options.ignore ?? []),
    expandObjects: options.expandObjects === true,
    lang,
    tasks: [],
    moved: new Set(),
  };
  const root = adapter.root;
  const recordLabel = lbl(null, adapter.recordNounI18n ? pickLang(adapter.recordNounI18n, lang) : adapter.recordNoun, adapter.recordNounI18n);
  try {
    if (before == null && after == null) return [];
    if (before == null) {
      emit(ctx, make('RECORD_CREATED', { afterPath: '', schemaPath: root.schemaPath, labels: recordLabel, inSchema: true }, {
        after: strip(after, root, '', ctx, true),
      }, { type: 'object' }));
    } else if (after == null) {
      emit(ctx, make('RECORD_DELETED', { beforePath: '', schemaPath: root.schemaPath, labels: recordLabel, inSchema: true }, {
        before: strip(before, root, '', ctx, true),
      }, { type: 'object' }));
    } else {
      if (hasTree(root)) ctx.trees = { before: collectTrees(ctx, root, before as Rec, 'before'), after: collectTrees(ctx, root, after as Rec, 'after') };
      walkObject(ctx, root, before as Rec, after as Rec, { bp: '', ap: '', lp: '', sp: root.schemaPath, labels: null, inSchema: true });
      run(ctx);
      if (ctx.trees) movesInsideWholeValues(ctx, ctx.trees);
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

function language(value: unknown): string {
  if (value === undefined) return 'en';
  try {
    if (typeof value !== 'string' || value === '') throw new Error('it must be a language tag such as "en"');
    Intl.getCanonicalLocales(value);
    return value;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new DiffError('INVALID_OPTION', 'fallbackLanguage', `fallbackLanguage ${JSON.stringify(value)} is not valid: ${reason}`);
  }
}

/** Queues work to run in the order given, before anything queued earlier. */
function schedule(ctx: Ctx, tasks: (() => void)[]): void {
  for (let i = tasks.length - 1; i >= 0; i--) ctx.tasks.push(tasks[i]!);
}

function run(ctx: Ctx): void {
  while (ctx.tasks.length > 0) ctx.tasks.pop()!();
}

// ---------------------------------------------------------------- labels

const lbl = (prev: Lbl | null, text: string, map?: LangMap, item = false): Lbl => ({ text, ...(map && { map }), item, prev });

/** A node's title in the stored language. */
function titleOf(ctx: Ctx, node: FieldNode): string {
  return node.titleI18n ? pickLang(node.titleI18n, ctx.lang) : node.title;
}

/**
 * The labels for a field inside an object. A list directly inside an item of the same tree adds
 * no title of its own: "Parts › Body › Sleeve", not "Parts › Body › Parts › Sleeve".
 */
function fieldLabels(ctx: Ctx, parent: Lbl | null, child: FieldNode, list: string | undefined): Lbl | null {
  if (child.kind === 'objectList' && child.def !== undefined && child.def === list) return parent;
  return lbl(parent, titleOf(ctx, child), child.titleI18n);
}

function nounOf(ctx: Ctx, list: ObjectListNode | ValueListNode): { text: string; map?: LangMap } {
  return list.itemNounI18n ? { text: pickLang(list.itemNounI18n, ctx.lang), map: list.itemNounI18n } : { text: list.itemNoun };
}

// ---------------------------------------------------------------- walking

/** Keys in schema order, then keys the schema doesn't describe, sorted. */
function orderedKeys(node: ObjectNode | undefined, records: Rec[]): string[] {
  const extra = new Set<string>();
  for (const o of records) for (const k of Object.keys(o)) if (!node?.properties.has(k)) extra.add(k);
  return [...(node?.properties.keys() ?? []), ...[...extra].sort()];
}

function walkObject(ctx: Ctx, node: ObjectNode | undefined, b: Rec, a: Rec, loc: Loc): void {
  const tasks: (() => void)[] = [];
  for (const key of orderedKeys(node, [b, a])) {
    const lp = `${loc.lp}/${key}`;
    if (ctx.ignore.size > 0 && ctx.ignore.has(lp)) continue;
    const bv = own(b, key);
    const av = own(a, key);
    if (bv === undefined && av === undefined) continue;
    const known = node ? childOf(node, key) : undefined;
    const child = known ?? unknownNode(key, bv, av);
    const segment = escapePointer(key);
    const at: Loc = {
      bp: `${loc.bp}/${segment}`,
      ap: `${loc.ap}/${segment}`,
      lp,
      sp: known ? child.schemaPath : '',
      labels: fieldLabels(ctx, loc.labels, child, loc.list),
      ...(loc.item && { item: loc.item }),
      inSchema: loc.inSchema && known !== undefined,
    };
    tasks.push(() => diffField(ctx, child, bv, av, at));
  }
  schedule(ctx, tasks);
}

/**
 * The schema node for a key: a property, else the first matching `patternProperties` entry, else
 * `additionalProperties`. Map entries are labelled with their key as written.
 */
function childOf(node: ObjectNode, key: string): FieldNode | undefined {
  const property = node.properties.get(key);
  if (property) return property;
  const entry = node.patterns?.find((p) => p.pattern.test(key))?.node ?? node.additional;
  if (!entry) return undefined;
  const { titleI18n: _, ...rest } = entry;
  return { ...rest, title: key } as FieldNode;
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
  // Sensitive fields of an atomic value are never stored, so they don't count as a change either.
  const hide = node.kind === 'value' && node.atomic?.sensitive !== undefined;
  const bs = strip(b, node, loc.lp, ctx, hide);
  const as = strip(a, node, loc.lp, ctx, hide);
  const bEmpty = isEmpty(bs);
  const aEmpty = isEmpty(as);
  if (bEmpty && aEmpty) return;
  let code: ChangeCode;
  if (bEmpty) code = 'FIELD_SET';
  else if (aEmpty) code = 'FIELD_CLEARED';
  else if (sameValue(node, bs, as)) return;
  else code = 'FIELD_CHANGED';
  emitField(ctx, node, code, b, a, loc);
}

/** Atomic objects with a key on both sides are equal when their keys are; everything else by value. */
function sameValue(node: FieldNode, b: unknown, a: unknown): boolean {
  const atomic = node.kind === 'value' ? node.atomic : undefined;
  if (atomic) {
    const bk = atomicKey(atomic, b);
    const ak = atomicKey(atomic, a);
    if (bk !== undefined && ak !== undefined) return bk === ak;
  }
  return canonical(b) === canonical(a);
}

/** An atomic value's identity: its key fields, or undefined when it lacks any of them. */
function atomicKey(atomic: AtomicSpec, v: unknown): string | undefined {
  if (atomic.key.length === 0 || !isPlainObject(v)) return undefined;
  const values = atomic.key.map((field) => own(v, field));
  return values.some((x) => x == null || x === '') ? undefined : canonical(values);
}

function diffObjectField(ctx: Ctx, node: ObjectNode, b: Rec | null | undefined, a: Rec | null | undefined, loc: Loc): void {
  // Emptiness is checked after ignored fields are stripped.
  const bEmpty = strippedEmpty(b, loc.lp, ctx);
  const aEmpty = strippedEmpty(a, loc.lp, ctx);
  if (bEmpty && aEmpty) return;
  if ((bEmpty || aEmpty) && !ctx.expandObjects) {
    return emitField(ctx, node, bEmpty ? 'FIELD_SET' : 'FIELD_CLEARED', b, a, loc);
  }
  walkObject(ctx, node, b ?? {}, a ?? {}, loc);
}

/** Whether an object is empty once ignored fields are taken out, without copying it. */
function strippedEmpty(v: Rec | null | undefined, lp: string, ctx: Ctx): boolean {
  if (v == null) return true;
  return Object.keys(v).every((k) => v[k] === undefined || (ctx.ignore.size > 0 && ctx.ignore.has(`${lp}/${k}`)));
}

function emitField(ctx: Ctx, node: FieldNode, code: ChangeCode, b: unknown, a: unknown, loc: Loc): void {
  const values: Values = node.sensitive
    ? { redacted: true }
    : { before: strip(b, node, loc.lp, ctx, true), after: strip(a, node, loc.lp, ctx, true) };
  emit(ctx, make(code, at(loc, true, true), values, displayOf(ctx, loc.inSchema ? node : undefined, values)));
}

// ---------------------------------------------------------------- lists

interface Entry {
  index: number;
  item: Rec;
  key: unknown;
}

interface Indexed {
  ids: string[];
  byId: Map<string, Entry>;
}

function diffObjectList(ctx: Ctx, node: ObjectListNode, b: unknown[] | null | undefined, a: unknown[] | null | undefined, loc: Loc): void {
  const bi = indexItems(node, b ?? [], loc.bp, 'before');
  const ai = indexItems(node, a ?? [], loc.ap, 'after');
  const itemLp = `${loc.lp}/*`;
  const tree = node.keyScope === 'tree' && ctx.trees ? treeId(node) : undefined;
  const tasks: (() => void)[] = [];

  for (const id of ai.ids) {
    const was = bi.byId.get(id);
    if (!was) continue;
    const now = ai.byId.get(id)!;
    tasks.push(() => walkItem(ctx, node, was.item, now.item, { ...loc, bp: `${loc.bp}/${was.index}`, ap: `${loc.ap}/${now.index}` }, now.key));
  }

  const whole = (code: ChangeCode, entry: Entry, side: 'before' | 'after') => {
    const ref = itemRef(ctx, node, entry.item, entry.key);
    const path = `${side === 'before' ? loc.bp : loc.ap}/${entry.index}`;
    const values: Values = node.sensitive
      ? { redacted: true }
      : { [side]: strip(entry.item, node.item, itemLp, ctx, true), ...(ref && { item: ref }) };
    emit(ctx, make(code, {
      ...(side === 'before' ? { beforePath: path } : { afterPath: path }),
      schemaPath: node.item.schemaPath,
      labels: named(loc.labels, ref),
      inSchema: loc.inSchema,
    }, values, displayOf(ctx, node.item, values, node)));
  };
  // An item that left for another parent of the same tree is reported there, as moved.
  for (const id of bi.ids) {
    if (!ai.byId.has(id) && !(tree && ctx.trees!.after.get(tree)?.has(id))) tasks.push(() => whole('ITEM_REMOVED', bi.byId.get(id)!, 'before'));
  }
  for (const id of ai.ids) {
    if (bi.byId.has(id)) continue;
    const from = tree ? ctx.trees!.before.get(tree)?.get(id) : undefined;
    const entry = ai.byId.get(id)!;
    if (from) tasks.push(() => moveIn(ctx, tree!, from, entry.item, { ...loc, ap: `${loc.ap}/${entry.index}` }, entry.key));
    else tasks.push(() => whole('ITEM_ADDED', entry, 'after'));
  }

  const beforeOrder = bi.ids.filter((id) => ai.byId.has(id));
  const afterOrder = ai.ids.filter((id) => bi.byId.has(id));
  if (beforeOrder.some((id, i) => id !== afterOrder[i])) {
    tasks.push(() => {
      // Only the items that moved are stored: those outside a longest run kept in the same order.
      const moved = movedItems(beforeOrder, afterOrder);
      const kept = afterOrder.filter((id) => moved.has(id)).slice(0, MAX_REORDER_KEYS);
      const shown = new Set(kept);
      const keys = (ids: string[], index: Indexed) => ids.filter((id) => shown.has(id)).map((id) => index.byId.get(id)!.key);
      const noun = nounOf(ctx, node);
      emit(ctx, make('LIST_REORDERED', at(loc, true, true), node.sensitive
        ? { redacted: true }
        : { before: keys(beforeOrder, bi), after: keys(afterOrder, ai) }, {
        type: 'array',
        itemNoun: noun.text,
        moved: moved.size,
        ...(noun.map && { i18n: { itemNoun: noun.map } }),
      }));
    });
  }
  schedule(ctx, tasks);
}

/** Walks a matched item's fields. `loc` is the list's place, with the item's pointers. */
function walkItem(ctx: Ctx, node: ObjectListNode, b: Rec, a: Rec, loc: Loc, key: unknown): void {
  const ref = itemRef(ctx, node, a, key);
  const { item: _, list: __, ...rest } = loc;
  walkObject(ctx, node.item, b, a, {
    ...rest,
    lp: `${loc.lp}/*`,
    sp: node.item.schemaPath,
    labels: named(loc.labels, ref),
    ...(ref && { item: ref }),
    ...(node.def !== undefined && { list: node.def }),
  });
}

/** An item that came from another parent of the same tree: one ITEM_MOVED, then its own field changes. */
function moveIn(ctx: Ctx, tree: string, from: TreeEntry, item: Rec, loc: Loc, key: unknown): void {
  ctx.moved.add(`${tree}\u0000${from.id}`);
  const node = from.list;
  const ref = itemRef(ctx, node, item, key);
  const noun = nounOf(ctx, node);
  const fromParent = materialize(from.parent);
  const toParent = materialize(loc.labels);
  const display: ChangeDisplay = { type: 'object', itemNoun: noun.text, fromParent: fromParent.labels, toParent: toParent.labels };
  if (fromParent.itemAt.length > 0) display.fromItemLabels = fromParent.itemAt;
  if (noun.map || fromParent.maps) {
    display.i18n = { ...(noun.map && { itemNoun: noun.map }), ...(fromParent.maps && { fromParent: fromParent.maps }) };
  }
  emit(ctx, make('ITEM_MOVED', {
    beforePath: from.ptr,
    afterPath: loc.ap,
    schemaPath: node.item.schemaPath,
    labels: named(loc.labels, ref),
    inSchema: loc.inSchema,
  }, node.sensitive ? { redacted: true } : ref ? { item: ref } : {}, display));
  walkItem(ctx, node, from.item, item, { ...loc, bp: from.ptr }, key);
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
    const { id, key } = itemKey(node, item, `${path}/${index}`, side);
    if (byId.has(id)) throw new DiffError('DUPLICATE_KEY', path, `two items share the key ${canonical(key)}`, { side, key });
    ids.push(id);
    byId.set(id, { index, item: item as Rec, key });
  });
  return { ids, byId };
}

/** An item's key, and the text it is matched by. */
function itemKey(node: ObjectListNode, item: unknown, itemPath: string, side: 'before' | 'after'): { id: string; key: unknown } {
  if (!isPlainObject(item)) throw new DiffError('ITEM_KEY_MISSING', itemPath, 'list item is not an object', { side });
  const values = node.key.map((field) => {
    const v = own(item, field);
    if (v == null || v === '') throw new DiffError('ITEM_KEY_MISSING', itemPath, `item has no "${field}"`, { side });
    if (typeof v === 'object') {
      throw new DiffError('INVALID_KEY', itemPath, `key field "${field}" must be a string, number or boolean`, { side });
    }
    return v;
  });
  return { id: canonical(values), key: values.length === 1 ? values[0] : values };
}

type Named = ItemRef & { map?: LangMap };

/** Left out for sensitive lists, so keys and labels can't leak. */
function itemRef(ctx: Ctx, node: ObjectListNode, item: Rec, key: unknown): Named | undefined {
  if (node.sensitive) return undefined;
  // A stored code is named by its label: an address keyed by `kind: "home"` reads as "Home".
  const part = (field: string): Text => fieldText(ctx, node.item.properties.get(field), own(item, field));
  const fallback = joinTexts(ctx, node.key.map(part), (texts) => texts.join(', '));
  const label = node.itemLabel ? fillTemplate(ctx, node.itemLabel, part) : undefined;
  const chosen = label && label.text ? label : fallback;
  return { key, label: chosen.text, ...(chosen.map && { map: chosen.map }) };
}

/** Text in the stored language, with the language map it came from. */
interface Text {
  text: string;
  map?: LangMap;
}

/** How a field's value reads inside an item or value label. */
function fieldText(ctx: Ctx, child: FieldNode | undefined, v: unknown): Text {
  if (v == null) return { text: '' };
  if (child?.kind === 'value' && typeof v !== 'object') {
    const map = child.valueLabelsI18n?.get(String(v));
    if (map) return { text: pickLang(map, ctx.lang), map };
    const label = child.valueLabels.get(String(v));
    if (label !== undefined) return { text: label };
  }
  if (child?.kind === 'value' && child.atomic) {
    const label = atomicLabel(ctx, child, v);
    if (label) return label;
  }
  if (typeof v === 'string') return { text: v };
  const map = langEntries(v);
  if (map && isPlainObject(v) && Object.keys(v).every((k) => k.startsWith('$') || typeof v[k] === 'string')) {
    return { text: pickLang(map, ctx.lang), map };
  }
  return { text: canonical(v) };
}

/** Joins texts; when any of them is a language map, the result is one too, in every language they have. */
function joinTexts(ctx: Ctx, parts: Text[], join: (texts: string[]) => string): Text {
  const text = join(parts.map((p) => p.text));
  const langs = [...new Set(parts.flatMap((p) => (p.map ? Object.keys(p.map).filter((k) => !k.startsWith('$')) : [])))];
  if (langs.length === 0) return { text };
  const map: LangMap = {};
  for (const l of langs) setProp(map, l, join(parts.map((p) => (p.map ? pickLang(p.map, l, ctx.lang) : p.text))));
  return { text, map };
}

function fillTemplate(ctx: Ctx, template: string, part: (field: string) => Text): Text {
  const parts = templateFields(template).map(part);
  return joinTexts(ctx, parts, (texts) => {
    let i = 0;
    return template.replace(/\{([^{}]+)\}/g, () => texts[i++]!).trim();
  });
}

/**
 * How an atomic value reads: its `x-label` template, its own language entries for "@lang", else
 * its key values, else its text fields. Undefined when nothing reads well; the raw object is never shown.
 */
function atomicLabel(ctx: Ctx, node: ValueNode, v: unknown): Text | undefined {
  const atomic = node.atomic;
  if (!atomic || !isPlainObject(v)) return undefined;
  if (atomic.label === '@lang') {
    const map = langEntries(v);
    return map ? { text: pickLang(map, ctx.lang), map } : undefined;
  }
  const part = (field: string): Text => fieldText(ctx, undefined, own(v, field));
  const result = atomic.label
    ? fillTemplate(ctx, atomic.label, part)
    : atomic.key.length > 0 && atomicKey(atomic, v) !== undefined
      ? joinTexts(ctx, atomic.key.map(part), (texts) => texts.join(', '))
      : joinTexts(ctx, Object.keys(v).filter((k) => !k.startsWith('$') && typeof v[k] !== 'object').map(part), (texts) => texts.join(', '));
  return result.text ? result : undefined;
}

/** Compared by value, counting duplicates. Order is never reported. */
function diffValueList(ctx: Ctx, node: ValueListNode, b: unknown[] | null | undefined, a: unknown[] | null | undefined, loc: Loc): void {
  const bl = b ?? [];
  const al = a ?? [];
  const itemLp = `${loc.lp}/*`;
  const atomic = node.item.kind === 'value' ? node.item.atomic : undefined;
  // Atomic values with a key are matched by it, so a renamed option is the same option.
  const ids = (list: unknown[]) =>
    list.map((v) => {
      const key = atomic ? atomicKey(atomic, v) : undefined;
      return key !== undefined ? `key:${key}` : canonical(strip(v, node.item, itemLp, ctx, false));
    });
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
  const whole = (code: ChangeCode, value: unknown, path: { beforePath?: string; afterPath?: string }) => {
    const values: Values = node.sensitive
      ? { redacted: true }
      : { [code === 'ITEM_ADDED' ? 'after' : 'before']: strip(value, node.item, itemLp, ctx, true) };
    const where: Where = { ...path, schemaPath: node.item.schemaPath, labels: loc.labels, ...(loc.item && { item: loc.item }), inSchema: loc.inSchema };
    emit(ctx, make(code, where, values, displayOf(ctx, node.item, values, node)));
  };
  for (const i of unmatched(bIds, aIds)) whole('ITEM_REMOVED', bl[i], { beforePath: `${loc.bp}/${i}` });
  for (const i of unmatched(aIds, bIds)) whole('ITEM_ADDED', al[i], { afterPath: `${loc.ap}/${i}` });
}

// ---------------------------------------------------------------- trees

/** A tree-scoped list's item in one version. */
interface TreeEntry {
  id: string;
  key: unknown;
  /** JSON Pointer to the item. */
  ptr: string;
  /** Record path with `*`, for `ignore`. */
  lp: string;
  item: Rec;
  list: ObjectListNode;
  /** Labels of the place the item sits in: its list, or its parent item in a tree. */
  parent: Lbl | null;
  /** The parent: the nearest enclosing item of the same tree and the path below it, else the keyed path from the root. */
  addr: string;
  inSchema: boolean;
}

/** Tree id → item id → entry. */
type Trees = Map<string, Map<string, TreeEntry>>;

const treeId = (node: ObjectListNode) => node.def ?? node.schemaPath;

const hasTreeCache = new WeakMap<ObjectNode, boolean>();

/** Whether any list in the schema has tree-scoped keys. */
function hasTree(root: ObjectNode): boolean {
  const known = hasTreeCache.get(root);
  if (known !== undefined) return known;
  const seen = new Set<FieldNode>();
  const stack: FieldNode[] = [root];
  let found = false;
  while (stack.length > 0 && !found) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.kind === 'object') {
      stack.push(...node.properties.values(), ...(node.patterns ?? []).map((p) => p.node));
      if (node.additional) stack.push(node.additional);
    } else if (node.kind === 'objectList') {
      if (node.keyScope === 'tree') found = true;
      stack.push(node.item);
    } else if (node.kind === 'valueList') stack.push(node.item);
  }
  hasTreeCache.set(root, found);
  return found;
}

interface Anchor {
  tree: string;
  id: string;
  /** Path from the anchor item down to here, with item keys in place of indexes. */
  rel: string;
}

interface Visit {
  node: FieldNode;
  v: unknown;
  ptr: string;
  lp: string;
  /** Path from the root with item keys in place of indexes. */
  kp: string;
  labels: Lbl | null;
  list?: string;
  anchors: readonly Anchor[];
  inSchema: boolean;
}

/**
 * Collects every item of a tree-scoped list in one version, with where it sits. A key used twice
 * in one tree throws DUPLICATE_KEY with both paths.
 */
function collectTrees(ctx: Ctx, root: ObjectNode, record: Rec, side: 'before' | 'after'): Trees {
  const trees: Trees = new Map();
  const stack: Visit[] = [{ node: root, v: record, ptr: '', lp: '', kp: '', labels: null, anchors: [], inSchema: true }];
  const step = (anchors: readonly Anchor[], seg: string) => anchors.map((x) => ({ ...x, rel: x.rel + seg }));
  while (stack.length > 0) {
    const s = stack.pop()!;
    const next: Visit[] = [];
    if (s.node.kind === 'object' && isPlainObject(s.v)) {
      for (const key of orderedKeys(s.node, [s.v])) {
        const lp = `${s.lp}/${key}`;
        if (ctx.ignore.size > 0 && ctx.ignore.has(lp)) continue;
        const child = childOf(s.node, key);
        const v = own(s.v, key);
        if (!child || v == null || child.kind === 'value' || child.kind === 'valueList') continue;
        const seg = `/${escapePointer(key)}`;
        next.push({ node: child, v, ptr: s.ptr + seg, lp, kp: s.kp + seg, labels: fieldLabels(ctx, s.labels, child, s.list), anchors: step(s.anchors, seg), inSchema: s.inSchema });
      }
    } else if (s.node.kind === 'objectList' && Array.isArray(s.v)) {
      const node = s.node;
      const tree = node.keyScope === 'tree' ? treeId(node) : undefined;
      const anchor = tree === undefined ? undefined : s.anchors.find((x) => x.tree === tree);
      const addr = anchor ? `${anchor.id}\u0000${anchor.rel}` : `\u0000${s.kp}`;
      s.v.forEach((item, index) => {
        const ptr = `${s.ptr}/${index}`;
        const { id, key } = itemKey(node, item, ptr, side);
        const rec = item as Rec;
        const seg = `/${id}`;
        if (tree !== undefined) {
          let entries = trees.get(tree);
          if (!entries) trees.set(tree, (entries = new Map()));
          const first = entries.get(id);
          if (first) {
            throw new DiffError('DUPLICATE_KEY', ptr, `two items in the tree share the key ${canonical(key)}: ${first.ptr} and ${ptr}`, {
              side,
              key,
              paths: [first.ptr, ptr],
            });
          }
          entries.set(id, { id, key, ptr, lp: `${s.lp}/*`, item: rec, list: node, parent: s.labels, addr, inSchema: s.inSchema });
        }
        const anchors = tree === undefined ? step(s.anchors, seg) : [...step(s.anchors.filter((x) => x.tree !== tree), seg), { tree, id, rel: '' }];
        next.push({
          node: node.item,
          v: rec,
          ptr,
          lp: `${s.lp}/*`,
          kp: s.kp + seg,
          labels: named(s.labels, itemRef(ctx, node, rec, key)),
          ...(node.def !== undefined && { list: node.def }),
          anchors,
          inSchema: s.inSchema,
        });
      });
    }
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
  }
  return trees;
}

/**
 * Moves the walk could not reach, because the item went into something added whole, such as a
 * new parent: reported after the walk, each with its field changes.
 */
function movesInsideWholeValues(ctx: Ctx, trees: { before: Trees; after: Trees }): void {
  for (const [tree, entries] of trees.after) {
    const before = trees.before.get(tree);
    if (!before) continue;
    for (const [id, now] of entries) {
      const was = before.get(id);
      if (!was || was.addr === now.addr || ctx.moved.has(`${tree}\u0000${id}`)) continue;
      ctx.tasks.push(() =>
        moveIn(ctx, tree, was, now.item, { bp: was.ptr, ap: now.ptr, lp: now.lp.slice(0, -2), sp: now.list.schemaPath, labels: now.parent, inSchema: now.inSchema }, now.key),
      );
      run(ctx);
    }
  }
}

// ---------------------------------------------------------------- values

/**
 * Copies a value without ignored fields, and without sensitive fields when `dropSensitive`.
 * Normalises -0 to 0. Never mutates the input. Walks with an explicit stack.
 */
function strip(v: unknown, node: FieldNode | undefined, lp: string, ctx: Ctx, dropSensitive: boolean): unknown {
  if (!Array.isArray(v) && !isPlainObject(v)) return Object.is(v, -0) ? 0 : v;
  const ignoring = ctx.ignore.size > 0;
  let result: unknown;
  const jobs: { v: unknown; node: FieldNode | undefined; lp: string; set: (x: unknown) => void }[] = [
    { v, node, lp, set: (x) => (result = x) },
  ];
  while (jobs.length > 0) {
    const job = jobs.pop()!;
    const x = job.v;
    if (Array.isArray(x)) {
      const item = job.node?.kind === 'objectList' || job.node?.kind === 'valueList' ? job.node.item : undefined;
      const itemLp = ignoring ? `${job.lp}/*` : '';
      if (ignoring && ctx.ignore.has(itemLp)) {
        job.set([]);
        continue;
      }
      const out: unknown[] = new Array(x.length);
      job.set(out);
      for (let i = x.length - 1; i >= 0; i--) jobs.push({ v: x[i], node: item, lp: itemLp, set: (y) => (out[i] = y) });
    } else if (isPlainObject(x)) {
      const objectNode = job.node?.kind === 'object' ? job.node : undefined;
      const hidden = dropSensitive && job.node?.kind === 'value' ? job.node.atomic?.sensitive : undefined;
      const out: Rec = {};
      job.set(out);
      const children: typeof jobs = [];
      for (const key of Object.keys(x)) {
        const childLp = ignoring ? `${job.lp}/${key}` : '';
        if (ignoring && ctx.ignore.has(childLp)) continue;
        const child = objectNode ? childOf(objectNode, key) : undefined;
        if (dropSensitive && (child?.sensitive || hidden?.includes(key))) continue;
        if (x[key] === undefined) continue;
        setProp(out, key, null); // keeps the key order; the value is filled in below
        children.push({ v: x[key], node: child, lp: childLp, set: (y) => setProp(out, key, y) });
      }
      for (let i = children.length - 1; i >= 0; i--) jobs.push(children[i]!);
    } else {
      job.set(Object.is(x, -0) ? 0 : x);
    }
  }
  return result;
}

// ---------------------------------------------------------------- output

type Values = { before?: unknown; after?: unknown; item?: Named; redacted?: true };
type Where = Pick<Change, 'beforePath' | 'afterPath' | 'schemaPath' | 'inSchema'> & { labels: Lbl | null; item?: ItemRef };

/** Labels for an item: its name is added, except in a sensitive list, where nothing is. */
function named(labels: Lbl | null, ref: Named | undefined): Lbl | null {
  return ref ? lbl(labels, ref.label, ref.map, true) : labels;
}

/** A label path as stored: the labels, the positions of item names, and language maps where any. */
function materialize(labels: Lbl | null): { labels: string[]; itemAt: number[]; maps?: (LangMap | null)[] } {
  const chain: Lbl[] = [];
  for (let l = labels; l; l = l.prev) chain.push(l);
  chain.reverse();
  const itemAt: number[] = [];
  chain.forEach((l, i) => l.item && itemAt.push(i));
  const maps = chain.some((l) => l.map) ? chain.map((l) => l.map ?? null) : undefined;
  return { labels: chain.map((l) => l.text), itemAt, ...(maps && { maps }) };
}

function at(loc: Loc, withBefore: boolean, withAfter: boolean): Where {
  return {
    ...(withBefore && { beforePath: loc.bp }),
    ...(withAfter && { afterPath: loc.ap }),
    schemaPath: loc.sp,
    labels: loc.labels,
    ...(loc.item && { item: loc.item }),
    inSchema: loc.inSchema,
  };
}

/** Builds a change with a fixed key order and no undefined members, so stored JSON is stable. */
function make(code: ChangeCode, where: Where, values: Values, display: ChangeDisplay): Change {
  const ordered: Partial<Change> = { code };
  if (where.beforePath !== undefined) ordered.beforePath = where.beforePath;
  if (where.afterPath !== undefined) ordered.afterPath = where.afterPath;
  if (where.inSchema !== false && where.schemaPath !== undefined) ordered.schemaPath = where.schemaPath;
  const path = materialize(where.labels);
  ordered.labels = path.labels;
  if (!values.redacted) {
    if (values.before !== undefined) ordered.before = values.before;
    if (values.after !== undefined) ordered.after = values.after;
  }
  const item = values.item ?? where.item;
  if (item && !values.redacted) ordered.item = { key: item.key, label: item.label };
  const { i18n, ...rest } = display;
  const out: ChangeDisplay = path.itemAt.length ? { ...rest, itemLabels: path.itemAt } : rest;
  const allI18n = { ...(path.maps && { labels: path.maps }), ...i18n };
  if (Object.keys(allI18n).length > 0) out.i18n = allI18n;
  ordered.display = out;
  if (values.redacted) ordered.redacted = true;
  ordered.inSchema = where.inSchema ?? true;
  return ordered as Change;
}

const DISPLAY_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

/** Freezes what `describe` needs from the schema: type, format, the labels for these values, item noun. */
function displayOf(ctx: Ctx, node: FieldNode | undefined, values: Values, list?: ObjectListNode | ValueListNode): ChangeDisplay {
  const d: ChangeDisplay = {};
  const i18n: NonNullable<ChangeDisplay['i18n']> = {};
  if (node) {
    const type = node.kind === 'value' ? node.type : node.kind === 'object' ? 'object' : 'array';
    if (type !== undefined && DISPLAY_TYPES.has(type)) d.type = type as ChangeDisplay['type'];
    if (node.kind === 'value') {
      if (node.format === 'date' || node.format === 'date-time') d.format = node.format;
      const label = (v: unknown): Text | undefined => {
        if (node.atomic) return atomicLabel(ctx, node, v);
        if (!node.coded || v == null || v === '' || typeof v === 'object') return undefined;
        const map = node.valueLabelsI18n?.get(String(v));
        return map ? { text: pickLang(map, ctx.lang), map } : { text: node.valueLabels.get(String(v)) ?? String(v) };
      };
      if (!values.redacted) {
        const beforeLabel = label(values.before);
        const afterLabel = label(values.after);
        if (beforeLabel !== undefined) d.beforeLabel = beforeLabel.text;
        if (afterLabel !== undefined) d.afterLabel = afterLabel.text;
        if (beforeLabel?.map) i18n.beforeLabel = beforeLabel.map;
        if (afterLabel?.map) i18n.afterLabel = afterLabel.map;
      }
    }
  }
  if (list) {
    const noun = nounOf(ctx, list);
    d.itemNoun = noun.text;
    if (noun.map) i18n.itemNoun = noun.map;
  }
  if (Object.keys(i18n).length > 0) d.i18n = i18n;
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
  checkJson(record, side, maxDepth);
}

/** A place in the record being checked; its path is only built for an error. */
interface Check {
  v: unknown;
  depth: number;
  parent: Check | null;
  segment: string;
  /** Set once its children are queued: popping it again leaves the object. */
  leaving?: boolean;
  /** An array element: undefined there is not JSON. */
  inArray?: boolean;
}

function checkJson(record: unknown, side: 'before' | 'after', maxDepth: number): void {
  const pathOf = (c: Check) => {
    const segments: string[] = [];
    for (let x: Check | null = c; x && x.parent; x = x.parent) segments.push(x.segment);
    return segments.reverse().map((s) => `/${s}`).join('');
  };
  const fail = (code: 'NOT_JSON' | 'TOO_DEEP', c: Check, message: string) => new DiffError(code, pathOf(c), message, { side });
  const open = new Set<object>();
  const stack: Check[] = [{ v: record, depth: 1, parent: null, segment: '' }];
  while (stack.length > 0) {
    const c = stack.pop()!;
    const v = c.v;
    if (c.leaving) {
      open.delete(v as object);
      continue;
    }
    if (v === undefined && c.inArray) throw fail('NOT_JSON', c, 'undefined is not a JSON value');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw fail('NOT_JSON', c, `${v} is not a JSON number`);
      continue;
    }
    if (typeof v !== 'object') throw fail('NOT_JSON', c, `a ${typeof v} is not a JSON value`);
    if (c.depth > maxDepth) throw fail('TOO_DEEP', c, `nested deeper than maxDepth (${maxDepth})`);
    if (open.has(v)) throw fail('NOT_JSON', c, 'the value contains a cycle');
    const children: Check[] = [];
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) children.push({ v: i in v ? v[i] : undefined, depth: c.depth + 1, parent: c, segment: String(i), inArray: true });
    } else if (isPlainObject(v)) {
      for (const key of Object.keys(v)) {
        if (v[key] !== undefined) children.push({ v: v[key], depth: c.depth + 1, parent: c, segment: escapePointer(key) });
      }
    } else {
      const name = (v as object).constructor?.name ?? 'object';
      throw fail('NOT_JSON', c, `a ${name} is not a JSON value; convert it first`);
    }
    open.add(v);
    stack.push({ ...c, leaving: true });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
}
