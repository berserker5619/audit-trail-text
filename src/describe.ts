import { diffRecords } from './diff.ts';
import type { Adapter, Change, DiffOptions } from './types.ts';
import { canonical, isPlainObject } from './util.ts';

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
  | 'ITEM_ADDED:value'
  | 'ITEM_REMOVED:value'
  | 'ITEM_ADDED:redacted'
  | 'ITEM_REMOVED:redacted';

export interface DescribeOptions {
  /** Default "en". Never guessed from the machine. */
  locale?: string;
  /** Default "UTC". Never guessed from the machine. */
  timeZone?: string;
  /** Default 80. Longer values are cut with "…"; raw values stay whole in the change. */
  maxValueLength?: number;
  messages?: Partial<Record<MessageKey, Template>>;
  /** Translates the app's own words. Item names, such as a product called "Rose", never go through it. */
  translateLabel?: (label: string, context: LabelContext) => string;
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
  ITEM_ADDED: '{itemNoun} {item} added to {list}',
  ITEM_REMOVED: '{itemNoun} {item} removed from {list}',
  'ITEM_ADDED:value': '{item} added to {list}',
  'ITEM_REMOVED:value': '{item} removed from {list}',
  'ITEM_ADDED:redacted': '{itemNoun} added to {list}',
  'ITEM_REMOVED:redacted': '{itemNoun} removed from {list}',
  LIST_REORDERED: '{list} reordered',
  RECORD_CREATED: '{record} created',
  RECORD_DELETED: '{record} deleted',
  TRUNCATED: 'More changes not shown',
};

const FIELD_TOKENS = new Set(['field', 'parents', 'itemNoun', 'list', 'record']);

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
  const items = new Set(display.itemLabels ?? []);
  const isItem = change.code === 'ITEM_ADDED' || change.code === 'ITEM_REMOVED';
  const isRecord = change.code === 'RECORD_CREATED' || change.code === 'RECORD_DELETED';
  const objectItem = isItem && display.type === 'object';
  // An item change's labels end with the item's name, except for plain values and sensitive lists.
  const last = change.labels.length - 1;
  const listIndex = isItem && items.has(last) ? last - 1 : last;
  const kindAt = (i: number): LabelContext['kind'] =>
    isRecord ? 'record' : items.has(i + 1) || (i === listIndex && (isItem || change.code === 'LIST_REORDERED')) ? 'list' : 'field';
  const labels = change.labels.map((label, i) => (items.has(i) ? label : translate(label, kindAt(i))));
  const field = labels[listIndex] ?? '';
  const parents = labels.slice(0, Math.max(listIndex, 0));

  const redacted = change.redacted === true;
  const before = redacted ? EMPTY : fmt.value(change.before, display.beforeLabel, change);
  const after = redacted ? EMPTY : fmt.value(change.after, display.afterLabel, change);
  const item: Formatted = isItem && !redacted
    ? objectItem
      ? { text: change.item?.label ?? '', quoted: true }
      : change.code === 'ITEM_ADDED' ? after : before
    : EMPTY;

  const values: Record<keyof TemplateValues, Formatted> = {
    field: plain(field),
    parents: plain(parents.join(' › ')),
    before,
    after,
    item,
    itemNoun: plain(isItem ? translate(display.itemNoun ?? 'Item', 'itemNoun') : ''),
    list: plain(field),
    record: plain(isRecord ? (labels[0] ?? '') : ''),
  };

  const key = messageKey(change, objectItem);
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
    const whole = [change.before, change.after].some((v) => Array.isArray(v) || isPlainObject(v));
    return whole ? `${code}:whole` : code;
  }
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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// An offset is required: without one, Date.parse would read the machine's time zone.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

class Formatter {
  readonly #max: number;
  readonly #number: Intl.NumberFormat;
  readonly #date: Intl.DateTimeFormat;
  readonly #dateTime: Intl.DateTimeFormat;

  constructor(options: DescribeOptions) {
    const locale = options.locale ?? 'en';
    const timeZone = options.timeZone ?? 'UTC';
    this.#max = options.maxValueLength ?? 80;
    this.#number = new Intl.NumberFormat(locale, { maximumFractionDigits: 20 });
    // Date-only values are built at UTC midnight and shown in UTC, so no time zone can shift them.
    this.#date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    this.#dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone });
  }

  value(v: unknown, label: string | undefined, change: Change): Formatted {
    if (label !== undefined) return plain(this.#cut(label));
    if (v === undefined || v === null) return EMPTY;
    const { type, format } = change.display ?? {};
    if (typeof v === 'boolean') return plain(v ? 'Yes' : 'No');
    if (typeof v === 'number') {
      return plain(type === 'number' || type === 'integer' ? this.#number.format(v) : String(v));
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
      return { text: this.#cut(v), quoted: true };
    }
    return plain(this.#cut(canonical(v)));
  }

  #cut(text: string): string {
    const chars = [...text];
    return chars.length > this.#max ? `${chars.slice(0, this.#max).join('').trimEnd()}…` : text;
  }
}
