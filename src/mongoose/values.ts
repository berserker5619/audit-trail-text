import { createHash } from 'node:crypto';
import type { Any, Shape } from './schema.ts';

type Json = Record<string, unknown>;

/** Options for `toObject`: no virtuals, getters or schema transforms, so only stored data is recorded. */
export const TO_OBJECT = { depopulate: true, flattenMaps: true, versionKey: false, virtuals: false, getters: false, transform: false } as const;

/** A document, a subdocument or a plain object from the driver, as plain JSON for the diff. */
export function toJson(value: Any, shape: Shape | undefined): Json {
  const v = value && typeof value.toObject === 'function' && value.$__ !== undefined ? value.toObject(TO_OBJECT) : value;
  return convert(v, shape) as Json;
}

/**
 * The second pass: ObjectId to its hex string, Date to ISO text (or a date for date-only paths),
 * Decimal128 and BigInt to decimal text, Buffer to a hash of its bytes, Map to an object. Drops
 * `undefined` and ignored fields.
 */
export function convert(v: Any, shape: Shape | undefined): unknown {
  if (v === undefined || v === null) return v;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return shape?.k === 'decimal' && Number.isFinite(v) ? String(v) : v;
  if (t === 'bigint') return String(v);
  if (t !== 'object') return undefined;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    return shape?.k === 'date' && shape.dateOnly ? iso.slice(0, 10) : iso;
  }
  const bson: unknown = v._bsontype;
  if (bson === 'ObjectId' || bson === 'ObjectID') return v.toHexString();
  if (bson === 'Decimal128' || bson === 'Long' || bson === 'Timestamp') return v.toString();
  if (bson === 'Int32' || bson === 'Double') return v.valueOf();
  if (bson === 'Binary') {
    const bytes: Uint8Array = v.buffer instanceof Uint8Array ? v.buffer : v.value?.(true) ?? new Uint8Array();
    return v.sub_type === 4 || shape?.k === 'uuid' ? uuidText(bytes) : bytesMarker(bytes);
  }
  if (typeof bson === 'string') return String(v);
  if (v instanceof Uint8Array) return shape?.k === 'uuid' ? uuidText(v) : bytesMarker(v);
  if (Array.isArray(v)) {
    const item = shape?.k === 'array' ? shape.item : undefined;
    return v.map((x) => {
      const c = convert(x, item);
      return c === undefined ? null : c;
    });
  }
  if (v instanceof Map) return convert(Object.fromEntries(v), shape);
  // A subdocument or document inside a Mixed value.
  if (typeof v.toObject === 'function' && v.$__ !== undefined) return convert(v.toObject(TO_OBJECT), shape);
  const object = shape?.k === 'object' ? shape : undefined;
  const out: Json = {};
  for (const key of Object.keys(v)) {
    if (object?.ignored.has(key)) continue;
    const child = object ? (object.props.get(key) ?? object.additional) : undefined;
    const c = convert(v[key], child);
    if (c !== undefined) Object.defineProperty(out, key, { value: c, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Bytes compared by a hash, so the bytes themselves are never stored. */
function bytesMarker(bytes: Uint8Array): string {
  return `bytes:${bytes.length}:sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function uuidText(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  if (hex.length !== 32) return bytesMarker(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Copies of the values Mongoose shares with the raw object it loaded: Mixed values and fields the
 * schema doesn't describe. An in-place edit to one of those would otherwise change the "before"
 * value too. Everything else Mongoose copies on load, so it is kept by reference.
 */
export function sharedValues(raw: Any, shape: Shape): [string[], unknown][] {
  const out: [string[], unknown][] = [];
  const walk = (v: Any, s: Shape | undefined, path: string[]) => {
    if (v === null || typeof v !== 'object' || v instanceof Date || v._bsontype !== undefined || v instanceof Uint8Array) return;
    if (!s || s.k === 'mixed') {
      out.push([path, convert(v, undefined)]);
      return;
    }
    if (s.k === 'array' && Array.isArray(v)) v.forEach((x, i) => walk(x, s.item, [...path, String(i)]));
    else if (s.k === 'object' && !Array.isArray(v)) {
      for (const key of Object.keys(v)) {
        if (s.ignored.has(key)) continue;
        walk(v[key], s.props.get(key) ?? s.additional, [...path, key]);
      }
    }
  };
  walk(raw, shape, []);
  return out;
}

/** Puts copied values back at their places in a converted record. */
export function restoreShared(record: Json, shared: readonly [string[], unknown][]): void {
  for (const [path, value] of shared) {
    let parent: Any = record;
    for (const segment of path.slice(0, -1)) {
      parent = parent?.[segment];
      if (parent === null || typeof parent !== 'object') break;
    }
    const key = path[path.length - 1];
    if (key !== undefined && parent !== null && typeof parent === 'object' && Object.hasOwn(parent, key)) parent[key] = value;
  }
}
