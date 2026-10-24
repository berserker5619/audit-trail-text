// Stream mode for the Mongoose plugin. In the app, the plugin only attaches who and why: a
// who-field on each write when `whoField` is set, and a context record for each committed
// transaction. The watcher (startAuditWatcher) records the changes from MongoDB's own images.
import { randomUUID } from 'node:crypto';
import { diffRecords } from '../diff.ts';
import { watch } from '../mongo/watcher.ts';
import type { AuditWatcher, Recorder, WatcherOptions } from '../mongo/watcher.ts';
import { resolveAudit } from './context.ts';
import type { AuditInfo } from './context.ts';
import { configOf, infoFor, modelFor, rootName } from './plugin.ts';
import type { Config } from './plugin.ts';
import type { Any } from './schema.ts';
import { toJson } from './values.ts';

const UPDATES = ['updateOne', 'updateMany', 'findOneAndUpdate'];
const REPLACES = ['replaceOne', 'findOneAndReplace'];
const DELETES = ['deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove'];

/** The who-field value for one write: a fresh writeId every time. */
function whoValue(who: AuditInfo): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  if (who.user !== undefined) value['user'] = who.user;
  if (who.reason !== undefined) value['reason'] = who.reason;
  if (who.skip) value['skip'] = true;
  value['writeId'] = randomUUID();
  return value;
}

/**
 * Adds the who-field to an update: a `$set`, a `$set` stage for a pipeline, or a top-level key.
 * The plugin owns the field: anything else the update does to it ($unset, $rename, a dotted
 * $set) is taken out first, so the app's write can't fail on a conflicting path.
 */
function withWho(update: Any, field: string, value: Record<string, unknown>): Any {
  if (Array.isArray(update)) return [...update, { $set: { [field]: { $literal: value } } }];
  if (!update || typeof update !== 'object') return { $set: { [field]: value } };
  const touches = (key: string) => key === field || key.startsWith(`${field}.`);
  const out: Any = {};
  let operators = false;
  for (const [key, part] of Object.entries(update)) {
    if (key.startsWith('$')) {
      operators = true;
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const kept = Object.fromEntries(Object.entries(part).filter(([path, target]) => !touches(path) && !(key === '$rename' && typeof target === 'string' && touches(target))));
        if (Object.keys(kept).length > 0) out[key] = kept;
      } else {
        out[key] = part;
      }
    } else if (!touches(key)) {
      out[key] = part;
    }
  }
  if (operators) return { ...out, $set: { ...(out.$set ?? {}), [field]: value } };
  return { ...out, [field]: value };
}

/** Registers stream mode's hooks on a schema. */
export function streamHooks(schema: Any, cfg: Config): void {
  const field = cfg.whoField;
  if (field) {
    // Kept by strict schemas, hidden from the app's reads and API responses.
    // With the schema's own type key: a schema with typeKey: '$type' would read `type` as a field.
    const typeKey: string = schema.options?.typeKey ?? 'type';
    if (!schema.path(field)) schema.add({ [field]: { [typeKey]: schema.constructor?.Types?.Mixed ?? Object, select: false } });
    const setOnDoc = function (this: Any) {
      if (this.$isSubdocument || this.$isSingleNested || this.$isDocumentArrayElement) return;
      this.set(field, whoValue(resolveAudit(this.$locals?.audit)));
    };
    // validate covers insertMany and bulkWrite inserts; save gives each save its own writeId.
    schema.pre('validate', setOnDoc);
    schema.pre('save', setOnDoc);
    schema.pre([...UPDATES, ...REPLACES], { document: false, query: true }, function (this: Any) {
      const who = resolveAudit(this.getOptions?.().audit);
      const value = whoValue(who);
      const update = this.getUpdate();
      if (REPLACES.includes(this.op)) this.setUpdate({ ...(update ?? {}), [field]: value });
      else this.setUpdate(withWho(update, field, value));
    });
  }

  // Transaction context, for every write: the first audited write's who, recorded at commit.
  const note = (session: Any, who: AuditInfo, model: Any) => noteTransaction(session, who, model, cfg);
  schema.pre(['validate', 'save'], function (this: Any) {
    if (this.$isSubdocument || this.$isSingleNested || this.$isDocumentArrayElement) return;
    note(this.$session?.(), resolveAudit(this.$locals?.audit), this.constructor);
  });
  schema.pre('deleteOne', { document: true, query: false }, function (this: Any) {
    note(this.$session?.(), resolveAudit(this.$locals?.audit), this.constructor);
  });
  schema.pre([...UPDATES, ...REPLACES, ...DELETES], { document: false, query: true }, function (this: Any) {
    const options = this.getOptions?.() ?? {};
    note(options.session, resolveAudit(options.audit), this.model);
  });
  // bulkWrite middleware exists from Mongoose 8; 8 passes next first, 9 doesn't.
  try {
    schema.pre('bulkWrite', function (this: Any, a: Any, b: Any, c: Any) {
      const v8 = typeof a === 'function';
      const ops: Any[] = (v8 ? b : a) ?? [];
      const options: Any = (v8 ? c : b) ?? {};
      try {
        const who = resolveAudit(options.audit);
        if (field) {
          for (const op of ops) {
            const value = whoValue(who);
            if (op.insertOne?.document) op.insertOne.document[field] = value;
            else if (op.updateOne) op.updateOne.update = withWho(op.updateOne.update, field, value);
            else if (op.updateMany) op.updateMany.update = withWho(op.updateMany.update, field, value);
            else if (op.replaceOne?.replacement) op.replaceOne.replacement = { ...op.replaceOne.replacement, [field]: value };
          }
        }
        note(options.session, who, this);
      } finally {
        if (v8) a();
      }
    });
  } catch {
    // Mongoose 7: no bulkWrite middleware; bulkWrite through Mongoose has no who.
  }
}

const pending = new WeakMap<object, { who: AuditInfo; model: Any }>();
const wrapped = new WeakSet<object>();

/**
 * Remembers who made a transaction's first audited write, and records it once the transaction
 * commits: outside the transaction and not awaited, so it can never abort or slow it.
 */
function noteTransaction(session: Any, who: AuditInfo, model: Any, cfg: Config): void {
  try {
    if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) return;
    if (!wrapped.has(session)) {
      wrapped.add(session);
      const start = session.startTransaction;
      const commit = session.commitTransaction;
      const abort = session.abortTransaction;
      session.startTransaction = function (this: Any, ...args: unknown[]) {
        pending.delete(this);
        return start.apply(this, args);
      };
      session.commitTransaction = async function (this: Any, ...args: unknown[]) {
        const noted = pending.get(this);
        // Final once the transaction has run a command: the number its events carry.
        const txnNumber = Number(this.serverSession?.txnNumber);
        const lsid = this.id?.id;
        const result = await commit.apply(this, args);
        pending.delete(this);
        if (noted && lsid && Number.isFinite(txnNumber)) {
          const record: Record<string, unknown> = { lsid, txnNumber, createdAt: new Date() };
          if (noted.who.user !== undefined) record['user'] = noted.who.user;
          if (noted.who.reason !== undefined) record['reason'] = noted.who.reason;
          if (noted.who.skip) record['skip'] = true;
          Promise.resolve()
            .then(() => noted.model.db.collection(cfg.contextCollection).insertOne(record))
            .catch((error: unknown) => {
              try {
                cfg.logger.warn(`audit-trail-text: a transaction's context record was not written, so its changes have no user: ${error instanceof Error ? error.message : String(error)}`);
              } catch {
                // nothing more to do
              }
            });
        }
        return result;
      };
      session.abortTransaction = async function (this: Any, ...args: unknown[]) {
        pending.delete(this);
        return abort.apply(this, args);
      };
    }
    if (!pending.has(session)) pending.set(session, { who, model });
  } catch {
    // Context is best effort: without it, the transaction's changes have no user.
  }
}

/**
 * Starts the watcher for Mongoose models in stream mode. Models in hooks mode are refused, with a
 * warning: watching them too would record every write twice.
 */
export async function startAuditWatcher(options: WatcherOptions & { connection: Any; models: Any[] }): Promise<AuditWatcher> {
  const { connection, models, ...watcherOptions } = options;
  const recorders = new Map<string, Recorder>();
  let first: Config | undefined;
  for (const m of models) {
    const cfg = configOf(m);
    const logger = watcherOptions.logger ?? cfg?.logger ?? console;
    if (!cfg) {
      logger.warn(`audit-trail-text: ${m?.modelName}: not watched; its schema doesn't use the auditTrail plugin`);
      continue;
    }
    if (cfg.mode !== 'stream') {
      logger.warn(`audit-trail-text: ${m.modelName}: not watched; it is in hooks mode, so watching it too would record every write twice. Set mode: 'stream' first`);
      continue;
    }
    first ??= cfg;
    const root = m.baseModelName ? (m.db.models[m.baseModelName] ?? m) : m;
    const collection: string = root.collection.collectionName;
    if (recorders.has(collection)) continue;
    const modelOf = (doc: Any) => (doc ? modelFor(root, doc) : root);
    recorders.set(collection, {
      collection,
      ...(cfg.whoField && { whoField: cfg.whoField }),
      ...(cfg.snapshots && { snapshots: true }),
      modelOf: (doc) => rootName(modelOf(doc)),
      toJson: (raw) => toJson(raw, infoFor(modelOf(raw), cfg)?.shape),
      changes: (before, after, ctx) => {
        if (cfg.diff) return cfg.diff(before, after, { model: ctx.model, operation: ctx.operation });
        const info = infoFor(modelOf(ctx.doc), cfg);
        if (!info) throw new Error(`${ctx.model}: its schema could not be read`);
        return diffRecords(before, after, info.adapter);
      },
    });
  }
  if (recorders.size === 0) throw new Error('startAuditWatcher: no model in stream mode to watch');
  const db = connection.db ?? (await connection.asPromise?.(), connection.db);
  return watch(db, [...recorders.values()], {
    auditCollection: first!.collection,
    contextCollection: first!.contextCollection,
    logger: first!.logger,
    ...watcherOptions,
  });
}
