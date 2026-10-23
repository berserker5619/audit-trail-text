import { describe } from '../describe.ts';
import type { DescribeOptions } from '../describe.ts';
import { DiffError } from '../errors.ts';
import type { AuditEntry } from './plugin.ts';
import type { Any } from './schema.ts';

export interface HistoryOptions extends DescribeOptions {
  /** Default 50. */
  limit?: number;
  /** The `_id` of the last entry already shown: the next page starts after it. */
  after?: unknown;
  /** A session to read in, such as the transaction's own. */
  session?: unknown;
}

/** An audit entry with its sentences. */
export interface HistoryEntry extends AuditEntry {
  sentences: string[];
}

/** Implemented by models with the plugin: `Order.history(id)`. Cast a model to it in TypeScript. */
export interface AuditedModel {
  history(id: unknown, options?: HistoryOptions): Promise<HistoryEntry[]>;
}

/**
 * One document's entries, newest first, with sentences. Pages by entry `_id`, because many entries
 * can share one `at`: the next page starts after the entry named in `after`.
 */
export async function history(model: Any, collectionName: string, id: unknown, options: HistoryOptions = {}): Promise<HistoryEntry[]> {
  const { limit = 50, after, session, ...describeOptions } = options;
  if (!Number.isInteger(limit) || limit < 1) throw new DiffError('INVALID_OPTION', 'limit', 'limit must be a whole number of 1 or more');
  const collection = await nativeCollection(model, collectionName);
  const filter: Record<string, unknown> = { model: model.baseModelName ?? model.modelName, docId: castId(model, id) };
  const readOptions = session ? { session } : {};
  if (after !== undefined && after !== null) {
    const afterId = castObjectId(model, after);
    const last = await collection.findOne({ _id: afterId }, { ...readOptions, projection: { at: 1 } });
    if (last) filter['$or'] = [{ at: { $lt: last.at } }, { at: last.at, _id: { $lt: last._id } }];
  }
  const entries: AuditEntry[] = await collection.find(filter, readOptions).sort({ at: -1, _id: -1 }).limit(limit).toArray();
  return describeEntries(entries, describeOptions);
}

/** Sentences for entries an app queried itself, such as everything one user changed today. */
export function describeEntries(entries: readonly AuditEntry[], options: DescribeOptions = {}): HistoryEntry[] {
  return entries.map((entry) => ({ ...entry, sentences: describe(entry.changes ?? [], options).map((s) => s.text) }));
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
