// fast-check arbitraries for Dynamic Entity records, from a config's shape, and for edits to them.
//
// Sensitive fields (password, maskData) get values that can be found later: text starting
// "S3CR3T-" and numbers from 7,000,000,000 up. The leak scan looks for exactly these.
import fc from 'fast-check';
import type { FieldShape, ObjectShape, Shape } from './shape.ts';

type Rec = Record<string, unknown>;

export const SECRET_PREFIX = 'S3CR3T-';
export const SECRET_NUMBER_MIN = 7_000_000_000;

const text = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom('Asha', 'Rose', 'Blue kurta', 'Ünïcödé', 'தமிழ்', 'a\nb', '  ', ''),
);
const secretText = fc.string({ minLength: 1, maxLength: 8, unit: fc.constantFrom(...'abcdefghij0123456789') }).map((s) => `${SECRET_PREFIX}${s}`);
const secretNumber = fc.integer({ min: 0, max: 999_999 }).map((n) => SECRET_NUMBER_MIN + n);
const number = fc.oneof(fc.integer({ min: -1000, max: 1_000_000 }), fc.integer({ min: -100000, max: 100000 }).map((n) => n / 100));
const date = fc.date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true });
const optionValues = (options: any[]) => options.map((o) => (o && typeof o === 'object' && 'value' in o ? o.value : o));

function choiceValue(field: Rec): fc.Arbitrary<unknown> {
  const values = optionValues((field['options'] as any[]) ?? []);
  if (values.length === 0) return text;
  // A copy, so a stored option is never the config's own object.
  return fc.constantFrom(...values).map((v) => (v && typeof v === 'object' ? { ...v } : v));
}

function valueOf(shape: FieldShape): fc.Arbitrary<unknown> {
  const field = shape.field;
  const type: string = field['type'];
  if (shape.sensitive) {
    if (['number', 'currency', 'slider', 'rating'].includes(type)) return secretNumber;
    if (['text', 'textarea', 'markdown', 'email', 'password', 'url', 'phone'].includes(type)) return secretText;
  }
  switch (type) {
    case 'text':
    case 'password':
      return text;
    case 'textarea':
    case 'markdown':
      return fc.array(text, { maxLength: 3 }).map((lines) => lines.join('\n'));
    case 'number':
    case 'currency':
      return number;
    case 'slider':
    case 'rating':
      return fc.integer({ min: 0, max: 5 });
    case 'email':
      return fc.emailAddress();
    case 'url':
      return fc.webUrl();
    case 'phone':
      return fc.stringMatching(/^\+\d{2} \d{3} \d{4}$/);
    case 'color':
      return fc.stringMatching(/^#[0-9a-f]{6}$/);
    case 'date':
      return date.map((d) => d.toISOString().slice(0, 10));
    case 'datetime':
      return date.map((d) => d.toISOString());
    case 'time':
      return fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    case 'monthYear':
      return date.map((d) => d.toISOString().slice(0, 7));
    case 'checkbox':
    case 'boolean':
      return fc.boolean();
    case 'dropdown':
    case 'radio':
      return choiceValue(field);
    case 'multiSelect': {
      const values = optionValues((field['options'] as any[]) ?? []);
      return fc.subarray(values).map((vs) => vs.map((v) => (v && typeof v === 'object' ? { ...v } : v)));
    }
    case 'tags':
      return fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 4 });
    case 'entity-ref':
      return fc.constantFrom('acme', 'globex', 'p1', 'p2');
    case 'image':
    case 'file':
      return fc.record({ url: fc.webUrl(), name: fc.string({ minLength: 1, maxLength: 10 }) });
    case 'group':
      return shape.inner ? objectOf(shape.inner) : fc.dictionary(fc.string({ minLength: 1, maxLength: 4 }), text, { maxKeys: 2 });
    case 'array':
      return shape.inner ? rowsOf(shape.inner) : fc.array(text, { maxLength: 3 });
    default:
      return text;
  }
}

function rowsOf(inner: ObjectShape): fc.Arbitrary<Rec[]> {
  return fc.array(rowOf(inner), { maxLength: 4 });
}

function rowOf(inner: ObjectShape): fc.Arbitrary<Rec> {
  // A v4 uuid: drawn from the seed, so a failure replays exactly, and never repeated in practice.
  return fc.tuple(fc.uuid({ version: 4 }), objectOf(inner)).map(([id, row]) => ({ $rowId: id, ...row }));
}

function objectOf(shape: ObjectShape): fc.Arbitrary<Rec> {
  const parts: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [key, child] of shape.props) {
    parts[key] = child.kind === 'object' ? objectOf(child) : valueOf(child);
  }
  return fc.record(parts, { requiredKeys: [] });
}

/** A record of a config. */
export function recordArb(shape: ObjectShape): fc.Arbitrary<Rec> {
  return objectOf(shape);
}

/**
 * An edit: a record and a changed version of it. Each field is kept, changed or cleared; lists of
 * rows lose rows, are reordered, have rows edited and gain rows; an option stored as a language
 * map may be renamed under the same $key. `legacy` strips every $rowId from both versions, as
 * records saved by 3.1 had none.
 */
export function editArb(shape: ObjectShape): fc.Arbitrary<{ before: Rec; after: Rec; legacy: boolean }> {
  return fc
    .tuple(recordArb(shape), fc.boolean(), fc.integer({ min: 0, max: 9 }))
    .chain(([before, legacyFlip, legacyRoll]) =>
      editObject(shape, before).map((after) => {
        const legacy = legacyFlip && legacyRoll === 0;
        return legacy ? { before: stripRowIds(before), after: stripRowIds(after), legacy } : { before, after, legacy };
      }),
    );
}

/** An edit of a given record, such as a demo seed. */
export function editFrom(shape: ObjectShape, record: Rec): fc.Arbitrary<Rec> {
  return editObject(shape, record);
}

function editObject(shape: ObjectShape, value: Rec): fc.Arbitrary<Rec> {
  const parts: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [key, child] of shape.props) parts[key] = editValue(child, value[key]);
  return fc.record(parts).map((edited) => {
    const out: Rec = {};
    for (const [k, v] of Object.entries(edited)) if (v !== undefined) out[k] = v;
    return out;
  });
}

const CLEAR = Symbol('clear');

function editValue(shape: Shape, current: unknown): fc.Arbitrary<unknown> {
  const keep = fc.constant(current);
  if (shape.kind === 'object') {
    return fc.oneof({ weight: 3, arbitrary: editObject(shape, (current as Rec) ?? {}) }, { weight: 1, arbitrary: keep });
  }
  const fresh = valueOf(shape);
  const clear = fc.constant(CLEAR).map(() => undefined);
  const options: { weight: number; arbitrary: fc.Arbitrary<unknown> }[] = [
    { weight: 5, arbitrary: keep },
    { weight: 2, arbitrary: fresh },
    { weight: 1, arbitrary: clear },
  ];
  const type = shape.field['type'];
  if (type === 'array' && shape.inner && Array.isArray(current)) {
    options.push({ weight: 4, arbitrary: editRows(shape.inner, current as Rec[]) });
  }
  if (type === 'group' && shape.inner && current && typeof current === 'object') {
    options.push({ weight: 3, arbitrary: editObject(shape.inner, current as Rec) });
  }
  if (isKeyedOption(current)) {
    options.push({ weight: 1, arbitrary: fc.constant({ ...(current as Rec), en: `${(current as Rec)['en']} (renamed)` }) });
  }
  return fc.oneof(...options);
}

function editRows(inner: ObjectShape, rows: Rec[]): fc.Arbitrary<Rec[]> {
  if (rows.length === 0) return rowsOf(inner);
  // A subset in any order: removed and reordered rows. Then each kept row may be edited, and
  // new rows may be added at the end.
  return fc
    .tuple(fc.shuffledSubarray(rows), fc.array(rowOf(inner), { maxLength: 2 }))
    .chain(([kept, added]) =>
      fc.tuple(...kept.map((row) => fc.oneof(fc.constant(row), editObject(inner, row).map((r) => ({ ...r, $rowId: row['$rowId'] })))))
        .map((edited) => [...(edited as Rec[]), ...added]),
    );
}

function isKeyedOption(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Rec)['$key'] === 'string';
}

export function stripRowIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripRowIds) as T;
  if (value && typeof value === 'object') {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) if (k !== '$rowId') out[k] = stripRowIds(v);
    return out as T;
  }
  return value;
}
