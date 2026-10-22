import { describe, diffRecords, jsonSchemaAdapter, type AdapterOptions, type DescribeOptions, type DiffOptions } from '../../src/index.ts';

/** The spec's style schema: parts containing parts, keyed by id, named by name. */
export const styleSchema = (listExtra: Record<string, unknown> = { 'x-key-scope': 'tree' }) => ({
  title: 'Style',
  type: 'object',
  properties: { parts: { $ref: '#/$defs/partList' } },
  $defs: {
    partList: { title: 'Parts', type: 'array', 'x-key': 'id', 'x-label': '{name}', ...listExtra, items: { $ref: '#/$defs/part' } },
    part: {
      title: 'Part',
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { title: 'Name', type: 'string' },
        qty: { title: 'Quantity', type: 'integer' },
        parts: { $ref: '#/$defs/partList' },
      },
    },
  },
});

type Part = { id: string; name: string; qty: number; parts?: Part[] };

/** A part named by its id. */
export const part = (id: string, qty = 1, parts?: Part[]): Part => ({ id, name: id, qty, ...(parts && { parts }) });

export const style = (...parts: Part[]) => ({ parts });

export const adapterFor = (schema: unknown, options?: AdapterOptions) => jsonSchemaAdapter(schema, options);

/** The sentences for a diff. */
export const texts = (adapter: ReturnType<typeof jsonSchemaAdapter>, before: unknown, after: unknown, options: DiffOptions & DescribeOptions = {}) =>
  describe(diffRecords(before, after, adapter, options), options).map((s) => s.text);
