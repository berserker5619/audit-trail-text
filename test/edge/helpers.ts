import { describeChanges, jsonSchemaAdapter, type DescribeOptions, type DiffOptions } from '../../src/index.ts';

/** An adapter for an object schema with these properties. */
export const schema = (properties: Record<string, unknown>) => jsonSchemaAdapter({ type: 'object', properties });

/** The sentences for a diff. */
export const sentences = (
  adapter: ReturnType<typeof schema>,
  before: unknown,
  after: unknown,
  options: DiffOptions & DescribeOptions = {},
) => describeChanges(before, after, adapter, options).map((s) => s.text);

/** Marks a test whose current behaviour is defensible either way. The test pins today's output. */
export const DECISION = '[needs a decision]';
/** Marks a known bug: the test asserts the right behaviour and runs as a todo until fixed. */
export const WRONG = { todo: 'wrong in 1.0.0: see the edge-case report' } as const;
