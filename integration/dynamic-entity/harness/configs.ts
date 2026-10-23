// The configs under test: Dynamic Entity's demo seed configs (fixtures/, from v3.3.1), and
// generated ones that cover every field type and every structure the record shape depends on.
import type { EntityFormConfig, RecordMigration } from '@dynamic-entity/core';
import testData from '../fixtures/test_data.json' with { type: 'json' };
import { IT_ASSETS_CONFIG, IT_ASSETS_RECORDS, PATIENT_INTAKE_CONFIG, PATIENT_INTAKE_RECORDS } from '../fixtures/seed-enterprise.ts';
import {
  COMPLEX_FULL_TEST_RECORDS,
  INSURANCE_CLAIMS_RECORDS,
  ORGANIZATIONS_RECORDS,
  PEOPLE_RECORDS,
  VISIT_NOTES_RECORDS,
} from '../fixtures/seed-records.ts';

type Field = Record<string, any>;
const label = (en: string, de?: string): Record<string, string> => (de ? { en, de } : { en });

export const ALL_FIELD_TYPES = [
  'text', 'textarea', 'markdown', 'number', 'currency', 'email', 'password', 'date', 'datetime', 'time', 'monthYear',
  'dropdown', 'radio', 'checkbox', 'boolean', 'multiSelect', 'entity-ref', 'group', 'array', 'image', 'file', 'url',
  'phone', 'slider', 'rating', 'color', 'tags',
] as const;

const coded = [
  { value: 'open', label: label('Open', 'Offen') },
  { value: 'paid', label: label('Paid', 'Bezahlt') },
  { value: 'shipped', label: label('Shipped', 'Versandt') },
];
const codedNumbers = [
  { value: 1, label: label('One', 'Eins') },
  { value: 2, label: label('Two', 'Zwei') },
];
/** Options authored as language maps with a `$key`: records store the map, compared by `$key`. */
export const KEYED = [
  { $key: 'red', en: 'Red', de: 'Rot' },
  { $key: 'green', en: 'Green', de: 'Grün' },
  { $key: 'blue', en: 'Blue', de: 'Blau' },
];
/** Language maps without a `$key`: compared as a whole. */
export const UNKEYED = [
  { en: 'Small', de: 'Klein' },
  { en: 'Large', de: 'Groß' },
];

/** One field of every scalar type, plus each kind of choice. */
function scalarFields(prefix = ''): any[] {
  const f = (id: string, type: string, extra: Field = {}) => ({ id: `${prefix}${id}`, type, label: label(titleOf(id), `${titleOf(id)} (de)`), ...extra });
  return [
    f('name', 'text'),
    f('notes', 'textarea'),
    f('body', 'markdown'),
    f('count', 'number'),
    f('price', 'currency'),
    f('mail', 'email'),
    f('secret', 'password'),
    f('day', 'date'),
    f('moment', 'datetime'),
    f('clock', 'time'),
    f('month', 'monthYear'),
    f('status', 'dropdown', { options: coded }),
    f('level', 'radio', { options: codedNumbers }),
    f('agree', 'checkbox'),
    f('active', 'boolean'),
    f('roles', 'multiSelect', { options: coded }),
    f('owner', 'entity-ref', { entityReference: { enabled: true, linkedEntityKey: 'people' } }),
    f('photo', 'image'),
    f('doc', 'file'),
    f('site', 'url'),
    f('tel', 'phone'),
    f('volume', 'slider', { validators: { min: 0, max: 100 } }),
    f('stars', 'rating'),
    f('tint', 'color'),
    f('labels', 'tags'),
    f('colour', 'dropdown', { options: KEYED }),
    f('palette', 'multiSelect', { options: KEYED }),
    f('size', 'radio', { options: UNKEYED }),
  ];
}

function titleOf(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Every field type, nested tabs two levels deep, a flatData tab, groups with groups and arrays
 * inside, arrays of rows with nested arrays, a refererField, and maskData on a field and a tab.
 */
export const ALL_TYPES: EntityFormConfig = {
  entity: 'allTypes',
  version: 1,
  name: label('All types', 'Alle Typen'),
  tabs: [
    {
      id: 'basics',
      label: label('Basics', 'Grundlagen'),
      fields: [
        ...scalarFields(),
        { id: 'privateNote', type: 'text', label: label('Private note', 'Private Notiz'), maskData: true },
        // Stored here; the copy at legacy.oldName is ignored.
        { id: 'mirror', type: 'text', label: label('Mirror', 'Spiegel'), refererField: 'legacy.oldName' },
      ],
    },
    {
      id: 'flat',
      label: label('Flat', 'Flach'),
      flatData: true,
      fields: [
        { id: 'flatTitle', type: 'text', label: label('Flat title', 'Flacher Titel') },
        { id: 'flatScore', type: 'number', label: label('Flat score', 'Flache Punktzahl') },
      ],
    },
    {
      id: 'outer',
      label: label('Outer', 'Außen'),
      fields: [{ id: 'outerCode', type: 'text', label: label('Outer code', 'Außencode') }],
      children: [
        {
          id: 'inner',
          label: label('Inner', 'Innen'),
          fields: [{ id: 'innerCount', type: 'number', label: label('Inner count', 'Innenzahl') }],
          children: [
            { id: 'deepest', label: label('Deepest', 'Am tiefsten'), fields: [{ id: 'deepFlag', type: 'boolean', label: label('Deep flag', 'Tiefe Flagge') }] },
          ],
        },
      ],
    },
    {
      id: 'structures',
      label: label('Structures', 'Strukturen'),
      fields: [
        {
          id: 'address',
          type: 'group',
          label: label('Address', 'Adresse'),
          children: [
            { id: 'street', type: 'text', label: label('Street', 'Straße') },
            { id: 'zip', type: 'text', label: label('Zip', 'PLZ') },
            {
              id: 'geo',
              type: 'group',
              label: label('Geo', 'Geo'),
              children: [{ id: 'lat', type: 'number', label: label('Lat', 'Breite') }],
            },
            {
              id: 'visits',
              type: 'array',
              label: label('Visits', 'Besuche'),
              children: [
                { id: 'ref', type: 'text', label: label('Ref', 'Ref') },
                { id: 'when', type: 'date', label: label('When', 'Wann') },
              ],
            },
          ],
        },
        {
          id: 'lines',
          type: 'array',
          label: label('Lines', 'Zeilen'),
          children: [
            { id: 'ref', type: 'text', label: label('Ref', 'Ref') },
            { id: 'qty', type: 'number', label: label('Quantity', 'Menge') },
            { id: 'shade', type: 'dropdown', label: label('Shade', 'Farbton'), options: KEYED },
            {
              id: 'parts',
              type: 'array',
              label: label('Parts', 'Teile'),
              children: [
                { id: 'ref', type: 'text', label: label('Ref', 'Ref') },
                { id: 'count', type: 'number', label: label('Count', 'Anzahl') },
              ],
            },
          ],
        },
        { id: 'loose', type: 'array', label: label('Loose list', 'Lose Liste') },
      ],
    },
    {
      id: 'vault',
      label: label('Vault', 'Tresor'),
      maskData: true,
      fields: [
        { id: 'pin', type: 'text', label: label('Pin', 'PIN') },
        { id: 'vaultCount', type: 'number', label: label('Vault count', 'Tresorzahl') },
      ],
    },
  ],
};

/** maskData on the whole config: every value is sensitive. */
export const MASKED: EntityFormConfig = {
  entity: 'masked',
  version: 1,
  maskData: true,
  defaultLanguage: 'de',
  name: label('Masked', 'Maskiert'),
  tabs: [{ id: 'main', label: label('Main', 'Haupt'), fields: [{ id: 'ssn', type: 'text', label: label('SSN', 'SVN') }, { id: 'score', type: 'number', label: label('Score', 'Punkte') }] }],
};

/**
 * An array of rows on a maskData tab. Dynamic Entity 3.3.1's entityAuditAdapter refuses it with
 * SENSITIVE_KEY: rows are named by their first text column, which the mask made sensitive. Kept
 * out of FIXTURES, with its own test.
 */
export const MASKED_ROWS: EntityFormConfig = {
  entity: 'maskedRows',
  version: 1,
  tabs: [
    {
      id: 'vault',
      label: label('Vault', 'Tresor'),
      maskData: true,
      fields: [{ id: 'codes', type: 'array', label: label('Codes', 'Codes'), children: [{ id: 'ref', type: 'text', label: label('Ref', 'Ref') }] }],
    },
  ],
};

/** Version 2 renames `main.oldName` to `main.newName`; the migration moves the value. */
export const RENAMED_V1: EntityFormConfig = {
  entity: 'renamed',
  version: 1,
  tabs: [{ id: 'main', label: label('Main'), fields: [{ id: 'oldName', type: 'text', label: label('Name') }, { id: 'n', type: 'number', label: label('N') }] }],
};
export const RENAMED_V2: EntityFormConfig = {
  ...RENAMED_V1,
  version: 2,
  tabs: [{ id: 'main', label: label('Main'), fields: [{ id: 'newName', type: 'text', label: label('Name') }, { id: 'n', type: 'number', label: label('N') }] }],
};
export const RENAME_MIGRATIONS: RecordMigration[] = [
  {
    from: 1,
    to: 2,
    description: 'oldName → newName',
    migrate: (record) => {
      const { oldName, ...main } = record['main'] ?? {};
      return { ...record, main: oldName === undefined ? main : { ...main, newName: oldName } };
    },
  },
];

export interface Fixture {
  config: EntityFormConfig;
  /** Records from the demo, when it has any. */
  seeds: Record<string, unknown>[];
  migrations: RecordMigration[];
}

const demos = testData as unknown as EntityFormConfig[];
const seedsFor: Record<string, Record<string, unknown>[]> = {
  organizations: ORGANIZATIONS_RECORDS,
  visitNotes: VISIT_NOTES_RECORDS,
  people: PEOPLE_RECORDS,
  complexFullTest: COMPLEX_FULL_TEST_RECORDS,
  insuranceClaims: INSURANCE_CLAIMS_RECORDS,
  patientIntake: PATIENT_INTAKE_RECORDS,
  itAssets: IT_ASSETS_RECORDS,
};

/** Every config, by entity. */
export const FIXTURES: Fixture[] = [
  ...demos.map((config) => ({ config, seeds: seedsFor[config.entity] ?? [], migrations: [] })),
  { config: PATIENT_INTAKE_CONFIG, seeds: PATIENT_INTAKE_RECORDS, migrations: [] },
  { config: IT_ASSETS_CONFIG, seeds: IT_ASSETS_RECORDS, migrations: [] },
  { config: ALL_TYPES, seeds: [], migrations: [] },
  { config: MASKED, seeds: [], migrations: [] },
  { config: RENAMED_V2, seeds: [], migrations: RENAME_MIGRATIONS },
];

export function fixture(entity: string): Fixture {
  const f = FIXTURES.find((x) => x.config.entity === entity);
  if (!f) throw new Error(`no config ${entity}`);
  return f;
}

/** Every field type the configs use, to check coverage. */
export function fieldTypes(): Set<string> {
  const out = new Set<string>();
  const walkFields = (fields: Field[] = []) => {
    for (const f of fields) {
      out.add(f.type);
      walkFields(f.children);
    }
  };
  const walkTabs = (tabs: any[] = []) => {
    for (const t of tabs) {
      walkFields(t.fields);
      walkTabs(t.children);
    }
  };
  for (const { config } of FIXTURES) walkTabs(config.tabs);
  return out;
}
