// The models under test, for both storage models, with the plugin on or off. With the plugin on,
// its diff is Dynamic Entity's own diffEntityRecords, so the oracle checks that the plugin hands
// it the right versions of every document and stores what it returns.
import type { EntityFormConfig } from '@dynamic-entity/core';
import { diffEntityRecords, entityAuditAdapter } from '@dynamic-entity/core/history';
import { auditTrail, startAuditWatcher } from 'audit-trail-text/mongoose';
import type { AuditErrorEvent, AuditTrailOptions, AuditWatcher, WatcherOptions } from 'audit-trail-text/mongoose';
import { FIXTURES } from './configs.ts';
import type { Fixture } from './configs.ts';
import type { mongoose } from './db.ts';
import { looseSchema, typedLabels, typedSchema } from './schemas.ts';

type Rec = Record<string, unknown>;

/** What the plugin handed its diff, by document id. */
export interface DiffCall {
  before: Rec | null;
  after: Rec | null;
  operation: string;
}

export interface World {
  conn: mongoose.Connection;
  /** Storage model (A): one typed model per config. */
  typed: Map<string, any>;
  /** Storage model (B): one loose collection for every config. */
  loose: any;
  calls: Map<string, DiffCall[]>;
  errors: AuditErrorEvent[];
  warnings: string[];
  plugin: boolean;
  /** Stream mode: the watcher, and the who-field the writes carry. */
  watcher?: AuditWatcher;
  whoField?: string;
  /** Waits until every write so far is recorded. */
  settle(): Promise<void>;
}

const adapters = new Map<EntityFormConfig, ReturnType<typeof entityAuditAdapter>>();
export function adapterFor(config: EntityFormConfig) {
  let a = adapters.get(config);
  if (!a) adapters.set(config, (a = entityAuditAdapter(config)));
  return a;
}

export function fixtureOf(entity: string): Fixture {
  const f = FIXTURES.find((x) => x.config.entity === entity);
  if (!f) throw new Error(`no fixture for entity ${entity}`);
  return f;
}

/** The changes Dynamic Entity itself gives for two stored versions. */
export function oracle(fixture: Fixture, before: Rec | null, after: Rec | null) {
  return diffEntityRecords(before, after, fixture.config, { migrations: fixture.migrations, adapter: adapterFor(fixture.config) });
}

/** A diff for the plugin that records what it was handed, then asks Dynamic Entity. */
export function recordingDiff(w: World, fixture: (record: Rec) => Fixture) {
  return (before: Rec | null, after: Rec | null, { operation }: { operation: string }) => {
    const id = String((after ?? before)?.['_id']);
    let list = w.calls.get(id);
    if (!list) w.calls.set(id, (list = []));
    list.push({ before, after, operation });
    return oracle(fixture((after ?? before)!), before, after);
  };
}

let worlds = 0;

export function world(
  m: typeof mongoose,
  base: mongoose.Connection,
  options: { plugin?: boolean; plugin_options?: Partial<AuditTrailOptions>; db?: string; fixtures?: Fixture[]; clock?: () => Date } = {},
): World {
  const plugin = options.plugin !== false;
  const conn = base.useDb(options.db ?? `world${++worlds}`, { useCache: true });
  const w: World = { conn, typed: new Map(), loose: undefined, calls: new Map(), errors: [], warnings: [], plugin, settle: async () => {} };
  const logger = { warn: (msg: string) => void w.warnings.push(msg) };
  const pluginOptions = (diff: AuditTrailOptions['diff'], extra: Partial<AuditTrailOptions> = {}): AuditTrailOptions => ({
    diff,
    many: true,
    logger,
    ...options.plugin_options,
    ...extra,
  });

  for (const fixture of options.fixtures ?? FIXTURES) {
    const schema = typedSchema(m, fixture.config, { ...(options.clock && { clock: options.clock }) });
    if (plugin) {
      schema.plugin(
        auditTrail,
        pluginOptions(recordingDiff(w, () => fixture), { labels: typedLabels(fixture.config) }),
      );
    }
    w.typed.set(fixture.config.entity, conn.model(`T_${fixture.config.entity}`, schema));
  }
  const loose = looseSchema(m, { ...(options.clock && { clock: options.clock }) });
  if (plugin) {
    loose.plugin(
      auditTrail,
      pluginOptions(recordingDiff(w, (record) => fixtureOf(String(record['entity'])))),
    );
  }
  w.loose = conn.model('Records', loose);
  for (const model of [...w.typed.values(), w.loose]) model.on('auditError', (e: AuditErrorEvent) => w.errors.push(e));
  return w;
}

/** The model a record of this entity is stored with, in one storage model. */
export function modelFor(w: World, storage: 'typed' | 'loose', entity: string): any {
  return storage === 'typed' ? w.typed.get(entity) : w.loose;
}

/** A record as the app writes it: the loose model carries the entity name. */
export function forStorage(storage: 'typed' | 'loose', entity: string, record: Rec): Rec {
  return storage === 'loose' ? { entity, ...record } : record;
}

/**
 * A world in stream mode: the same models with `mode: 'stream'` (and a who-field unless
 * `whoField: false`), and a watcher recording them from MongoDB's images.
 */
export async function streamWorld(
  m: typeof mongoose,
  base: mongoose.Connection,
  options: { db?: string; fixtures?: Fixture[]; whoField?: string | false; plugin_options?: Partial<AuditTrailOptions>; watcher?: Partial<WatcherOptions> | false; clock?: () => Date } = {},
): Promise<World> {
  const whoField = options.whoField === false ? undefined : (options.whoField ?? '_audit');
  const w = world(m, base, {
    ...(options.db && { db: options.db }),
    ...(options.fixtures && { fixtures: options.fixtures }),
    ...(options.clock && { clock: options.clock }),
    plugin_options: { mode: 'stream', ...(whoField && { whoField }), ...options.plugin_options },
  });
  const models = [...w.typed.values(), w.loose];
  for (const model of models) await model.init();
  if (whoField) w.whoField = whoField;
  // Without a watcher: the app side only, for a watcher run elsewhere (another process).
  if (options.watcher === false) return w;
  const watcher = await startAuditWatcher({ connection: w.conn, models, enableImages: true, lease: { renewMS: 200, takeoverMS: 1000 }, logger: { warn: (msg: string) => void w.warnings.push(msg) }, ...options.watcher });
  watcher.on('auditError', (e: any) => w.errors.push(e));
  for (let i = 0; i < 100 && !watcher.active; i++) await new Promise((r) => setTimeout(r, 20));
  w.watcher = watcher;
  w.settle = async () => {
    try {
      await watcher.caughtUp(60_000);
    } catch (error) {
      // What the watcher was doing, so a stall can be told apart from a slow machine.
      const state = await w.conn.db!.collection('audit_watcher_state').find({ _id: { $not: /^marker:/ } }).toArray();
      const phase = (watcher as any)[Symbol.for('audit-trail-text.watcher.phase')];
      throw new Error(`${String(error)}; active: ${watcher.active}; phase: ${phase}; errors: ${JSON.stringify(w.errors.slice(-5).map((e: any) => [e.stage, String(e.error)]))}; warnings: ${JSON.stringify(w.warnings.slice(-5))}; state: ${JSON.stringify(state)}`);
    }
  };
  return w;
}
