// Stream mode: one change stream over the audited collections, with MongoDB's own pre- and
// post-images, so every recorded change is exact whatever the concurrency, and writes that
// bypass Mongoose are covered too. Server-only. The MongoDB driver is never imported: the
// watcher works with the client (or Mongoose connection) it is given.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { diffRecords } from '../diff.ts';
import type { Adapter, Change } from '../types.ts';
import { canonical } from '../util.ts';
import { convert } from '../mongoose/values.ts';

type Json = Record<string, unknown>;
// Driver objects are typed loosely: their types differ across driver 5, 6 and 7.
type Any = any;

export type StreamOperation = 'create' | 'update' | 'delete' | 'gap';

/** What the watcher needs for one collection. */
export interface Recorder {
  collection: string;
  /** The field the app's writes carry who and why in, such as "_audit". */
  whoField?: string;
  /** The model name stored in each entry, for a document of this collection. */
  modelOf(doc: Json | null): string;
  /** A raw document from the driver as plain JSON for the diff. */
  toJson(raw: Any): Json;
  /** The changes between two versions; `null` before for a create, `null` after for a delete. */
  changes(before: Json | null, after: Json | null, context: { model: string; operation: 'create' | 'update' | 'delete'; doc: Json }): Change[];
  /** Store the before value of updates, stripped as a delete strips it. */
  snapshots?: boolean;
}

/** One collection for the plain-driver watcher: an adapter or a `diff` function. */
export interface CollectionSpec {
  adapter?: Adapter;
  diff?: (before: Json | null, after: Json | null, context: { model: string; operation: 'create' | 'update' | 'delete' }) => Change[];
  whoField?: string;
  /** The model name in entries. Default: the collection name. */
  model?: string;
  snapshots?: boolean;
}

export interface WatcherOptions {
  /** The audit collection. Default "audit_trail". */
  auditCollection?: string;
  /** Resume tokens and the lease. Default "audit_watcher_state". */
  stateCollection?: string;
  /** Transaction context records written by the Mongoose plugin. Default "audit_context". */
  contextCollection?: string;
  /** Turn on pre- and post-images on each audited collection with collMod. Default false. */
  enableImages?: boolean;
  /** Most events per batch before entries are written and the resume token saved. Default 100. */
  batchSize?: number;
  /** Lease timings: renewed every `renewMS` (10,000), taken over after `takeoverMS` (30,000). */
  lease?: { renewMS?: number; takeoverMS?: number };
  /** How long to wait for a transaction's context record. Default 5,000 ms. */
  contextWaitMS?: number;
  /** The longest one step of the event loop may take before the watcher restarts its stream from its saved position. Default 30,000 ms. */
  stallTimeoutMS?: number;
  /** Where warnings go when nothing listens to `auditError`. Default `console`. */
  logger?: { warn(message: string): void };
  /** This watcher's name in the lease. Default: a random id. */
  name?: string;
  /**
   * The lease and saved position watchers share: one watcher with a given id is active at a
   * time. Default: one per database, so a watcher whose collections change keeps its position.
   * Give watchers of separate sets of collections in one database their own ids.
   */
  id?: string;
}

export type WatcherStage = 'diff' | 'write' | 'preImage' | 'postImage' | 'resume' | 'tooLarge' | 'collection' | 'stream' | 'context' | 'lease' | 'setup';

export interface WatcherErrorEvent {
  stage: WatcherStage;
  error: unknown;
  collection?: string;
  model?: string;
  docId?: unknown;
  eventId?: string;
  /** Entries that weren't written, for `stage: "write"`. */
  entries?: Json[];
}

/**
 * The watcher: one per deployment is active at a time; the others stand by. Its events are
 * `auditError` (a WatcherErrorEvent), `active` and `standby`. Typed here without Node's own
 * types, so the package's declarations need no @types/node.
 */
export interface AuditWatcher {
  /** Whether this watcher holds the lease and is processing events. */
  readonly active: boolean;
  on(event: 'auditError', listener: (event: WatcherErrorEvent) => void): this;
  on(event: 'active' | 'standby', listener: () => void): this;
  once(event: 'auditError', listener: (event: WatcherErrorEvent) => void): this;
  once(event: 'active' | 'standby', listener: () => void): this;
  off(event: 'auditError' | 'active' | 'standby', listener: (...args: any[]) => void): this;
  listenerCount(event: 'auditError' | 'active' | 'standby'): number;
  /** Resolves once this watcher has recorded every write made before the call. */
  caughtUp(timeoutMS?: number): Promise<void>;
  /** Stops watching and gives up the lease. */
  stop(): Promise<void>;
}

const RESUME_LOST = new Set([136, 280, 286]);
const TOO_LARGE = new Set([10334, 17419]);
const TRANSIENT_LABELS = ['RetryableWriteError', 'TransientTransactionError', 'ResumableChangeStreamError'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());


/** Starts a watcher with the plain MongoDB driver: `{ client, db, collections }`. */
export async function startAuditWatcher(options: WatcherOptions & { client: Any; db: string | Any; collections: Record<string, CollectionSpec> }): Promise<AuditWatcher> {
  const db = typeof options.db === 'string' ? options.client.db(options.db) : options.db;
  const recorders = Object.entries(options.collections).map(([collection, spec]): Recorder => {
    if (!spec.adapter && !spec.diff) throw new TypeError(`collection ${collection}: give an adapter or a diff function`);
    const model = spec.model ?? collection;
    return {
      collection,
      ...(spec.whoField && { whoField: spec.whoField }),
      ...(spec.snapshots && { snapshots: true }),
      modelOf: () => model,
      toJson: (raw) => convert(raw, undefined) as Json,
      changes: (before, after, ctx) => (spec.diff ? spec.diff(before, after, { model: ctx.model, operation: ctx.operation }) : diffRecords(before, after, spec.adapter!)),
    };
  });
  return watch(db, recorders, options);
}

/** Starts a watcher over a database for the given recorders. */
export async function watch(db: Any, recorders: Recorder[], options: WatcherOptions = {}): Promise<AuditWatcher> {
  const watcher = new Watcher(db, recorders, options);
  await watcher.start();
  return watcher;
}

interface State {
  _id: string;
  owner?: string;
  epoch?: number;
  leaseUntil?: Date;
  token?: unknown;
  time?: unknown;
  wall?: Date;
}

class Watcher extends EventEmitter implements AuditWatcher {
  readonly #db: Any;
  readonly #recorders: Map<string, Recorder>;
  readonly #o: Required<Omit<WatcherOptions, 'lease' | 'name' | 'logger' | 'id'>> & { renewMS: number; takeoverMS: number; name: string; logger: { warn(m: string): void } };
  readonly #stateId: string;
  #active = false;
  #stopping = false;
  #epoch = 0;
  #stream: Any;
  #loop: Promise<void> | undefined;
  #renewer: ReturnType<typeof setInterval> | undefined;
  #disabled = new Set<string>();
  #contexts = new Map<string, Json | null>();
  #markers = new Map<string, () => void>();
  #split = true;
  #lastWall: Date | undefined;
  #fragments: Any[] = [];
  /** What the event loop is waiting on, for diagnosing a stall. */
  #phase = 'starting';

  get [Symbol.for('audit-trail-text.watcher.phase')](): string {
    return this.#phase;
  }

  /**
   * A step of the event loop, bounded: whatever it waits on (a reply that never comes, a lost
   * connection), the watcher restarts its stream from the saved token instead of stalling.
   * Replays are harmless: entries are keyed by eventId.
   */
  async #bounded<T>(step: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    step.catch(() => {});
    try {
      return await Promise.race([
        step,
        new Promise<never>((_, reject) => {
          const ms = this.#o.stallTimeoutMS;
          timer = setTimeout(() => reject(new Error(`the watcher stalled for ${ms} ms in ${this.#phase}; restarting from its saved position`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  constructor(db: Any, recorders: Recorder[], o: WatcherOptions) {
    super();
    this.#db = db;
    this.#recorders = new Map(recorders.map((r) => [r.collection, r]));
    this.#o = {
      auditCollection: o.auditCollection ?? 'audit_trail',
      stateCollection: o.stateCollection ?? 'audit_watcher_state',
      contextCollection: o.contextCollection ?? 'audit_context',
      enableImages: o.enableImages === true,
      batchSize: o.batchSize ?? 100,
      contextWaitMS: o.contextWaitMS ?? 5000,
      stallTimeoutMS: o.stallTimeoutMS ?? 30_000,
      renewMS: o.lease?.renewMS ?? 10_000,
      takeoverMS: o.lease?.takeoverMS ?? 30_000,
      name: o.name ?? randomUUID(),
      logger: o.logger ?? console,
    };
    this.#stateId = `stream:${db.databaseName}${o.id ? `:${o.id}` : ''}`;
  }

  get active(): boolean {
    return this.#active;
  }

  // ---------------------------------------------------------------- setup and lease

  async start(): Promise<void> {
    const audit = this.#db.collection(this.#o.auditCollection);
    await Promise.all([
      audit.createIndex({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } }),
      audit.createIndex({ model: 1, docId: 1, at: -1, _id: -1 }),
      audit.createIndex({ model: 1, operation: 1, to: 1 }, { partialFilterExpression: { operation: 'gap' } }),
      this.#db.collection(this.#o.contextCollection).createIndex({ lsid: 1, txnNumber: 1 }),
      this.#db.collection(this.#o.contextCollection).createIndex({ createdAt: 1 }, { expireAfterSeconds: 86_400 }),
    ]);
    if (this.#o.enableImages) {
      for (const name of this.#recorders.keys()) {
        try {
          await this.#db.command({ collMod: name, changeStreamPreAndPostImages: { enabled: true } });
        } catch (e: Any) {
          if (e?.code !== 26) throw e; // NamespaceNotFound: create it with images on
          await this.#db.createCollection(name, { changeStreamPreAndPostImages: { enabled: true } });
        }
      }
    }
    await this.#state().updateOne({ _id: this.#stateId }, { $setOnInsert: { epoch: 0, leaseUntil: new Date(0) } }, { upsert: true }).catch((e: Any) => {
      if (e?.code !== 11000) throw e;
    });
    await this.#tryLease();
    this.#renewer = setInterval(() => void this.#tryLease(), this.#o.renewMS);
    this.#renewer.unref?.();
  }

  #state(): Any {
    return this.#db.collection(this.#o.stateCollection);
  }

  /**
   * Takes or renews the lease. Server time decides expiry, so instances' clocks don't matter;
   * every takeover increases the epoch, which fences a watcher that paused past it.
   */
  async #tryLease(): Promise<void> {
    if (this.#stopping) return;
    const me = this.#o.name;
    try {
      const doc = await this.#state().findOneAndUpdate(
        { _id: this.#stateId, $or: [{ owner: me, epoch: this.#epoch }, { $expr: { $lt: ['$leaseUntil', '$$NOW'] } }] },
        [
          {
            $set: {
              epoch: { $cond: [{ $and: [{ $eq: ['$owner', me] }, { $eq: ['$epoch', this.#epoch] }] }, '$epoch', { $add: [{ $ifNull: ['$epoch', 0] }, 1] }] },
              owner: me,
              leaseUntil: { $add: ['$$NOW', this.#o.takeoverMS] },
            },
          },
        ],
        { returnDocument: 'after', includeResultMetadata: false },
      );
      const state: State | null = doc && 'value' in doc && 'ok' in doc ? doc.value : doc;
      if (!state) {
        if (this.#active) this.#lose();
        return;
      }
      const took = !this.#active || state.epoch !== this.#epoch;
      this.#epoch = state.epoch!;
      if (took && !this.#active) {
        this.#active = true;
        this.emit('active');
        this.#loop = this.#run(state).catch((error) => this.#report({ stage: 'stream', error }));
      }
    } catch (error) {
      this.#report({ stage: 'lease', error });
    }
  }

  #lose(): void {
    this.#active = false;
    this.emit('standby');
    void this.#stream?.close?.().catch(() => {});
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#renewer) clearInterval(this.#renewer);
    const wasActive = this.#active;
    this.#active = false;
    await this.#stream?.close?.().catch(() => {});
    await this.#loop?.catch(() => {});
    if (wasActive) {
      // Give the lease up at once, so a standby takes over without waiting for it to expire.
      await this.#state().updateOne({ _id: this.#stateId, owner: this.#o.name, epoch: this.#epoch }, { $set: { leaseUntil: new Date(0) } }).catch(() => {});
    }
    for (const done of this.#markers.values()) done();
    this.#markers.clear();
  }

  // ---------------------------------------------------------------- caught up

  async caughtUp(timeoutMS = 30_000): Promise<void> {
    // A marker written now reaches this watcher after every earlier write, in order.
    const id = `marker:${randomUUID()}`;
    const seen = new Promise<void>((resolve) => this.#markers.set(id, resolve));
    await this.#state().insertOne({ _id: id, createdAt: new Date() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`caughtUp: not caught up within ${timeoutMS} ms${this.#active ? '' : ' (this watcher is on standby)'}`)), timeoutMS);
    });
    try {
      await Promise.race([seen, timeout]);
    } finally {
      clearTimeout(timer);
      this.#markers.delete(id);
      await this.#state().deleteOne({ _id: id }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- the stream

  #pipeline(): Json[] {
    const names = [...this.#recorders.keys()].filter((n) => !this.#disabled.has(n));
    return [
      {
        $match: {
          $or: [
            { 'ns.coll': { $in: names } },
            { 'ns.coll': this.#o.stateCollection, operationType: 'insert', 'documentKey._id': { $regex: '^marker:' } },
          ],
        },
      },
    ];
  }

  #open(state: State | null, extra: Json[] = [], images = true): Any {
    const pipeline = [...this.#pipeline(), ...extra, ...(this.#split && images ? [{ $changeStreamSplitLargeEvent: {} }] : [])];
    const options: Json = { batchSize: this.#o.batchSize, maxAwaitTimeMS: 250 };
    if (images) {
      options['fullDocument'] = 'whenAvailable';
      options['fullDocumentBeforeChange'] = 'whenAvailable';
    }
    if (state?.token) options['startAfter'] = state.token;
    else if (state?.time) options['startAtOperationTime'] = state.time;
    return this.#db.watch(pipeline, options);
  }

  /**
   * A first start has no saved position: the current cluster time is saved before the stream
   * opens, so a watcher that crashes before its first batch loses nothing to the next one.
   */
  async #startingPoint(state: State): Promise<State> {
    if (state.token || state.time) return state;
    const reply = await this.#db.command({ ping: 1 });
    const time = reply?.operationTime ?? reply?.$clusterTime?.clusterTime;
    if (!time) return state;
    await this.#state().updateOne({ _id: this.#stateId, owner: this.#o.name, epoch: this.#epoch, token: { $exists: false }, time: { $exists: false } }, { $set: { time, wall: new Date() } });
    return { ...state, time };
  }

  async #run(initial: State): Promise<void> {
    let state: State | null = await this.#startingPoint(initial);
    let failures = 0;
    while (this.#active && !this.#stopping) {
      try {
        this.#stream = this.#open(state);
        await this.#drain();
        failures = 0;
      } catch (error: Any) {
        if (!this.#active || this.#stopping) break;
        if (error?.code === 40324 && this.#split) {
          // The server has no $changeStreamSplitLargeEvent: large events become gaps.
          this.#split = false;
          state = await this.#saved();
          continue;
        }
        if (RESUME_LOST.has(error?.code) || /resume point may no longer be in the oplog|history (was|has been) lost/i.test(String(error?.message))) {
          await this.#resumeGap(error, await this.#saved());
          state = await this.#startingPoint({ _id: this.#stateId });
          continue;
        }
        if (TOO_LARGE.has(error?.code) || /BSONObjectTooLarge|too large/i.test(String(error?.message))) {
          state = await this.#skipLarge(error, await this.#saved());
          continue;
        }
        if (/invalidate/i.test(String(error?.message))) {
          this.#report({ stage: 'collection', error });
          break;
        }
        this.#report({ stage: 'stream', error });
        await sleep(Math.min(30_000, 250 * 2 ** failures++));
        state = await this.#saved();
      } finally {
        await this.#stream?.close?.().catch(() => {});
      }
    }
  }

  async #saved(): Promise<State | null> {
    return this.#state().findOne({ _id: this.#stateId });
  }

  /** Reads events and records them in batches, saving the resume token after each batch. */
  async #drain(): Promise<void> {
    const stream = this.#stream;
    let batch: { entries: Json[]; markers: string[] } = { entries: [], markers: [] };
    // The last event's own token. Driver 5's tryNext doesn't move stream.resumeToken past the
    // events it returns, so the newer of the two is saved.
    let handled: Any;
    while (this.#active && !this.#stopping) {
      this.#phase = 'tryNext';
      const event: Any = await this.#bounded(stream.tryNext());
      if (event) {
        const whole = this.#join(event);
        this.#phase = `handle ${event.operationType} ${event.ns?.coll}${event.splitEvent ? ` fragment ${event.splitEvent.fragment}/${event.splitEvent.of}` : ''}`;
        if (whole) {
          await this.#bounded(this.#handle(whole, batch));
          handled = whole._id;
        }
      }
      // Written as soon as no fetched event is waiting: a burst is batched, a quiet stream isn't
      // held for the server's next empty wait.
      const waiting = stream.bufferedCount?.() ?? stream.cursor?.bufferedCount?.() ?? 0;
      if (!event || waiting === 0 || batch.entries.length >= this.#o.batchSize) {
        if (this.#fragments.length > 0) continue; // never save a token inside a split event
        await this.#bounded(this.#flush(batch, newer(stream.resumeToken, handled)));
        batch = { entries: [], markers: [] };
      }
    }
  }

  /** Joins a split event's fragments; returns the whole event once its last fragment arrives. */
  #join(event: Any): Any {
    const split = event.splitEvent;
    if (!split) return event;
    this.#fragments.push(event);
    if (split.fragment < split.of) return undefined;
    const whole: Any = {};
    for (const f of this.#fragments) Object.assign(whole, f);
    delete whole.splitEvent;
    whole._id = event._id;
    this.#fragments = [];
    return whole;
  }

  async #flush(batch: { entries: Json[]; markers: string[] }, token: unknown): Promise<void> {
    this.#phase = `write ${batch.entries.length}`;
    if (batch.entries.length > 0) await this.#write(batch.entries);
    this.#phase = 'save token';
    if (token) {
      const res = await this.#state().updateOne(
        { _id: this.#stateId, owner: this.#o.name, epoch: this.#epoch },
        { $set: { token, ...(this.#lastWall && { wall: this.#lastWall }) }, $unset: { time: 1 } },
      );
      if (res.matchedCount === 0) {
        // Another watcher took over: stop, without touching its token.
        this.#lose();
        return;
      }
    }
    for (const id of batch.markers) this.#markers.get(id)?.();
  }

  /** Writes entries keyed by eventId, so a replayed event rewrites its entry rather than adding one. */
  async #write(entries: Json[]): Promise<void> {
    const ops = entries.map((entry) => ({ updateOne: { filter: { eventId: entry['eventId'] }, update: { $setOnInsert: entry }, upsert: true } }));
    const audit = this.#db.collection(this.#o.auditCollection);
    for (let attempt = 0; ; attempt++) {
      try {
        await audit.bulkWrite(ops, { ordered: false });
        return;
      } catch (error: Any) {
        // A duplicate eventId from two watchers racing is the same entry: done.
        const errors: Any[] = error?.writeErrors ?? (error?.code ? [error] : []);
        if (errors.length > 0 && errors.every((e) => (e.code ?? e.err?.code) === 11000)) return;
        const transient = TRANSIENT_LABELS.some((l) => error?.hasErrorLabel?.(l)) || error?.name === 'MongoNetworkError';
        if (transient && attempt < 3) {
          await sleep(100 * 2 ** attempt);
          continue;
        }
        this.#report({ stage: 'write', error, entries });
        return;
      }
    }
  }

  // ---------------------------------------------------------------- events

  async #handle(event: Any, batch: { entries: Json[]; markers: string[] }): Promise<void> {
    const coll: string = event.ns?.coll;
    if (coll === this.#o.stateCollection) {
      const id = String(event.documentKey?._id);
      if (this.#markers.has(id)) batch.markers.push(id);
      return;
    }
    const op: string = event.operationType;
    if (op === 'drop' || op === 'rename' || op === 'dropDatabase' || op === 'invalidate') {
      this.#disabled.add(coll);
      this.#report({ stage: 'collection', collection: coll, error: new Error(`${coll}: ${op}; no longer audited`) });
      return;
    }
    const recorder = this.#recorders.get(coll);
    if (!recorder || this.#disabled.has(coll)) return;
    if (event.wallTime instanceof Date) this.#lastWall = event.wallTime;
    const eventId = eventKey(event._id);
    const docId = event.documentKey?._id;
    const at: Date = event.wallTime instanceof Date ? event.wallTime : new Date();
    let operation: 'create' | 'update' | 'delete';
    let beforeRaw: Any = null;
    let afterRaw: Any = null;
    if (op === 'insert') {
      operation = 'create';
      afterRaw = event.fullDocument;
    } else if (op === 'update' || op === 'replace') {
      operation = 'update';
      beforeRaw = event.fullDocumentBeforeChange;
      afterRaw = event.fullDocument;
    } else if (op === 'delete') {
      operation = 'delete';
      beforeRaw = event.fullDocumentBeforeChange;
    } else {
      return;
    }
    const missing = operation !== 'create' && !beforeRaw ? 'preImage' : operation !== 'delete' && !afterRaw ? 'postImage' : undefined;
    if (missing) {
      const model = recorder.modelOf(null);
      batch.entries.push(gapEntry(model, docId, at, at, eventId, missing));
      this.#report({ stage: missing, collection: coll, model, docId, eventId, error: new Error(`${coll} ${String(docId)}: the change at ${at.toISOString()} has no ${missing === 'preImage' ? 'pre-image' : 'post-image'}`) });
      return;
    }
    const before = beforeRaw ? recorder.toJson(beforeRaw) : null;
    const after = afterRaw ? recorder.toJson(afterRaw) : null;
    const model = recorder.modelOf(after ?? before);

    // Who: the transaction's context, then the who-field, then no one.
    let who: Json | undefined;
    if (event.lsid?.id && event.txnNumber != null) who = (await this.#context(event.lsid.id, event.txnNumber)) ?? undefined;
    const wf = recorder.whoField;
    if (!who && wf) {
      const now = (after?.[wf] ?? undefined) as Json | undefined;
      const was = (before?.[wf] ?? undefined) as Json | undefined;
      // Credited only when this write changed the field: a write that didn't set it is no one's.
      if (now && now['writeId'] != null && now['writeId'] !== was?.['writeId']) who = now;
    }
    if (who?.['skip'] === true) return;
    if (wf) {
      if (before) delete before[wf];
      if (after) delete after[wf];
    }

    let changes: Change[];
    try {
      changes = recorder.changes(before, after, { model, operation, doc: (after ?? before)! });
      if (!Array.isArray(changes)) throw new TypeError('the diff must return an array of changes');
    } catch (error) {
      this.#report({ stage: 'diff', collection: coll, model, docId, eventId, error });
      return;
    }
    if (changes.length === 0) return;
    const entry: Json = { model, docId, operation, at };
    if (who?.['user'] !== undefined) entry['user'] = who['user'];
    if (who?.['reason'] !== undefined) entry['reason'] = who['reason'];
    entry['changes'] = changes;
    if (recorder.snapshots && operation === 'update' && before) {
      try {
        const stripped = recorder.changes(before, null, { model, operation: 'delete', doc: before }).find((c) => c.code === 'RECORD_DELETED')?.before;
        if (stripped && typeof stripped === 'object') entry['snapshot'] = stripped;
      } catch {
        // written without its snapshot
      }
    }
    entry['eventId'] = eventId;
    entry['source'] = 'stream';
    entry['v'] = 1;
    batch.entries.push(entry);
  }

  /** The context record for a transaction, waiting up to contextWaitMS for it to land. */
  async #context(lsidId: Any, txnNumber: Any): Promise<Json | null> {
    const key = `${canonical(convert(lsidId, { k: 'uuid' }))}:${String(txnNumber)}`;
    if (this.#contexts.has(key)) return this.#contexts.get(key)!;
    const filter = { lsid: lsidId, txnNumber: Number(txnNumber) };
    const contexts = this.#db.collection(this.#o.contextCollection);
    const deadline = Date.now() + this.#o.contextWaitMS;
    let found: Json | null = null;
    for (;;) {
      try {
        found = await contexts.findOne(filter);
      } catch (error) {
        this.#report({ stage: 'context', error });
      }
      if (found || Date.now() >= deadline) break;
      await sleep(50);
    }
    if (this.#contexts.size > 10_000) this.#contexts.clear();
    this.#contexts.set(key, found);
    return found;
  }

  /** The oplog no longer holds the saved position: record what was missed, start from now. */
  async #resumeGap(error: unknown, state: State | null): Promise<void> {
    const now = new Date();
    const from = state?.wall ?? now;
    const entries = [...this.#recorders.values()]
      .filter((r) => !this.#disabled.has(r.collection))
      .map((r) => gapEntry(r.modelOf(null), undefined, from, now, `gap:${r.collection}:${from.getTime()}:${now.getTime()}`, 'resume'));
    await this.#write(entries);
    this.#report({ stage: 'resume', error });
    await this.#state().updateOne({ _id: this.#stateId, owner: this.#o.name, epoch: this.#epoch }, { $unset: { token: 1, time: 1 }, $set: { wall: now } });
  }

  /** An event too large to read without split events: recorded as a gap, then skipped. */
  async #skipLarge(error: unknown, state: State | null): Promise<State | null> {
    // Read the next event again without its images, which keeps it small, to learn what it was.
    const probe = this.#open(state, [], false);
    try {
      const event = await probe.next();
      const coll = event?.ns?.coll;
      const recorder = coll ? this.#recorders.get(coll) : undefined;
      const at: Date = event?.wallTime instanceof Date ? event.wallTime : new Date();
      if (recorder) {
        const model = recorder.modelOf(null);
        await this.#write([gapEntry(model, event.documentKey?._id, at, at, eventKey(event._id), 'tooLarge')]);
        this.#report({ stage: 'tooLarge', collection: coll, model, docId: event.documentKey?._id, eventId: eventKey(event._id), error });
      }
      const next: State = { _id: this.#stateId, token: event._id, wall: at };
      await this.#state().updateOne({ _id: this.#stateId, owner: this.#o.name, epoch: this.#epoch }, { $set: { token: event._id, wall: at } });
      return next;
    } finally {
      await probe.close().catch(() => {});
    }
  }

  #report(event: WatcherErrorEvent): void {
    try {
      if (this.listenerCount('auditError') > 0) {
        this.emit('auditError', event);
        return;
      }
    } catch {
      // a throwing listener never stops the watcher
    }
    const reason = event.error instanceof Error ? event.error.message : String(event.error);
    try {
      this.#o.logger.warn(`audit-trail-text watcher: ${event.stage}${event.collection ? ` (${event.collection})` : ''}: ${reason}`);
    } catch {
      // nothing more to do
    }
  }
}

/**
 * The later of two resume tokens. A token's data begins with its cluster time, so their hex
 * text sorts in time order.
 */
function newer(a: Any, b: Any): Any {
  if (!a) return b;
  if (!b) return a;
  return typeof a._data === 'string' && typeof b._data === 'string' && b._data > a._data ? b : a;
}

/** A change event's id as text: its resume token's data. */
function eventKey(id: Any): string {
  return typeof id?._data === 'string' ? id._data : canonical(convert(id, undefined));
}

function gapEntry(model: string, docId: unknown, from: Date, to: Date, eventId: string, stage: string): Json {
  const entry: Json = { model };
  if (docId !== undefined) entry['docId'] = docId;
  Object.assign(entry, { operation: 'gap', at: to, from, to, changes: [], stage, eventId, source: 'stream', v: 1 });
  return entry;
}
