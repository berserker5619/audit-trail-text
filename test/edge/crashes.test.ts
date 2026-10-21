// Crashes found in the edge-case round, and fixed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, type Change } from '../../src/index.ts';

test('describe on a change without a display block reads it as untyped instead of throwing', () => {
  // A hand-written change, or one stored by code that predates `display`.
  const change = { code: 'FIELD_CHANGED', labels: ['Phone'], before: '1', after: '2', inSchema: true } as unknown as Change;
  assert.deepEqual(describe([change]).map((s) => s.text), ['Phone changed from "1" to "2"']);
  const item = { code: 'ITEM_ADDED', labels: ['Tags'], after: 'vip', inSchema: true } as unknown as Change;
  assert.deepEqual(describe([item]).map((s) => s.text), ['"vip" added to Tags']);
});
