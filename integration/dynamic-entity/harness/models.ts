// The models under test, for both storage models, with the plugin on or off. With the plugin on,
// its diff is Dynamic Entity's own diffEntityRecords, so the oracle checks that the plugin hands
// it the right versions of every document and stores what it returns.
import type { EntityFormConfig } from '@dynamic-entity/core';
import { diffEntityRecords, entityAuditAdapter } from '@dynamic-entity/core/history';
import { auditTrail } from 'audit-trail-text/mongoose';
import type { AuditErrorEvent, AuditTrailOptions } from 'audit-trail-text/mongoose';
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
  const w: World = { conn, typed: new Map(), loose: undefined, calls: new Map(), errors: [], warnings: [], plugin };
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
