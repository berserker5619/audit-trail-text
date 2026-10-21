export type DiffErrorCode =
  | 'INVALID_SCHEMA'
  | 'LIST_KEY_MISSING'
  | 'KEY_NOT_IN_SCHEMA'
  | 'SENSITIVE_KEY'
  | 'ITEM_KEY_MISSING'
  | 'DUPLICATE_KEY'
  | 'TOO_DEEP'
  | 'NOT_JSON';

export class DiffError extends Error {
  readonly code: DiffErrorCode;
  /** Record path for diff errors, schema or labels path for adapter errors. */
  readonly path: string;
  /** Which record the path points into, for diff errors. */
  readonly side?: 'before' | 'after';
  /** The duplicate key value, for DUPLICATE_KEY. */
  readonly key?: unknown;

  constructor(
    code: DiffErrorCode,
    path: string,
    message: string,
    extra: { side?: 'before' | 'after'; key?: unknown } = {},
  ) {
    const where = extra.side ? `${extra.side} ${path || '/'}` : path || '/';
    super(`${code} at ${where}: ${message}`);
    this.name = 'DiffError';
    this.code = code;
    this.path = path;
    if (extra.side !== undefined) this.side = extra.side;
    if ('key' in extra) this.key = extra.key;
  }
}
