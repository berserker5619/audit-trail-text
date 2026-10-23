// The same logical edit, from one stored record to another, expressed through each write path.
type Rec = Record<string, any>;

export const SINGLE_PATHS = [
  'save',
  'setUnset',
  'replaceOne',
  'findOneAndReplace',
  'findOneAndUpdateAfter',
  'findOneAndUpdateBefore',
  'updateOneTopLevel',
] as const;
export type SinglePath = (typeof SINGLE_PATHS)[number];

/** Keys Mongoose or the database own: never part of an edit. */
const SYSTEM = new Set(['_id', '__v', 'createdAt', 'updatedAt']);

const isPlain = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
/** An object written as one value: a $-key choice, a file, or anything holding a $-prefixed key. */
const isLeaf = (v: Rec) => Object.keys(v).some((k) => k.startsWith('$')) || 'url' in v || Object.keys(v).length === 0;

/** $set and $unset with dotted paths down to the values that differ. */
export function dottedUpdate(before: Rec, after: Rec): { $set?: Rec; $unset?: Rec } {
  const $set: Rec = {};
  const $unset: Rec = {};
  const walk = (b: Rec, a: Rec, prefix: string) => {
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!prefix && SYSTEM.has(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const bv = b[key];
      const av = a[key];
      if (av === undefined) {
        if (bv !== undefined) $unset[path] = 1;
      } else if (isPlain(av) && isPlain(bv) && !isLeaf(av) && !isLeaf(bv)) {
        walk(bv, av, path);
      } else if (JSON.stringify(bv) !== JSON.stringify(av)) {
        $set[path] = av;
      }
    }
  };
  walk(before, after, '');
  return { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) };
}

/** $set and $unset of whole top-level keys. */
export function topLevelUpdate(before: Rec, after: Rec): { $set?: Rec; $unset?: Rec } {
  const $set: Rec = {};
  const $unset: Rec = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SYSTEM.has(key)) continue;
    if (after[key] === undefined) $unset[key] = 1;
    else $set[key] = after[key];
  }
  return { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) };
}

/** Writes `after` over the stored record `before` through one path. Returns the app's write result. */
export async function write(path: SinglePath, model: any, id: unknown, before: Rec, after: Rec): Promise<unknown> {
  const replacement = { ...after };
  for (const k of SYSTEM) delete replacement[k];
  switch (path) {
    case 'save': {
      const doc = await model.findById(id);
      doc.overwrite(replacement);
      return summary(await doc.save());
    }
    case 'setUnset': {
      const update = dottedUpdate(before, after);
      if (!update.$set && !update.$unset) return 'no update';
      return model.updateOne({ _id: id }, update);
    }
    case 'replaceOne':
      return model.replaceOne({ _id: id }, replacement);
    case 'findOneAndReplace':
      return summary(await model.findOneAndReplace({ _id: id }, replacement, { returnDocument: 'after' }));
    case 'findOneAndUpdateAfter':
      return summary(await model.findOneAndUpdate({ _id: id }, topLevelUpdate(before, after), { returnDocument: 'after' }));
    case 'findOneAndUpdateBefore':
      return summary(await model.findOneAndUpdate({ _id: id }, topLevelUpdate(before, after), { returnDocument: 'before' }));
    case 'updateOneTopLevel':
      return model.updateOne({ _id: id }, topLevelUpdate(before, after));
  }
}

/** A document result as plain data, so results from two runs can be compared. */
export function summary(doc: any): unknown {
  if (doc == null) return doc;
  const o = typeof doc.toObject === 'function' ? doc.toObject({ depopulate: true, flattenMaps: true }) : doc;
  return JSON.parse(JSON.stringify(o));
}
