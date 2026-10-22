import { diffRecords } from './diff.ts';
import { DiffError } from './errors.ts';
import type { Adapter, Change, DiffOptions, LangMap } from './types.ts';
import { canonical, isPlainObject, pickLang } from './util.ts';

/** A piece of a sentence, so a UI can style field names and values without parsing the text. */
export interface SentencePart {
  type: 'text' | 'field' | 'value';
  text: string;
}

export interface Sentence {
  text: string;
  parts: SentencePart[];
  change: Change;
}

/** Token values handed to a template function. Values are formatted, unquoted, and "" when redacted. */
export interface TemplateValues {
  field: string;
  parents: string;
  before: string;
  after: string;
  item: string;
  itemNoun: string;
  list: string;
  record: string;
  /** ITEM_MOVED: where the item came from and went to. */
  from: string;
  to: string;
}

export interface LabelContext {
  kind: 'field' | 'list' | 'itemNoun' | 'record';
  /** The change's schemaPath; absent for fields the schema doesn't describe. */
  schemaPath: string | undefined;
}

export type Template = string | ((change: Change, values: TemplateValues) => string);

/**
 * Template keys: one per code, plus variants for changes a plain template can't word well.
 * A variant falls back to its code's template, then to the English default.
 */
export type MessageKey =
  | Change['code']
  | 'FIELD_SET:whole'
  | 'FIELD_CLEARED:whole'
  | 'FIELD_CHANGED:whole'
  | 'FIELD_SET:redacted'
  | 'FIELD_CLEARED:redacted'
  | 'FIELD_CHANGED:redacted'
  | 'FIELD_CHANGED:unicode'
  | 'ITEM_ADDED:value'
  | 'ITEM_REMOVED:value'
  | 'ITEM_ADDED:redacted'
  | 'ITEM_REMOVED:redacted'
  | 'ITEM_MOVED:redacted';

export interface DescribeOptions {
  /** Default "en". Never guessed from the machine. */
  locale?: string;
  /** Default "UTC". Never guessed from the machine. */
  timeZone?: string;
  /** Default 80. Longer values are cut with "…"; raw values stay whole in the change. */
  maxValueLength?: number;
  messages?: Partial<Record<MessageKey, Template>>;
  /**
   * Translates the app's own words. Item names, such as a product called "Rose", never go through
   * it, and neither do labels stored with a language map.
   */
  translateLabel?: (label: string, context: LabelContext) => string;
  /** The language picked from labels stored with a language map. Default: the language part of `locale`. */
  language?: string;
  /** Default "en". Used when a map lacks `language`; a map lacking both gives its first language. */
  fallbackLanguage?: string;
  /** Default 3. A sentence names at most this many enclosing items: "… › Body › Sleeve › Cuff: …". */
  maxParents?: number;
}

/** English templates. Nested fields get "{parents}: " in front. */
export const defaultMessages: Readonly<Record<MessageKey, string>> = {
  FIELD_SET: '{field} set to {after}',
  FIELD_CLEARED: '{field} cleared (was {before})',
  FIELD_CHANGED: '{field} changed from {before} to {after}',
  'FIELD_SET:whole': '{field} added',
  'FIELD_CLEARED:whole': '{field} removed',
  'FIELD_CHANGED:whole': '{field} changed',
  'FIELD_SET:redacted': '{field} set',
  'FIELD_CLEARED:redacted': '{field} cleared',
  'FIELD_CHANGED:redacted': '{field} changed',
  'FIELD_CHANGED:unicode': '{field} changed from {before} to {after} (Unicode form changed)',
  ITEM_ADDED: '{itemNoun} {item} added to {list}',
  ITEM_REMOVED: '{itemNoun} {item} removed from {list}',
  'ITEM_ADDED:value': '{item} added to {list}',
  'ITEM_REMOVED:value': '{item} removed from {list}',
  'ITEM_ADDED:redacted': '{itemNoun} added to {list}',
  'ITEM_REMOVED:redacted': '{itemNoun} removed from {list}',
  ITEM_MOVED: '{itemNoun} {item} moved from {from} to {to}',
  'ITEM_MOVED:redacted': '{itemNoun} moved from {from} to {to}',
  LIST_REORDERED: '{list} reordered',
  RECORD_CREATED: '{record} created',
  RECORD_DELETED: '{record} deleted',
  TRUNCATED: 'More changes not shown',
};

const FIELD_TOKENS = new Set(['field', 'parents', 'itemNoun', 'list', 'record', 'from', 'to']);

/** Writes one sentence per change. Needs no adapter: each change carries its own display details. */
export function describe(changes: readonly Change[], options: DescribeOptions = {}): Sentence[] {
  const fmt = new Formatter(options);
  return changes.map((change) => sentence(change, options, fmt));
}

/** `diffRecords` then `describe`, with options for both steps. */
export function describeChanges(
  before: unknown,
  after: unknown,
  adapter: Adapter,
  options: DiffOptions & DescribeOptions = {},
): Sentence[] {
  return describe(diffRecords(before, after, adapter, options), options);
}

function sentence(change: Change, options: DescribeOptions, fmt: Formatter): Sentence {
  const translate = (label: string, kind: LabelContext['kind']) =>
    options.translateLabel?.(label, { kind, schemaPath: change.schemaPath }) ?? label;
  // A change stored without display details (hand-written, or from before 1.0) reads as untyped.
  const display: Change['display'] = change.display ?? {};
  const i18n = display.i18n ?? {};
  // A label stored with a language map is read in the reader's language; others as stored.
  const pick = (map: LangMap | null | undefined, text: string | undefined) => (map ? fmt.pick(map) : text);
  const items = new Set(display.itemLabels ?? []);
  const isMove = change.code === 'ITEM_MOVED';
  const isItem = change.code === 'ITEM_ADDED' || change.code === 'ITEM_REMOVED' || isMove;
  const isRecord = change.code === 'RECORD_CREATED' || change.code === 'RECORD_DELETED';
  // An object list's item is named by its item label; an atomic value in a list by its value label.
  const valueLabel = change.code === 'ITEM_ADDED' ? display.afterLabel : change.code === 'ITEM_REMOVED' ? display.beforeLabel : undefined;
  const objectItem = isItem && display.type === 'object' && valueLabel === undefined;
  // An item change's labels end with the item's name, except for plain values and sensitive lists.
  const last = change.labels.length - 1;
  const listIndex = isItem && items.has(last) ? last - 1 : last;
  const kindAt = (i: number): LabelContext['kind'] =>
    isRecord ? 'record' : items.has(i + 1) || (i === listIndex && (isItem || change.code === 'LIST_REORDERED')) ? 'list' : 'field';
  const labels = change.labels.map((label, i) => pick(i18n.labels?.[i], undefined) ?? (items.has(i) ? label : translate(label, kindAt(i))));
  const field = isMove ? '' : (labels[listIndex] ?? '');
  const parents = isMove ? [] : fmt.shorten(labels.slice(0, Math.max(listIndex, 0)), items);

  const redacted = change.redacted === true;
  let before = redacted ? EMPTY : fmt.value(change.before, pick(i18n.beforeLabel, display.beforeLabel), change);
  let after = redacted ? EMPTY : fmt.value(change.after, pick(i18n.afterLabel, display.afterLabel), change);
  // Two date-times that format the same: the same instant written with different offsets shows
  // its offsets; anything else (seconds, precision) is shown as written.
  if (change.code === 'FIELD_CHANGED' && !redacted && display.format === 'date-time' && before.text === after.text) {
    const b = String(change.before);
    const a = String(change.after);
    const ob = offsetOf(b);
    const oa = offsetOf(a);
    if (ob && oa && ob !== oa && Date.parse(b) === Date.parse(a)) {
      before = plain(`${before.text} (${ob})`);
      after = plain(`${after.text} (${oa})`);
    } else {
      before = fmt.asWritten(b);
      after = fmt.asWritten(a);
    }
  }
  const unicodeOnly =
    change.code === 'FIELD_CHANGED' && !redacted &&
    typeof change.before === 'string' && typeof change.after === 'string' &&
    change.before !== change.after && change.before.normalize('NFC') === change.after.normalize('NFC');
  const item: Formatted = isItem && !redacted
    ? objectItem
      ? { text: visible(change.item?.label ?? ''), quoted: true }
      : change.code === 'ITEM_ADDED' ? after : before
    : EMPTY;

  // Where a moved item came from and went to, named by as many trailing labels as tell them apart.
  let from = '';
  let to = '';
  if (isMove) {
    const fromItems = new Set(display.fromItemLabels ?? []);
    const fromLabels = display.fromParent ?? [];
    const fromPath = fromLabels.map((t, i) =>
      pick(i18n.fromParent?.[i], undefined) ??
      (fromItems.has(i) ? t : translate(t, fromItems.has(i + 1) || i === fromLabels.length - 1 ? 'list' : 'field')),
    );
    const toPath = labels.slice(0, listIndex + 1);
    let n = 1;
    const tail = (p: string[]) => p.slice(-n).join(' › ');
    while (n < Math.max(fromPath.length, toPath.length) && tail(fromPath) === tail(toPath)) n++;
    from = tail(fromPath);
    to = tail(toPath);
  }

  const values: Record<keyof TemplateValues, Formatted> = {
    field: plain(field),
    parents: plain(parents.join(' › ')),
    before,
    after,
    item,
    itemNoun: plain(isItem ? (pick(i18n.itemNoun, undefined) ?? translate(display.itemNoun ?? 'Item', 'itemNoun')) : ''),
    list: plain(isMove ? to : field),
    record: plain(isRecord ? (labels[0] ?? '') : ''),
    from: plain(from),
    to: plain(to),
  };

  const key = unicodeOnly ? 'FIELD_CHANGED:unicode' : messageKey(change, objectItem);
  const custom = options.messages?.[key] ?? (key !== change.code ? options.messages?.[change.code] : undefined);
  const template = custom ?? defaultMessages[key];

  let parts: SentencePart[];
  if (typeof template === 'function') {
    const flat = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.text])) as unknown as TemplateValues;
    parts = [{ type: 'text', text: template(change, flat) }];
  } else {
    // Parents go first unless the template places {parents} itself.
    const prefixed = !template.includes('{parents}') && parents.length > 0 && !isRecord
      ? `{parents}: ${template}`
      : template;
    parts = fill(prefixed, values);
  }
  return { text: parts.map((p) => p.text).join(''), parts, change };
}

function messageKey(change: Change, objectItem: boolean): MessageKey {
  const { code } = change;
  if (code === 'FIELD_SET' || code === 'FIELD_CLEARED' || code === 'FIELD_CHANGED') {
    if (change.redacted) return `${code}:redacted`;
    // An object or list reads as a whole, unless it has a label, such as an atomic option.
    const d = change.display ?? {};
    const sides: [unknown, string | undefined][] = [[change.before, d.beforeLabel], [change.after, d.afterLabel]];
    const whole = sides.some(([v, label]) => (Array.isArray(v) || isPlainObject(v)) && label === undefined);
    return whole ? `${code}:whole` : code;
  }
  if (code === 'ITEM_MOVED') return change.redacted ? 'ITEM_MOVED:redacted' : code;
  if (code === 'ITEM_ADDED' || code === 'ITEM_REMOVED') {
    if (change.redacted) return `${code}:redacted`;
    return objectItem ? code : `${code}:value`;
  }
  return code;
}

interface Formatted {
  text: string;
  quoted: boolean;
}

const EMPTY: Formatted = { text: '', quoted: false };
const plain = (text: string): Formatted => ({ text, quoted: false });

function fill(template: string, values: Record<string, Formatted>): SentencePart[] {
  const parts: SentencePart[] = [];
  const push = (type: SentencePart['type'], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.type === type && type === 'text') last.text += text;
    else parts.push({ type, text });
  };
  for (const piece of template.split(/(\{\w+\})/)) {
    const token = /^\{(\w+)\}$/.exec(piece)?.[1];
    const value = token !== undefined ? values[token] : undefined;
    if (!value) {
      push('text', piece);
      continue;
    }
    if (value.quoted) push('text', '"');
    push(FIELD_TOKENS.has(token!) ? 'field' : 'value', value.text);
    if (value.quoted) push('text', '"');
  }
  // Collapse spaces left by empty tokens: "{itemNoun} {item}" with no item.
  for (const p of parts) if (p.type === 'text') p.text = p.text.replace(/ {2,}/g, ' ');
  if (parts[0]?.type === 'text') parts[0].text = parts[0].text.trimStart();
  const last = parts[parts.length - 1];
  if (last?.type === 'text') last.text = last.text.trimEnd();
  return parts.filter((p) => p.text);
}

/** The offset a date-time is written with, as "+05:30"; "Z" reads as "+00:00". */
function offsetOf(v: string): string | undefined {
  const m = /(Z|[+-]\d{2}:?\d{2})$/i.exec(v);
  if (!m) return undefined;
  if (m[1]!.toUpperCase() === 'Z') return '+00:00';
  return m[1]!.length === 5 ? `${m[1]!.slice(0, 3)}:${m[1]!.slice(3)}` : m[1];
}

/**
 * Makes characters that print as nothing, or as an ordinary space, visible in a sentence:
 * newlines as ↵, tabs as ⇥, other control characters as their control pictures. Raw values
 * stay as they are in the change.
 */
function visible(text: string): string {
  return text.replace(/\r\n|[\u0000-\u001f\u007f-\u009f]/g, (c) => {
    if (c === '\r\n' || c === '\n' || c === '\r') return '↵';
    if (c === '\t') return '⇥';
    if (c === '\u007f') return '␡';
    return c < ' ' ? String.fromCharCode(0x2400 + c.charCodeAt(0)) : '\ufffd';
  });
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// An offset is required: without one, Date.parse would read the machine's time zone.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

class Formatter {
  readonly #max: number;
  readonly #language: string;
  readonly #fallbackLanguage: string;
  readonly #maxParents: number;
  readonly #number: Intl.NumberFormat;
  readonly #date: Intl.DateTimeFormat;
  readonly #dateTime: Intl.DateTimeFormat;
  readonly #graphemes: Intl.Segmenter | undefined;

  constructor(options: DescribeOptions) {
    const locale = options.locale ?? 'en';
    const timeZone = options.timeZone ?? 'UTC';
    this.#max = options.maxValueLength ?? 80;
    // Checked up front, so a bad option fails the same way whether or not a change needs it.
    const check = (name: string, value: unknown, valid: () => unknown) => {
      try {
        valid();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new DiffError('INVALID_OPTION', name, `${name} ${JSON.stringify(value)} is not valid: ${reason}`);
      }
    };
    check('locale', locale, () => Intl.getCanonicalLocales(locale));
    check('timeZone', timeZone, () => new Intl.DateTimeFormat('en', { timeZone }));
    check('maxValueLength', this.#max, () => {
      if (!Number.isInteger(this.#max) || this.#max < 1) throw new Error('it must be a whole number of 1 or more');
    });
    const tag = (value: unknown) => {
      if (typeof value !== 'string' || value === '') throw new Error('it must be a language tag such as "de"');
      Intl.getCanonicalLocales(value);
    };
    this.#language = options.language ?? (Intl.getCanonicalLocales(locale)[0] ?? 'en').split('-')[0]!;
    this.#fallbackLanguage = options.fallbackLanguage ?? 'en';
    check('language', this.#language, () => tag(this.#language));
    check('fallbackLanguage', this.#fallbackLanguage, () => tag(this.#fallbackLanguage));
    this.#maxParents = options.maxParents ?? 3;
    check('maxParents', this.#maxParents, () => {
      if (this.#maxParents !== Infinity && (!Number.isInteger(this.#maxParents) || this.#maxParents < 0)) {
        throw new Error('it must be a whole number of 0 or more, or Infinity');
      }
    });
    this.#number = new Intl.NumberFormat(locale, { maximumFractionDigits: 20 });
    // Date-only values are built at UTC midnight and shown in UTC, so no time zone can shift them.
    this.#date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    this.#dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone });
    this.#graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(locale, { granularity: 'grapheme' }) : undefined;
  }

  /** A language map's text in the reader's language. */
  pick(map: LangMap): string {
    return pickLang(map, this.#language, this.#fallbackLanguage);
  }

  /**
   * Keeps the labels from the `maxParents`-th enclosing item from the end, after "…". Paths with
   * no more items than that are left whole.
   */
  shorten(parents: string[], items: ReadonlySet<number>): string[] {
    const positions = parents.map((_, i) => i).filter((i) => items.has(i));
    if (positions.length <= this.#maxParents) return parents;
    const from = this.#maxParents === 0 ? parents.length : positions[positions.length - this.#maxParents]!;
    return ['…', ...parents.slice(from)];
  }

  value(v: unknown, label: string | undefined, change: Change): Formatted {
    if (label !== undefined) return plain(this.#cut(label));
    if (v === undefined || v === null) return EMPTY;
    const { type, format } = change.display ?? {};
    if (typeof v === 'boolean') return plain(v ? 'Yes' : 'No');
    if (typeof v === 'number') {
      if (type !== 'number' && type !== 'integer') return plain(String(v));
      // Past 2^53 Intl rounds to 17 significant digits; BigInt keeps the digits of the stored number.
      return plain(this.#number.format(Number.isInteger(v) && !Number.isSafeInteger(v) ? BigInt(v) : v));
    }
    if (typeof v === 'string') {
      if (format === 'date') {
        const m = DATE_ONLY.exec(v);
        const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
        if (m && new Date(ms).getUTCDate() === Number(m[3])) return plain(this.#date.format(ms));
      }
      if (format === 'date-time' && DATE_TIME.test(v)) {
        const ms = Date.parse(v);
        if (!Number.isNaN(ms)) return plain(this.#dateTime.format(ms));
      }
      return this.asWritten(v);
    }
    return plain(this.#cut(canonical(v)));
  }

  /** A text value as written: quoted, with invisible characters shown, cut at maxValueLength. */
  asWritten(v: string): Formatted {
    return { text: this.#cut(visible(v)), quoted: true };
  }

  /** Cuts at maxValueLength user-perceived characters, so no emoji, flag or letter is split. */
  #cut(text: string): string {
    if (text.length <= this.#max) return text;
    const chars = this.#graphemes ? Array.from(this.#graphemes.segment(text), (s) => s.segment) : [...text];
    return chars.length > this.#max ? `${chars.slice(0, this.#max).join('').trimEnd()}…` : text;
  }
}
