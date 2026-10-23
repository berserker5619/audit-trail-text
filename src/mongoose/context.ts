import { AsyncLocalStorage } from 'node:async_hooks';

/** Who made a change and why, or `skip: true` to record nothing. */
export interface AuditInfo {
  /** Any JSON-safe value: an id, or `{ id, name }`. Stored as given. */
  user?: unknown;
  reason?: string;
  /** Record nothing, for data migrations and seed scripts. */
  skip?: boolean;
}

const storage = new AsyncLocalStorage<AuditInfo>();

export const auditContext = {
  /**
   * Runs `fn` with this user and reason for every write inside it, including awaited calls. An
   * inner `run` adds to the outer one: `{ reason }` keeps the outer `user`. A Mongoose query
   * returned by `fn` is executed inside, so `run(info, () => Order.updateOne(...))` is attributed.
   */
  run<T>(info: AuditInfo, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...defined(info) }, () => {
      const result = fn() as { exec?: unknown; then?: unknown } | undefined;
      if (result && typeof result.exec === 'function' && typeof result.then === 'function') return (result.exec as () => T)();
      return result as T;
    });
  },
  /** The current user and reason, if any. */
  get(): AuditInfo | undefined {
    return storage.getStore();
  },
};

/** The most specific value wins for each field: per query, then per document, then the request. */
export function resolveAudit(...levels: (AuditInfo | undefined)[]): AuditInfo {
  const out: AuditInfo = {};
  for (const level of [storage.getStore(), ...levels]) Object.assign(out, defined(level));
  return out;
}

/** Leaves out fields set to undefined, so they never hide an outer value. */
function defined(info: AuditInfo | undefined): AuditInfo {
  const out: AuditInfo = {};
  if (!info || typeof info !== 'object') return out;
  if (info.user !== undefined) out.user = info.user;
  if (info.reason !== undefined) out.reason = info.reason;
  if (info.skip !== undefined) out.skip = info.skip;
  return out;
}
