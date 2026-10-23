// Storage model (A), typed: a Mongoose schema generated from a config. Tabs and groups are nested
// paths, rows are subdocuments with `_id: false` keyed by $rowId through the labels file, choices
// stored as language maps and files are Mixed.
import type { EntityFormConfig } from '@dynamic-entity/core';
import type mongoose from 'mongoose';
import { recordShape, refererRoots, rowListPaths } from './shape.ts';
import type { FieldShape, ObjectShape } from './shape.ts';

const STRING_TYPES = new Set(['text', 'textarea', 'markdown', 'email', 'password', 'date', 'datetime', 'time', 'monthYear', 'url', 'phone', 'color']);
const NUMBER_TYPES = new Set(['number', 'currency', 'slider', 'rating']);
const BOOLEAN_TYPES = new Set(['boolean', 'checkbox']);

export interface SchemaOptions {
  /** Default true. */
  timestamps?: boolean;
  /** The time timestamps use, so two runs store the same bytes. */
  clock?: () => Date;
}

function timestamps(options: SchemaOptions): boolean | { currentTime: () => Date } {
  if (options.timestamps === false) return false;
  return options.clock ? { currentTime: options.clock } : true;
}

export function typedSchema(m: typeof mongoose, config: EntityFormConfig, options: SchemaOptions = {}): mongoose.Schema {
  const { Schema } = m;
  const Mixed = Schema.Types.Mixed;
  // `$type` as the type key, so a field called "type" is a field, not a type declaration.
  const schemaOptions = { typeKey: '$type' } as const;

  const choice = (field: Record<string, any>) => {
    const options = Array.isArray(field.options) ? field.options : [];
    const coded = options.length > 0 && options.every((o: any) => o && typeof o === 'object' && 'value' in o);
    if (!coded) return Mixed;
    return typeof options[0].value === 'number' ? Number : String;
  };

  const fieldType = (shape: FieldShape): unknown => {
    const field = shape.field;
    const type: string = field.type;
    if (type === 'group') return shape.inner ? objectDefinition(shape.inner) : { $type: Mixed };
    if (type === 'array') {
      if (!shape.inner) return [Mixed];
      return [new Schema({ $rowId: { $type: String }, ...objectDefinition(shape.inner) }, { ...schemaOptions, _id: false })];
    }
    if (type === 'dropdown' || type === 'radio') return { $type: choice(field) };
    if (type === 'multiSelect') return [choice(field)];
    if (type === 'tags') return [String];
    if (type === 'file' || type === 'image' || type === 'entity-ref') return { $type: Mixed };
    if (STRING_TYPES.has(type)) return { $type: String };
    if (NUMBER_TYPES.has(type)) return { $type: Number };
    if (BOOLEAN_TYPES.has(type)) return { $type: Boolean };
    return { $type: Mixed };
  };

  // DE's password and maskData fields are sensitive in the Mongoose schema too, so the plugin's
  // own adapter never stores them either.
  const sensitive = (definition: unknown) => {
    if (Array.isArray(definition)) {
      const [item] = definition;
      return [item instanceof Schema ? item : { $type: item, auditSensitive: true }];
    }
    if (definition && typeof definition === 'object' && '$type' in definition) return { ...definition, auditSensitive: true };
    return definition;
  };
  const objectDefinition = (shape: ObjectShape): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, child] of shape.props) {
      out[key] = child.kind === 'object' ? objectDefinition(child) : child.sensitive ? sensitive(fieldType(child)) : fieldType(child);
    }
    return out;
  };

  const shape = recordShape(config);
  const definition: Record<string, unknown> = { _configVersion: { $type: Number }, ...objectDefinition(shape) };
  for (const root of refererRoots(config)) if (!(root in definition)) definition[root] = { $type: Mixed };
  return new Schema(definition, { ...schemaOptions, timestamps: timestamps(options) });
}

/** The labels file for a typed schema: every list of rows keyed by $rowId. */
export function typedLabels(config: EntityFormConfig): Record<string, string> {
  return Object.fromEntries(rowListPaths(recordShape(config)).map((path) => [`${path}#key`, '$rowId']));
}

/** Storage model (B), loose: one collection for every entity, `strict: false`. */
export function looseSchema(m: typeof mongoose, options: SchemaOptions = {}): mongoose.Schema {
  return new m.Schema({ entity: String }, { strict: false, timestamps: timestamps(options) });
}
