import { diffRecords } from '../diff.ts';
import type { DescribeOptions } from '../describe.ts';
import type { Adapter, Change } from '../types.ts';
import { describeEntries, nativeCollection } from './history.ts';
import type { HistoryEntry } from './history.ts';
import { auditCollection, configOf, infoFor, modelFor, rootName } from './plugin.ts';
import type { AuditEntry, Operation } from './plugin.ts';
import type { Any, Shape } from './schema.ts';
import { toJson } from './values.ts';

type Json = Record<string, unknown>;

/** One entry of mongoose-audit's `auditlog` collection. */
export interface MongooseAuditLogEntry {
  _id?: unknown;
  ts: Date;
  /** "create", "update" or "delete". */
  operation: string;
  /** The collection the document is in. */
  location?: string;
  /**
   * The document as mongoose-audit saw it: after the change for "create" and "update" (it logs
   * in `pre('save')`, once the changes are applied), and as it was for "delete".
   */
  document: Json;
  user?: unknown;
  /** Set on bulk entries, which hold the operation rather than a document: they are skipped. */
  selector?: unknown;
}

/** Fields mongoose-audit adds to every document it audits: never recorded. */
const AUDIT_FIELDS = ['_createdAt', '_updatedAt', '_user', '__v'];

export interface SnapshotOptions extends DescribeOptions {
  /** The model name stored in each entry. Default "Record". */
  model?: string;
}

/**
 * Reads mongoose-audit's log for one document as the same entries `Model.history` returns,
 * newest first. Each "update" entry is diffed with the entry before it, and keeps its own `ts`
 * and `user`, because mongoose-audit stores the document after the change. A log that starts
 * with an "update" (the document existed before mongoose-audit) uses that first version as the
 * starting point, without an entry of its own.
 */
export function historyFromSnapshots(log: readonly MongooseAuditLogEntry[], adapter: Adapter, options: SnapshotOptions = {}): HistoryEntry[] {
  const { model = 'Record', ...describeOptions } = options;
  const entries = pairSnapshots(log, () => ({ adapter, shape: undefined }), model);
  return describeEntries(entries.reverse(), describeOptions);
}

/** Log entries in time order, paired into audit entries, oldest first. */
function pairSnapshots(
  log: readonly MongooseAuditLogEntry[],
  schemaFor: (document: Json) => { adapter: Adapter; shape: Shape | undefined } | null,
  model: string,
  onError?: (entry: MongooseAuditLogEntry, error: unknown) => void,
): AuditEntry[] {
  const ordered = log
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && entry.selector === undefined && entry.document && typeof entry.document === 'object')
    .sort((a, b) => time(a.entry.ts) - time(b.entry.ts) || a.index - b.index)
    .map(({ entry }) => entry);
  const out: AuditEntry[] = [];
  let previous: Json | null = null;
  for (const entry of ordered) {
    const schema = schemaFor(entry.document);
    if (!schema) continue;
    const doc = clean(toJson(entry.document, schema.shape));
    let operation: Operation;
    let changes: Change[];
    try {
      if (entry.operation === 'create') {
        operation = 'create';
        changes = diffRecords(null, doc, schema.adapter);
        previous = doc;
      } else if (entry.operation === 'update') {
        operation = 'update';
        if (previous === null) {
          previous = doc;
          continue;
        }
        changes = diffRecords(previous, doc, schema.adapter);
        previous = doc;
      } else if (entry.operation === 'delete') {
        operation = 'delete';
        changes = diffRecords(doc, null, schema.adapter);
        previous = null;
      } else {
        continue;
      }
    } catch (error) {
      onError?.(entry, error);
      continue;
    }
    if (changes.length === 0) continue;
    out.push({
      model,
      docId: entry.document['_id'],
      operation,
      at: new Date(time(entry.ts)),
      ...(entry.user !== undefined && entry.user !== null && { user: entry.user }),
      changes,
      ...(entry._id !== undefined && { importedFrom: entry._id }),
      v: 1,
    });
  }
  return out;
}

function time(ts: unknown): number {
  return ts instanceof Date ? ts.getTime() : new Date(ts as string).getTime();
}

function clean(doc: Json): Json {
  const out = { ...doc };
  for (const key of AUDIT_FIELDS) delete out[key];
  return out;
}

export interface ImportOptions {
  /** mongoose-audit's collection. Default "auditlog". */
  from?: string;
}

export interface ImportResult {
  /** Log entries read for this model. */
  read: number;
  /** Audit entries written. */
  imported: number;
  /** Audit entries already imported by an earlier run. */
  skipped: number;
  /** Log entries that couldn't be diffed, with the error. */
  failed: { logId: unknown; error: unknown }[];
}

/**
 * Converts a model's mongoose-audit log into normal audit entries, oldest first, each with
 * `importedFrom` set to its log entry's `_id`. Safe to run again: entries already imported are
 * skipped. The old collection is only read.
 */
export async function importMongooseAudit(model: Any, options: ImportOptions = {}): Promise<ImportResult> {
  const cfg = configOf(model);
  if (!cfg) throw new Error(`importMongooseAudit: ${model?.modelName ?? 'the model'} does not use the auditTrail plugin`);
  const source = await nativeCollection(model, options.from ?? 'auditlog');
  const target = auditCollection(model, cfg.collection);
  const location = model.collection?.collectionName ?? model.collection?.name;
  const result: ImportResult = { read: 0, imported: 0, skipped: 0, failed: [] };
  const name = rootName(model);
  const schemaFor = (document: Json) => {
    const info = infoFor(modelFor(model, document), cfg);
    return info ? { adapter: info.adapter, shape: info.shape } : null;
  };

  const flush = async (group: MongooseAuditLogEntry[]) => {
    if (group.length === 0) return;
    const entries = pairSnapshots(group, schemaFor, name, (entry, error) => result.failed.push({ logId: entry._id, error }));
    if (entries.length === 0) return;
    const done = await target.find({ importedFrom: { $in: entries.map((e) => e.importedFrom) } }, { projection: { importedFrom: 1 } }).toArray();
    const seen = new Set(done.map((d: Any) => String(d.importedFrom)));
    const fresh = entries.filter((e) => !seen.has(String(e.importedFrom)));
    result.skipped += entries.length - fresh.length;
    if (fresh.length > 0) {
      await target.insertMany(fresh, { ordered: true });
      result.imported += fresh.length;
    }
  };

  const cursor = source
    .find({ location, selector: { $exists: false } }, { allowDiskUse: true })
    .sort({ 'document._id': 1, ts: 1, _id: 1 });
  let group: MongooseAuditLogEntry[] = [];
  let groupId: string | undefined;
  for await (const entry of cursor as AsyncIterable<MongooseAuditLogEntry>) {
    result.read++;
    const id = String(entry.document?.['_id']);
    if (id !== groupId) {
      await flush(group);
      group = [];
      groupId = id;
    }
    group.push(entry);
  }
  await flush(group);
  return result;
}
