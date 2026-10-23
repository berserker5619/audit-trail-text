// A config's record shape, read the way Dynamic Entity stores records: a tab nests under its id
// unless it sets flatData, sub-tabs nest under their parent, a group is an object, and an array
// with children is a list of rows keyed by $rowId.
import type { EntityFormConfig } from '@dynamic-entity/core';

export type Field = Record<string, any>;

export interface ObjectShape {
  kind: 'object';
  props: Map<string, Shape>;
}

export interface FieldShape {
  kind: 'field';
  field: Field;
  /** maskData on the field, its tab, its config, a parent group, or a password. */
  sensitive: boolean;
  /** For an array with children: its rows. For a group: its fields. */
  inner?: ObjectShape;
}

export type Shape = ObjectShape | FieldShape;

export function recordShape(config: EntityFormConfig): ObjectShape {
  const root: ObjectShape = { kind: 'object', props: new Map() };
  const walkTabs = (tabs: any[] | undefined, container: ObjectShape, masked: boolean) => {
    for (const tab of tabs ?? []) {
      if (!tab?.id) continue;
      const tabMasked = masked || !!tab.maskData;
      let target = container;
      if (!tab.flatData) {
        const existing = container.props.get(tab.id);
        target = existing?.kind === 'object' ? existing : { kind: 'object', props: new Map() };
        container.props.set(tab.id, target);
      }
      for (const field of tab.fields ?? []) if (field?.id) target.props.set(field.id, fieldShape(field, tabMasked));
      walkTabs(tab.children, target, tabMasked);
    }
  };
  walkTabs(config.tabs, root, !!config.maskData);
  return root;
}

function fieldShape(field: Field, masked: boolean): FieldShape {
  const sensitive = masked || !!field.maskData || field.type === 'password';
  const shape: FieldShape = { kind: 'field', field, sensitive };
  if ((field.type === 'group' || field.type === 'array') && Array.isArray(field.children) && field.children.length > 0) {
    const inner: ObjectShape = { kind: 'object', props: new Map() };
    for (const child of field.children) if (child?.id) inner.props.set(child.id, fieldShape(child, sensitive));
    shape.inner = inner;
  }
  return shape;
}

/** Record paths of the lists of rows, with `*` for rows: "/structures/lines/*\/parts". */
export function rowListPaths(shape: ObjectShape, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, child] of shape.props) {
    const path = `${prefix}/${key}`;
    if (child.kind === 'object') out.push(...rowListPaths(child, path));
    else if (child.inner && child.field.type === 'array') {
      out.push(path);
      out.push(...rowListPaths(child.inner, `${path}/*`));
    } else if (child.inner) out.push(...rowListPaths(child.inner, path));
  }
  return out;
}

/** Root keys that refererFields point at, which a typed schema must keep. */
export function refererRoots(config: EntityFormConfig): string[] {
  const out = new Set<string>();
  const walk = (tabs: any[] | undefined) => {
    for (const tab of tabs ?? []) {
      for (const f of tab.fields ?? []) if (typeof f?.refererField === 'string') out.add(f.refererField.split('.')[0]);
      walk(tab.children);
    }
  };
  walk(config.tabs);
  return [...out];
}
