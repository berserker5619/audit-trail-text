import { describe } from '../describe.ts';
import type { DescribeOptions } from '../describe.ts';
import { DiffError } from '../errors.ts';
import type { AuditEntry, GapEntry } from './plugin.ts';
import type { Any } from './schema.ts';

/** Stream mode's gap sentences, with `{at}`, `{from}` and `{to}` tokens. */
export interface GapMessages {
  /** One change that could not be recorded. Default "A change at {at} could not be recorded". */
  one?: string;
  /** Every change in a time range. Default "Changes between {from} and {to} were not recorded". */
  range?: string;
}

export interface DescribeEntriesOptions extends DescribeOptions {
  gapMessages?: GapMessages;
}

export interface HistoryOptions extends DescribeEntriesOptions {
  /** Default 50. */
  limit?: number;
  /** The `_id` of the last entry already shown: the next page starts after it. */
  after?: unknown;
  /** A session to read in, such as the transaction's own. */
  session?: unknown;
}

/** An audit entry, or a stream-mode gap, with its sentences. */
export interface HistoryEntry extends AuditEntry {
  sentences: string[];
}

/** Implemented by models with the plugin: `Order.history(id)`. Cast a model to it in TypeScript. */
export interface AuditedModel {
  history(id: unknown, options?: HistoryOptions): Promise<HistoryEntry[]>;
}

/**
 * One document's entries, newest first, with sentences. Pages by entry `_id`, because many entries
 * can share one `at`: the next page starts after the entry named in `after`. Stream mode's gaps
 * for the whole collection are included when they fall inside the document's history.
 */
export async function history(model: Any, collectionName: string, id: unknown, options: HistoryOptions = {}): Promise<HistoryEntry[]> {
  const { limit = 50, after, session, ...describeOptions } = options;
  if (!Number.isInteger(limit) || limit < 1) throw new DiffError('INVALID_OPTION', 'limit', 'limit must be a whole number of 1 or more');
  const collection = await nativeCollection(model, collectionName);
  const name = model.baseModelName ?? model.modelName;
  const docId = castId(model, id);
  const readOptions = session ? { session } : {};
  const first = await collection.find({ model: name, docId }, readOptions).sort({ at: 1, _id: 1 }).limit(1).project({ at: 1 }).toArray();
  const mine: Record<string, unknown>[] = [{ docId }];
  if (first[0]) mine.push({ operation: 'gap', docId: { $exists: false }, to: { $gte: first[0].at } });
  const and: Record<string, unknown>[] = [{ model: name }, { $or: mine }];
  if (after !== undefined && after !== null) {
    const afterId = castObjectId(model, after);
    const last = await collection.findOne({ _id: afterId }, { ...readOptions, projection: { at: 1 } });
    if (last) and.push({ $or: [{ at: { $lt: last.at } }, { at: last.at, _id: { $lt: last._id } }] });
  }
  const entries: (AuditEntry | GapEntry)[] = await collection.find({ $and: and }, readOptions).sort({ at: -1, _id: -1 }).limit(limit).toArray();
  return describeEntries(entries, describeOptions);
}

/** Sentences for entries an app queried itself, such as everything one user changed today. */
export function describeEntries(entries: readonly (AuditEntry | GapEntry)[], options: DescribeEntriesOptions = {}): HistoryEntry[] {
  const { gapMessages, ...describeOptions } = options;
  let format: ((d: Date) => string) | undefined;
  return entries.map((entry) => {
    if (entry.operation === 'gap') {
      format ??= dateTimeFormat(describeOptions);
      return { ...entry, sentences: [gapSentence(entry as GapEntry, format, gapMessages)] };
    }
    return { ...entry, sentences: describe(entry.changes ?? [], describeOptions).map((s) => s.text) };
  }) as HistoryEntry[];
}

function dateTimeFormat(options: DescribeOptions): (d: Date) => string {
  const f = new Intl.DateTimeFormat(options.locale ?? 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: options.timeZone ?? 'UTC' });
  return (d) => f.format(d instanceof Date ? d : new Date(d as unknown as string));
}

function gapSentence(gap: GapEntry, format: (d: Date) => string, messages: GapMessages = {}): string {
  const one = gap.docId !== undefined && new Date(gap.from).getTime() === new Date(gap.to).getTime();
  const template = one ? (messages.one ?? 'A change at {at} could not be recorded') : (messages.range ?? 'Changes between {from} and {to} were not recorded');
  const values: Record<string, string> = { at: format(gap.at), from: format(gap.from), to: format(gap.to) };
  return template.replace(/\{(at|from|to)\}/g, (_, k: string) => values[k]!);
}

/** The driver's collection, once the connection is open. */
export async function nativeCollection(model: Any, name: string): Promise<Any> {
  const conn = model.db;
  if (conn.readyState !== 1 && typeof conn.asPromise === 'function') await conn.asPromise();
  return conn.db.collection(name);
}

function castId(model: Any, id: unknown): unknown {
  try {
    const path = model.schema?.path?.('_id');
    return path && typeof path.cast === 'function' ? path.cast(id) : id;
  } catch {
    return id;
  }
}

function castObjectId(model: Any, id: unknown): unknown {
  const ObjectId = model.base?.Types?.ObjectId;
  if (typeof id === 'string' && ObjectId && /^[0-9a-f]{24}$/i.test(id)) return new ObjectId(id);
  return id;
}
