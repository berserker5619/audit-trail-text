import { diffRecords } from '../diff.ts';
import { DiffError } from '../errors.ts';
import type { Change, LangMap } from '../types.ts';
import { resolveAudit } from './context.ts';
import type { AuditInfo } from './context.ts';
import { history } from './history.ts';
import type { HistoryOptions } from './history.ts';
import { modelTitle, schemaInfo } from './schema.ts';
import type { Any, SchemaInfo } from './schema.ts';
import { restoreShared, sharedValues, toJson } from './values.ts';

type Json = Record<string, unknown>;
export type Operation = 'create' | 'update' | 'delete';

/** One entry in the audit collection: what changed in one document in one write. */
export interface AuditEntry {
  _id?: unknown;
  /** The model's name; for a discriminator, its base model's name. */
  model: string;
  /** The document's `_id`. */
  docId: unknown;
  operation: Operation;
  at: Date;
  user?: unknown;
  reason?: string;
  /** audit-trail-text changes: stand-alone, JSON-safe, describable without the schema. */
  changes: Change[];
  /** The document before an update, with sensitive and ignored fields stripped. Only with `snapshots: true`. */
  snapshot?: Json;
  /** The mongoose-audit `auditlog` entry this was imported from. */
  importedFrom?: unknown;
  v: 1;
}

/** Where the plugin's work failed. The app's own write is never affected. */
export type AuditStage = 'schema' | 'before' | 'diff' | 'after' | 'write' | 'maxMany';

/** Emitted on the model as `auditError`. */
export interface AuditErrorEvent {
  model: string;
  docId?: unknown;
  operation?: Operation;
  stage: AuditStage;
  error: unknown;
  /** The entry that wasn't written, for `stage: "write"`, so the app can retry or store it elsewhere. */
  entry?: AuditEntry;
}

export interface AuditTrailOptions {
  /** The labels file, with the same keys as the core: `{ "/items#label": "{product}" }`. */
  labels?: Readonly<Record<string, string | LangMap>>;
  /** Refuse labels file entries that match no field. Default false. */
  strictLabels?: boolean;
  /** The audit collection, shared by every model on a connection. Default "audit_trail". */
  collection?: string;
  /** Record `updateMany` and `deleteMany`. Default false. */
  many?: boolean;
  /** With `many`, the most documents one write may match and still be recorded. Default 1,000. */
  maxMany?: number;
  /** Also store the document before each update, stripped of sensitive and ignored fields. Default false. */
  snapshots?: boolean;
  /** Keep the raw document Mongoose loaded, for the before value on `save()`. Default true. */
  captureOnLoad?: boolean;
  /** Write audit entries after the app's call returns. Default false. */
  background?: boolean;
  /** The most time the plugin may add to one write, across its reads and the audit write. Default 2,000 ms. */
  auditTimeoutMS?: number;
  /** Where warnings go when nothing listens to `auditError`. Default `console`. */
  logger?: { warn(message: string): void };
  /** The name of the history static. Default "history". */
  historyMethod?: string;
}

export interface Config {
  labels: AuditTrailOptions['labels'];
  strictLabels: boolean;
  collection: string;
  many: boolean;
  maxMany: number;
  snapshots: boolean;
  captureOnLoad: boolean;
  background: boolean;
  timeout: number;
  logger: { warn(message: string): void };
  historyMethod: string;
}

const SINGLE = ['findOneAndUpdate', 'findOneAndReplace', 'updateOne', 'replaceOne', 'findOneAndDelete', 'deleteOne', 'findOneAndRemove'];
const MANY = ['updateMany', 'deleteMany'];
const DELETES = new Set(['findOneAndDelete', 'deleteOne', 'findOneAndRemove', 'deleteMany']);
const APPLIED = Symbol.for('audit-trail-text.mongoose');
const CONFIG = Symbol.for('audit-trail-text.mongoose.config');

/**
 * The Mongoose plugin: records every create, update and delete made through Mongoose as
 * audit-trail-text changes, and adds a `history` static. Auditing never blocks, fails or
 * noticeably slows the app's own writes.
 */
export function auditTrail(schema: Any, options: AuditTrailOptions = {}): void {
  if (schema[APPLIED]) return;
  Object.defineProperty(schema, APPLIED, { value: true });
  const cfg = config(options);
  Object.defineProperty(schema, CONFIG, { value: cfg });

  // Startup: the schema is read once, when the model is compiled, so problems show at once.
  schema.on?.('init', (model: Any) => {
    try {
      infoFor(model, cfg);
    } catch {
      // reported inside
    }
  });

  if (schema.statics?.[cfg.historyMethod] !== undefined) {
    cfg.logger.warn(`audit-trail-text: the schema already has a static called "${cfg.historyMethod}"; pass historyMethod to name the history method`);
  } else {
    schema.static(cfg.historyMethod, function (this: Any, id: unknown, opts?: HistoryOptions) {
      return history(this, cfg.collection, id, opts);
    });
  }

  schema.pre('init', function (this: Any, raw: Any) {
    try {
      captureOnInit(this, raw, cfg);
    } catch {
      // A failed capture only means the before value is read from the database on save.
    }
  });
  schema.pre('save', async function (this: Any) {
    await guard(cfg, () => beforeSave(this, cfg));
  });
  schema.post('save', async function (this: Any) {
    await guard(cfg, () => afterSave(this, cfg));
  });
  schema.post('insertMany', async function (this: Any, docs: Any) {
    await guard(cfg, () => inserted(this, docs, cfg));
  });
  // Error middleware: with `ordered: false`, the documents that were inserted before the error.
  schema.post('insertMany', function (this: Any, error: Any, _docs: Any, next: (e?: unknown) => void) {
    const docs = error?.insertedDocs;
    guard(cfg, () => (Array.isArray(docs) && docs.length > 0 ? inserted(this, docs, cfg) : Promise.resolve())).then(() => next(error));
  });
  schema.pre('deleteOne', { document: true, query: false }, async function (this: Any) {
    await guard(cfg, () => beforeDocDelete(this, cfg));
  });
  schema.post('deleteOne', { document: true, query: false }, async function (this: Any) {
    await guard(cfg, () => afterDocDelete(this, cfg));
  });
  schema.pre([...SINGLE, ...MANY], { document: false, query: true }, async function (this: Any) {
    await guard(cfg, () => beforeQuery(this, cfg));
  });
  schema.post([...SINGLE, ...MANY], { document: false, query: true }, async function (this: Any, res: Any) {
    await guard(cfg, () => afterQuery(this, res, cfg));
  });
}

function config(o: AuditTrailOptions): Config {
  const count = (v: number | undefined, fallback: number, name: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !(v >= 0) || !Number.isFinite(v)) throw new DiffError('INVALID_OPTION', name, `${name} must be a number of 0 or more`);
    return v;
  };
  return {
    labels: o.labels,
    strictLabels: o.strictLabels === true,
    collection: o.collection ?? 'audit_trail',
    many: o.many === true,
    maxMany: count(o.maxMany, 1000, 'maxMany'),
    snapshots: o.snapshots === true,
    captureOnLoad: o.captureOnLoad !== false,
    background: o.background === true,
    timeout: count(o.auditTimeoutMS, 2000, 'auditTimeoutMS'),
    logger: o.logger ?? console,
    historyMethod: o.historyMethod ?? 'history',
  };
}

/**
 * Plugin code never throws into the app. Expected failures are reported where they happen; anything
 * else reaching here is a bug in the plugin, logged so it isn't lost.
 */
async function guard(cfg: Config, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (error) {
    try {
      cfg.logger.warn(`audit-trail-text: unexpected error, nothing recorded for this write: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    } catch {
      // nothing more to do
    }
  }
}

// ---------------------------------------------------------------- models and schemas

const infos = new WeakMap<object, SchemaInfo | null>();

/** The schema info for a model, built once. Null when the schema can't be read: that model isn't audited. */
export function infoFor(model: Any, cfg: Config): SchemaInfo | null {
  const known = infos.get(model);
  if (known !== undefined) return known;
  let info: SchemaInfo | null = null;
  try {
    info = schemaInfo(model.schema, {
      ...(cfg.labels && { labels: cfg.labels }),
      strictLabels: cfg.strictLabels,
      title: modelTitle(model.modelName),
    });
    for (const list of info.wholeLists) {
      cfg.logger.warn(`audit-trail-text: ${model.modelName}: ${list.path} is recorded as one whole value: ${list.error.message}`);
    }
  } catch (error) {
    report(model, cfg, { model: rootName(model), stage: 'schema', error });
  }
  infos.set(model, info);
  return info;
}

/** The plugin's options for a model, or undefined when its schema doesn't use the plugin. */
export function configOf(model: Any): Config | undefined {
  return rootModel(model).schema?.[CONFIG] ?? model.schema?.[CONFIG];
}

function rootModel(model: Any): Any {
  return model.baseModelName ? (model.db?.models?.[model.baseModelName] ?? model) : model;
}

export function rootName(model: Any): string {
  return model.baseModelName ?? model.modelName;
}

/** The model a raw document belongs to: its discriminator's, when it has one. */
export function modelFor(model: Any, raw: Any): Any {
  const root = rootModel(model);
  const key = root.schema?.options?.discriminatorKey ?? '__t';
  const value = raw?.[key];
  if (value == null || !root.discriminators) return model;
  for (const m of Object.values(root.discriminators) as Any[]) {
    if ((m.schema?.discriminatorMapping?.value ?? m.modelName) === value) return m;
  }
  return model;
}

function majorVersion(model: Any): number {
  return Number(String(model.base?.version ?? '8').split('.')[0]);
}

function isSubdocument(doc: Any): boolean {
  return doc?.$isSubdocument === true || doc?.$isSingleNested === true || doc?.$isDocumentArrayElement === true;
}

// ---------------------------------------------------------------- budget and reporting

class AuditTimeoutError extends Error {
  constructor(ms: number) {
    super(`audit work took longer than auditTimeoutMS (${ms} ms)`);
    this.name = 'AuditTimeoutError';
  }
}

/** The time the plugin may still spend on one write. */
class Budget {
  readonly #end: number;
  readonly #ms: number;
  constructor(ms: number) {
    this.#ms = ms;
    this.#end = Date.now() + ms;
  }
  run<T>(p: Promise<T>): Promise<T> {
    p.catch(() => {});
    const left = this.#end - Date.now();
    if (left <= 0) return Promise.reject(new AuditTimeoutError(this.#ms));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AuditTimeoutError(this.#ms)), left);
      timer.unref?.();
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}

const logged = new Map<string, { at: number; held: number }>();

/** Emits `auditError` on the model; without a listener, logs at most one line per model per minute. */
function report(model: Any, cfg: Config, event: AuditErrorEvent): void {
  const root = rootModel(model);
  try {
    if (typeof root.listenerCount === 'function' && root.listenerCount('auditError') > 0) {
      root.emit('auditError', event);
      return;
    }
  } catch {
    // a throwing listener never reaches the app's write
  }
  const now = Date.now();
  const last = logged.get(event.model);
  if (last && now - last.at < 60_000) {
    last.held++;
    return;
  }
  const held = last?.held ? ` (${last.held} more since the last warning)` : '';
  logged.set(event.model, { at: now, held: 0 });
  const reason = event.error instanceof Error ? event.error.message : String(event.error);
  try {
    cfg.logger.warn(`audit-trail-text: ${event.model}: ${event.stage} failed: ${reason}${held}`);
  } catch {
    // nothing more to do
  }
}

const warnedMany = new Set<string>();

// ---------------------------------------------------------------- entries

const inFlight = new Set<Promise<unknown>>();

function track(p: Promise<unknown>): void {
  inFlight.add(p);
  p.finally(() => inFlight.delete(p)).catch(() => {});
}

/** Waits for audit work still running in the background, for tests and shutdown. */
export async function auditFlush(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

interface Job {
  model: Any;
  info: SchemaInfo;
  operation: Operation;
  docId: unknown;
  before: Json | null;
  after: Json | null;
  who: AuditInfo;
}

/** Diffs one document's versions into an entry. Undefined when nothing recordable changed. */
function entryFor(job: Job, cfg: Config): AuditEntry | undefined {
  let changes: Change[];
  try {
    changes = diffRecords(job.before, job.after, job.info.adapter);
  } catch (error) {
    report(job.model, cfg, { model: rootName(job.model), docId: job.docId, operation: job.operation, stage: 'diff', error });
    return undefined;
  }
  if (changes.length === 0) return undefined;
  const entry: AuditEntry = { model: rootName(job.model), docId: job.docId, operation: job.operation, at: new Date(), changes, v: 1 };
  if (job.who.user !== undefined) entry.user = job.who.user;
  if (job.who.reason !== undefined) entry.reason = job.who.reason;
  if (cfg.snapshots && job.operation === 'update' && job.before) {
    const stripped = diffRecords(job.before, null, job.info.adapter)[0]?.before;
    if (stripped && typeof stripped === 'object') entry.snapshot = stripped as Json;
  }
  // Fixed key order, so stored entries look alike.
  const { v, ...rest } = entry;
  return { ...rest, v };
}

/** Writes an entry now, or holds it until the transaction it belongs to commits. */
async function deliver(job: Job, entry: AuditEntry, session: Any, budget: Budget, cfg: Config): Promise<void> {
  if (inTransaction(session)) {
    hold(session, () => write(job.model, entry, new Budget(cfg.timeout), cfg));
    return;
  }
  await write(job.model, entry, budget, cfg);
}

async function write(model: Any, entry: AuditEntry, budget: Budget, cfg: Config): Promise<void> {
  try {
    const collection = auditCollection(model, cfg.collection);
    await budget.run(Promise.resolve(collection.insertOne(entry)));
  } catch (error) {
    report(model, cfg, { model: entry.model, docId: entry.docId, operation: entry.operation, stage: 'write', error, entry });
  }
}

const indexed = new WeakMap<object, Set<string>>();

/** The audit collection on the model's connection, with its indexes created once, following `autoIndex`. */
export function auditCollection(model: Any, name: string): Any {
  const conn = model.db;
  const collection = conn.collection(name);
  let done = indexed.get(conn);
  if (!done) indexed.set(conn, (done = new Set()));
  if (!done.has(name)) {
    done.add(name);
    const auto = conn.config?.autoIndex ?? conn.base?.get?.('autoIndex') ?? true;
    if (auto !== false) {
      const ignore = () => {};
      Promise.resolve()
        .then(() => collection.createIndex({ model: 1, docId: 1, at: -1, _id: -1 }))
        .then(() => collection.createIndex({ importedFrom: 1 }, { sparse: true }))
        .catch(ignore);
    }
  }
  return collection;
}

// ---------------------------------------------------------------- transactions

const held = new WeakMap<object, (() => Promise<void>)[]>();
const wrapped = new WeakSet<object>();

function inTransaction(session: Any): boolean {
  try {
    return session != null && typeof session.inTransaction === 'function' && session.inTransaction() === true;
  } catch {
    return false;
  }
}

/**
 * Holds an entry on its session. Neither Mongoose nor the driver has a commit hook, so the
 * session's own methods are wrapped, once: entries are written after `commitTransaction()`
 * succeeds and dropped on abort, and each `startTransaction()` starts a fresh list, so a retried
 * `withTransaction()` callback never adds the failed attempt's entries.
 */
function hold(session: Any, job: () => Promise<void>): void {
  if (!wrapped.has(session)) {
    wrapped.add(session);
    held.set(session, []);
    const start = session.startTransaction;
    const commit = session.commitTransaction;
    const abort = session.abortTransaction;
    session.startTransaction = function (this: Any, ...args: unknown[]) {
      held.set(this, []);
      return start.apply(this, args);
    };
    session.commitTransaction = async function (this: Any, ...args: unknown[]) {
      const result = await commit.apply(this, args);
      const jobs = held.get(this) ?? [];
      held.set(this, []);
      const writes = Promise.allSettled(jobs.map((j) => j()));
      track(writes);
      await writes;
      return result;
    };
    session.abortTransaction = async function (this: Any, ...args: unknown[]) {
      held.set(this, []);
      return abort.apply(this, args);
    };
  }
  held.get(session)!.push(job);
}

// ---------------------------------------------------------------- reads

function plusPaths(info: SchemaInfo): string | undefined {
  return info.selectFalse.length > 0 ? info.selectFalse.map((p) => `+${p}`).join(' ') : undefined;
}

/** One raw document, with `select: false` paths included so a change to them can be seen. */
function readOne(model: Any, info: SchemaInfo, filter: Json, session: Any, extra: { sort?: unknown; collation?: unknown } = {}): Promise<Any> {
  let q = model.findOne(filter);
  if (extra.sort) q = q.sort(extra.sort);
  if (extra.collation) q = q.collation(extra.collation);
  if (session) q = q.session(session);
  const plus = plusPaths(info);
  if (plus) q = q.select(plus);
  return q.lean().exec();
}

function readMany(model: Any, info: SchemaInfo, filter: Json, session: Any, limit: number, collation?: unknown): Promise<Any[]> {
  let q = model.find(filter);
  if (collation) q = q.collation(collation);
  if (session) q = q.session(session);
  const plus = plusPaths(info);
  if (plus) q = q.select(plus);
  return q.limit(limit).lean().exec();
}

function json(model: Any, raw: Any, cfg: Config): { info: SchemaInfo | null; model: Any; value: Json | null } {
  if (raw == null) return { info: null, model, value: null };
  const m = modelFor(model, raw);
  const info = infoFor(m, cfg);
  return { info, model: m, value: toJson(raw, info?.shape) };
}

// ---------------------------------------------------------------- save

interface Captured {
  raw?: Any;
  shared?: [string[], unknown][];
  /** The record as converted after the last save. */
  converted?: Json;
}

const captured = new WeakMap<object, Captured>();
let hydrating = 0;

/** Keeps a reference to the raw object Mongoose loaded, and copies of the values Mongoose shares with it. */
function captureOnInit(doc: Any, raw: Any, cfg: Config): void {
  if (!cfg.captureOnLoad || hydrating > 0 || isSubdocument(doc) || raw == null) return;
  const info = infoFor(doc.constructor, cfg);
  if (!info) return;
  captured.set(doc, { raw, shared: sharedValues(raw, info.shape) });
}

interface SaveState {
  who: AuditInfo;
  budget: Budget;
  session: Any;
  isNew: boolean;
  before?: Json | null;
  failed?: boolean;
}

const saves = new WeakMap<object, SaveState>();

async function beforeSave(doc: Any, cfg: Config): Promise<void> {
  if (isSubdocument(doc)) return;
  const model = doc.constructor;
  const info = infoFor(model, cfg);
  if (!info) return;
  const who = resolveAudit(doc.$locals?.audit);
  if (who.skip) return;
  const session = doc.$session?.() ?? undefined;
  const state: SaveState = { who, budget: new Budget(cfg.timeout), session, isNew: doc.isNew === true };
  saves.set(doc, state);
  if (state.isNew) return;
  try {
    const cap = captured.get(doc);
    let before: Json | null;
    if (cap?.converted) before = cap.converted;
    else if (cap?.raw) before = beforeFromRaw(model, info, cap, doc);
    else before = json(model, await state.budget.run(readOne(model, info, { _id: doc._id }, session)), cfg).value;
    // A `select: false` path changed on a document loaded without it: read just that path.
    if (before) {
      const missing = info.selectFalse.filter((p) => !p.includes('$*') && doc.isModified?.(p) && getPath(before!, p) === undefined && isPlainPath(info, p));
      if (missing.length > 0) {
        let q = model.findOne({ _id: doc._id }).select({ _id: 0, ...Object.fromEntries(missing.map((p) => [p, 1])) });
        if (session) q = q.session(session);
        const extra = toJson(await state.budget.run(q.lean().exec()), info.shape);
        for (const p of missing) {
          const v = getPath(extra, p);
          if (v !== undefined) setPath(before, p, v);
        }
      }
    }
    state.before = before;
  } catch (error) {
    state.failed = true;
    report(model, cfg, { model: rootName(model), docId: doc._id, operation: 'update', stage: 'before', error });
  }
}

/** The before value from the raw loaded object, read the way Mongoose reads it: defaults, casting and the projection. */
function beforeFromRaw(model: Any, info: SchemaInfo, cap: Captured, doc: Any): Json {
  const selected = doc.$__?.selected;
  let projection: Json | undefined;
  if (selected && typeof selected === 'object' && Object.keys(selected).length > 0) {
    const inclusive = Object.entries(selected).some(([k, v]) => k !== '_id' && (v === 1 || v === true));
    projection = inclusive && !('_id' in selected) ? { ...selected, _id: 1 } : selected;
  }
  hydrating++;
  let copy: Any;
  try {
    copy = projection ? model.hydrate(cap.raw, projection) : model.hydrate(cap.raw);
  } finally {
    hydrating--;
  }
  const before = toJson(copy, info.shape);
  if (cap.shared) restoreShared(before, cap.shared);
  return before;
}

/** A dotted path through objects only: reading one field of a list item isn't supported. */
function isPlainPath(info: SchemaInfo, path: string): boolean {
  let shape: Any = info.shape;
  for (const segment of path.split('.')) {
    if (!shape || shape.k !== 'object') return false;
    shape = shape.props.get(segment);
  }
  return true;
}

function getPath(record: Json, path: string): unknown {
  let v: Any = record;
  for (const segment of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = Object.hasOwn(v, segment) ? v[segment] : undefined;
  }
  return v;
}

function setPath(record: Json, path: string, value: unknown): void {
  const segments = path.split('.');
  let v: Any = record;
  for (const segment of segments.slice(0, -1)) {
    if (v[segment] === null || typeof v[segment] !== 'object') v[segment] = {};
    v = v[segment];
  }
  v[segments[segments.length - 1]!] = value;
}

async function afterSave(doc: Any, cfg: Config): Promise<void> {
  const state = saves.get(doc);
  saves.delete(doc);
  if (!state || state.failed) return;
  const model = doc.constructor;
  const info = infoFor(model, cfg);
  if (!info) return;
  // The after value is taken now, before the app can change the document again.
  const after = toJson(doc, info.shape);
  if (cfg.captureOnLoad) captured.set(doc, { converted: after });
  else captured.delete(doc);
  const job: Job = {
    model,
    info,
    operation: state.isNew ? 'create' : 'update',
    docId: doc._id,
    before: state.isNew ? null : (state.before ?? null),
    after,
    who: state.who,
  };
  await run(job, state.session, state.budget, cfg);
}

/** Diffs and delivers, in the background when asked and outside a transaction. */
async function run(job: Job, session: Any, budget: Budget, cfg: Config): Promise<void> {
  const work = async () => {
    const entry = entryFor(job, cfg);
    if (entry) await deliver(job, entry, session, budget, cfg);
  };
  if (cfg.background && !inTransaction(session)) track(work());
  else await work();
}

// ---------------------------------------------------------------- insertMany

async function inserted(model: Any, docs: Any, cfg: Config): Promise<void> {
  if (!Array.isArray(docs)) return;
  const budget = new Budget(cfg.timeout);
  const runs: Promise<void>[] = [];
  for (const doc of docs) {
    if (doc == null || isSubdocument(doc)) continue;
    const m = typeof doc.$__ === 'object' ? doc.constructor : modelFor(model, doc);
    const info = infoFor(m, cfg);
    if (!info) continue;
    const who = resolveAudit(doc.$locals?.audit);
    if (who.skip) continue;
    const after = toJson(doc, info.shape);
    const session = doc.$session?.() ?? undefined;
    runs.push(run({ model: m, info, operation: 'create', docId: doc._id, before: null, after, who }, session, budget, cfg));
  }
  await Promise.all(runs);
}

// ---------------------------------------------------------------- document deleteOne

/** Mongoose 8 and later run query middleware for `doc.deleteOne()`; 7 runs only document middleware. */
const pendingDeletes = new WeakMap<object, Map<string, AuditInfo>>();
const docDeletes = new WeakMap<object, { before: Json | null; who: AuditInfo; session: Any; budget: Budget; model: Any; info: SchemaInfo }>();

function idKey(id: unknown): string {
  return String(id);
}

async function beforeDocDelete(doc: Any, cfg: Config): Promise<void> {
  if (isSubdocument(doc)) return;
  const model = doc.constructor;
  const who = resolveAudit(doc.$locals?.audit);
  if (majorVersion(model) >= 8) {
    // The query hook that follows does the work, with this document's user and reason.
    let pending = pendingDeletes.get(rootModel(model));
    if (!pending) pendingDeletes.set(rootModel(model), (pending = new Map()));
    pending.set(idKey(doc._id), doc.$locals?.audit ?? {});
    return;
  }
  if (who.skip) return;
  const info = infoFor(model, cfg);
  if (!info) return;
  const session = doc.$session?.() ?? undefined;
  const budget = new Budget(cfg.timeout);
  try {
    const before = json(model, await budget.run(readOne(model, info, { _id: doc._id }, session)), cfg).value;
    docDeletes.set(doc, { before, who, session, budget, model, info });
  } catch (error) {
    report(model, cfg, { model: rootName(model), docId: doc._id, operation: 'delete', stage: 'before', error });
  }
}

async function afterDocDelete(doc: Any, cfg: Config): Promise<void> {
  pendingDeletes.get(rootModel(doc.constructor))?.delete(idKey(doc._id));
  const state = docDeletes.get(doc);
  docDeletes.delete(doc);
  if (!state || !state.before) return;
  const job: Job = { model: state.model, info: state.info, operation: 'delete', docId: doc._id, before: state.before, after: null, who: state.who };
  await run(job, state.session, state.budget, cfg);
}

// ---------------------------------------------------------------- queries

interface QueryState {
  op: string;
  model: Any;
  info: SchemaInfo;
  who: AuditInfo;
  session: Any;
  budget: Budget;
  filter: Json;
  sort: unknown;
  collation: unknown;
  upsert: boolean;
  before?: Any;
  befores?: Any[];
}

const queries = new WeakMap<object, QueryState>();

async function beforeQuery(q: Any, cfg: Config): Promise<void> {
  const model = q.model;
  if (!model) return;
  const op: string = q.op;
  const options = q.getOptions?.() ?? q.options ?? {};
  const filter: Json = q.getFilter?.() ?? {};
  // A query run by doc.deleteOne(): that document's user and reason.
  let docAudit: AuditInfo | undefined;
  if (op === 'deleteOne') {
    const keys = Object.keys(filter);
    const pending = pendingDeletes.get(rootModel(model));
    if (pending && keys.length === 1 && keys[0] === '_id' && pending.has(idKey(filter['_id']))) {
      docAudit = pending.get(idKey(filter['_id']));
      pending.delete(idKey(filter['_id']));
    }
  }
  const who = resolveAudit(docAudit, options.audit);
  if (who.skip) return;
  const many = MANY.includes(op);
  if (many && !cfg.many) {
    const key = `${rootName(model)}\u0000${op}`;
    if (!warnedMany.has(key)) {
      warnedMany.add(key);
      cfg.logger.warn(`audit-trail-text: ${rootName(model)}: ${op} is not recorded; pass many: true to the plugin to record it`);
    }
    return;
  }
  const info = infoFor(model, cfg);
  if (!info) return;
  const state: QueryState = {
    op,
    model,
    info,
    who,
    session: options.session ?? undefined,
    budget: new Budget(cfg.timeout),
    filter,
    sort: options.sort,
    collation: options.collation,
    upsert: options.upsert === true,
  };
  const operation: Operation = DELETES.has(op) ? 'delete' : 'update';
  try {
    if (many) {
      const docs = await state.budget.run(readMany(model, info, filter, state.session, cfg.maxMany + 1, state.collation));
      if (docs.length > cfg.maxMany) {
        report(model, cfg, {
          model: rootName(model),
          operation,
          stage: 'maxMany',
          error: new Error(`${op} matched more than maxMany (${cfg.maxMany}) documents, so it was not recorded`),
        });
        return;
      }
      state.befores = docs;
    } else {
      const before = await state.budget.run(readOne(model, info, filter, state.session, { sort: state.sort, collation: state.collation }));
      state.before = before;
      // Narrowed to the document read, so the entry describes the document actually written. An
      // upsert keeps its filter: narrowed, a document that stopped matching would be inserted
      // again under the same _id.
      if (before && !state.upsert) narrow(q, before._id);
    }
    queries.set(q, state);
  } catch (error) {
    report(model, cfg, { model: rootName(model), operation, stage: 'before', error });
  }
}

function narrow(q: Any, id: unknown): void {
  const filter = q.getFilter();
  q.setQuery(Object.hasOwn(filter, '_id') ? { $and: [filter, { _id: id }] } : { ...filter, _id: id });
}

async function afterQuery(q: Any, res: Any, cfg: Config): Promise<void> {
  const state = queries.get(q);
  queries.delete(q);
  if (!state) return;
  const work = async () => {
    try {
      if (state.befores) await afterMany(state, cfg);
      else await afterOne(state, res, cfg);
    } catch {
      // reported inside
    }
  };
  if (cfg.background && !inTransaction(state.session)) track(work());
  else await work();
}

async function afterOne(state: QueryState, res: Any, cfg: Config): Promise<void> {
  const { model, op } = state;
  const deleting = DELETES.has(op);
  if (deleting) {
    if (!state.before || !deleted(op, res)) return;
    const before = json(model, state.before, cfg);
    if (!before.info) return;
    const job: Job = { model: before.model, info: before.info, operation: 'delete', docId: state.before._id, before: before.value, after: null, who: state.who };
    await run(job, state.session, state.budget, cfg);
    return;
  }
  let id: unknown = state.before?._id;
  let raw: Any;
  try {
    if (id === undefined) {
      if (!state.upsert) return;
      id = upsertedId(res);
      raw =
        id !== undefined
          ? await state.budget.run(readOne(model, state.info, { _id: id }, state.session))
          : await state.budget.run(readOne(model, state.info, state.filter, state.session, { sort: state.sort, collation: state.collation }));
    } else {
      raw = await state.budget.run(readOne(model, state.info, { _id: id }, state.session));
    }
  } catch (error) {
    report(model, cfg, { model: rootName(model), docId: id, operation: state.before ? 'update' : 'create', stage: 'after', error });
    return;
  }
  if (!raw) return;
  const after = json(model, raw, cfg);
  const before = json(model, state.before, cfg);
  if (!after.info) return;
  const job: Job = {
    model: after.model,
    info: after.info,
    operation: state.before ? 'update' : 'create',
    docId: raw._id,
    before: before.value,
    after: after.value,
    who: state.who,
  };
  await run(job, state.session, state.budget, cfg);
}

async function afterMany(state: QueryState, cfg: Config): Promise<void> {
  const { model, op } = state;
  const befores = state.befores ?? [];
  if (befores.length === 0) return;
  const ids = befores.map((d) => d._id);
  const deleting = DELETES.has(op);
  let afters: Any[];
  try {
    afters = await state.budget.run(readMany(model, state.info, { _id: { $in: ids } }, state.session, ids.length));
  } catch (error) {
    report(model, cfg, { model: rootName(model), operation: deleting ? 'delete' : 'update', stage: 'after', error });
    return;
  }
  const now = new Map(afters.map((d) => [idKey(d._id), d]));
  const runs: Promise<void>[] = [];
  for (const raw of befores) {
    const still = now.get(idKey(raw._id));
    // A delete is recorded only for documents that are gone; an update only for ones still there.
    if (deleting ? still : !still) continue;
    const before = json(model, raw, cfg);
    const after = json(model, deleting ? null : still, cfg);
    const info = before.info;
    if (!info) continue;
    const job: Job = {
      model: before.model,
      info,
      operation: deleting ? 'delete' : 'update',
      docId: raw._id,
      before: before.value,
      after: after.value,
      who: state.who,
    };
    runs.push(run(job, state.session, state.budget, cfg));
  }
  await Promise.all(runs);
}

/** Whether a single delete removed its document, from the result Mongoose returned. */
function deleted(op: string, res: Any): boolean {
  if (op === 'deleteOne') return res?.deletedCount === undefined || res.deletedCount > 0;
  if (res == null) return false;
  if (typeof res === 'object' && 'value' in res && 'ok' in res) return res.value != null;
  return true;
}

/** The _id an upsert inserted, when the result says. */
function upsertedId(res: Any): unknown {
  if (res == null) return undefined;
  if (res.upsertedId != null) return res.upsertedId;
  if (res.lastErrorObject?.upserted != null) return res.lastErrorObject.upserted;
  if (res.value?._id !== undefined && res.lastErrorObject?.updatedExisting === false) return res.value._id;
  if (res._id !== undefined && !('lastErrorObject' in res)) return res._id;
  return undefined;
}
