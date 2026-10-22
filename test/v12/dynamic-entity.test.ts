// A Dynamic Entity-shaped record, built by hand to the mapping in the 1.2 spec: tabs and a group as
// nested objects, an array field keyed by $rowId, localized options compared by $key, a masked field.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, diffRecords, jsonSchemaAdapter } from '../../src/index.ts';

const option = (de: string) => ({ type: 'object', 'x-atomic': true, 'x-key': '$key', 'x-label': '@lang', 'x-title': { en: de.split('|')[0], de: de.split('|')[1] } });

const schema = {
  title: 'Customer',
  'x-title': { en: 'Customer', de: 'Kunde' },
  type: 'object',
  properties: {
    general: {
      'x-title': { en: 'General', de: 'Allgemein' },
      type: 'object',
      properties: {
        name: { type: 'string', 'x-title': { en: 'Name', de: 'Name' } },
        status: option('Status|Status'),
        contact: {
          'x-title': { en: 'Contact', de: 'Kontakt' },
          type: 'object',
          properties: {
            email: { type: 'string', 'x-title': { en: 'Email', de: 'E-Mail' } },
            iban: { type: 'string', 'x-title': { en: 'IBAN', de: 'IBAN' }, 'x-sensitive': true },
          },
        },
      },
    },
    sales: {
      'x-title': { en: 'Sales', de: 'Vertrieb' },
      type: 'object',
      properties: {
        segments: { type: 'array', 'x-title': { en: 'Segments', de: 'Segmente' }, items: { ...option('Segment|Segment') } },
        since: { type: 'string', format: 'date', 'x-title': { en: 'Customer since', de: 'Kunde seit' } },
        contacts: {
          type: 'array',
          'x-title': { en: 'Contacts', de: 'Ansprechpartner' },
          'x-itemNoun': { en: 'Contact', de: 'Ansprechpartner' },
          'x-key': '$rowId',
          'x-label': '{person}',
          items: {
            type: 'object',
            properties: {
              $rowId: { type: 'string' },
              person: { type: 'string', 'x-title': { en: 'Person', de: 'Person' } },
              role: option('Role|Rolle'),
              active: { type: 'boolean', 'x-title': { en: 'Active', de: 'Aktiv' } },
            },
          },
        },
      },
    },
  },
};

const opt = (key: string, en: string, de: string) => ({ $key: key, en, de });
const before = {
  general: { name: 'Kumar Textiles', status: opt('lead', 'Lead', 'Interessent'), contact: { email: 'a@k.in', iban: 'DE00 1111' } },
  sales: {
    segments: [opt('retail', 'Retail', 'Einzelhandel')],
    since: '2026-01-15',
    contacts: [{ $rowId: 'r1', person: 'Priya', role: opt('buyer', 'Buyer', 'Einkauf'), active: true }],
  },
};
const after = {
  general: { name: 'Kumar Textiles', status: opt('active', 'Active', 'Aktiv'), contact: { email: 'b@k.in', iban: 'DE00 2222' } },
  sales: {
    segments: [opt('retail', 'Retail (store)', 'Einzelhandel'), opt('vip', 'VIP', 'VIP')],
    since: '2026-01-15',
    contacts: [
      { $rowId: 'r1', person: 'Priya', role: opt('owner', 'Owner', 'Inhaber'), active: false },
      { $rowId: 'r2', person: 'Arun', role: opt('buyer', 'Buyer', 'Einkauf'), active: true },
    ],
  },
};

const de = {
  FIELD_CHANGED: '{field}: {before} → {after}',
  'FIELD_CHANGED:redacted': '{field} geändert',
  ITEM_ADDED: '{itemNoun} {item} zu {list} hinzugefügt',
  'ITEM_ADDED:value': '{item} zu {list} hinzugefügt',
};

test('a Dynamic Entity-shaped record reads in English and German from the same stored changes', () => {
  const changes = JSON.parse(JSON.stringify(diffRecords(before, after, jsonSchemaAdapter(schema))));
  assert.deepEqual(describe(changes).map((s) => s.text), [
    'General: Status changed from Lead to Active',
    'General › Contact: Email changed from "a@k.in" to "b@k.in"',
    'General › Contact: IBAN changed',
    'Sales: VIP added to Segments',
    'Sales › Contacts › Priya: Role changed from Buyer to Owner',
    'Sales › Contacts › Priya: Active changed from Yes to No',
    'Sales: Contact "Arun" added to Contacts',
  ]);
  assert.deepEqual(describe(changes, { locale: 'de-DE', messages: de }).map((s) => s.text), [
    'Allgemein: Status: Interessent → Aktiv',
    'Allgemein › Kontakt: E-Mail: "a@k.in" → "b@k.in"',
    'Allgemein › Kontakt: IBAN geändert',
    'Vertrieb: VIP zu Segmente hinzugefügt',
    'Vertrieb › Ansprechpartner › Priya: Rolle: Einkauf → Inhaber',
    // Booleans are still English "Yes" and "No": a template function or messages handle them.
    'Vertrieb › Ansprechpartner › Priya: Aktiv: Yes → No',
    'Vertrieb: Ansprechpartner "Arun" zu Ansprechpartner hinzugefügt',
  ]);
  // The masked field never reaches a stored change.
  assert.ok(!JSON.stringify(changes).includes('DE00'));
});
