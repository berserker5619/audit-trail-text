// Real-record round for 1.0: a CRM contact and a garment-style PLM style, with edit scenarios.
// Each scenario starts from the base record and edits a copy. The sentences are checked in
// test/rc/sentences.json and were each read by hand (see docs/rc-feedback.md).

type Rec = Record<string, any>;

export interface Scenario {
  name: string;
  before: Rec | null;
  after: Rec | null;
}

export const crmSchema = {
  title: 'Contact',
  type: 'object',
  properties: {
    firstName: { type: 'string', title: 'First name' },
    lastName: { type: 'string', title: 'Last name' },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string', title: 'Mobile' },
    whatsappOptIn: { type: 'boolean', title: 'WhatsApp opt-in' },
    status: {
      type: 'string',
      oneOf: [
        { const: 'lead', title: 'Lead' },
        { const: 'qualified', title: 'Qualified lead' },
        { const: 'active', title: 'Active customer' },
        { const: 'churned', title: 'Churned' },
      ],
    },
    owner: { type: 'string', title: 'Account owner' },
    source: { type: 'string', enum: ['walk-in', 'instagram', 'referral'] },
    dateOfBirth: { type: 'string', format: 'date', title: 'Date of birth' },
    lastContactedAt: { type: 'string', format: 'date-time', title: 'Last contacted' },
    creditLimit: { type: 'number', title: 'Credit limit' },
    panNumber: { type: 'string', title: 'PAN', 'x-sensitive': true },
    password: { type: 'string', writeOnly: true },
    company: { $ref: '#/$defs/company' },
    tags: {
      type: 'array',
      items: { type: 'string', title: 'Tag', oneOf: [{ const: 'vip', title: 'VIP' }, { const: 'wholesale', title: 'Wholesale' }] },
    },
    addresses: {
      type: 'array',
      'x-key': 'kind',
      items: {
        type: 'object',
        title: 'Address',
        properties: {
          kind: { type: 'string', oneOf: [{ const: 'home', title: 'Home' }, { const: 'work', title: 'Work' }] },
          line1: { type: 'string', title: 'Street' },
          city: { type: 'string' },
          pin: { type: 'string', title: 'PIN code' },
        },
      },
    },
    notes: {
      type: 'array',
      'x-key': 'id',
      'x-label': '{title}',
      items: { type: 'object', title: 'Note', properties: { id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } } },
    },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  $defs: {
    company: {
      type: 'object',
      title: 'Company',
      properties: { name: { type: 'string', title: 'Company name' }, gstin: { type: 'string', title: 'GSTIN' } },
    },
  },
};

export const crmOptions = { ignore: ['/updatedAt'] };

const crmBase: Rec = {
  firstName: 'Rajesh',
  lastName: 'Kumar',
  email: 'rajesh.k@example.com',
  phone: '98400 11111',
  whatsappOptIn: false,
  status: 'lead',
  owner: 'Priya',
  source: 'walk-in',
  creditLimit: 50000,
  panNumber: 'ABCDE1234F',
  tags: ['wholesale'],
  addresses: [{ kind: 'home', line1: '12 Gandhi Road', city: 'Chennai', pin: '600017' }],
  notes: [
    { id: 'n1', title: 'First visit', body: 'Asked about bulk pricing' },
    { id: 'n2', title: 'Follow-up call', body: 'Wants samples' },
  ],
  lastContactedAt: '2026-10-01T09:30:00Z',
  updatedAt: '2026-10-01T09:30:00Z',
};

function edit(base: Rec, change: (r: Rec) => void): Scenario['after'] {
  const copy = structuredClone(base);
  change(copy);
  return copy;
}

export const crmScenarios: Scenario[] = [
  { name: 'contact details edited', before: crmBase, after: edit(crmBase, (r) => { r.phone = '98400 22222'; r.email = 'rajesh@kumartextiles.in'; }) },
  { name: 'qualified and reassigned', before: crmBase, after: edit(crmBase, (r) => { r.status = 'qualified'; r.owner = 'Arun'; r.source = 'referral'; }) },
  { name: 'tags edited', before: crmBase, after: edit(crmBase, (r) => { r.tags = ['vip']; }) },
  { name: 'work address added, home PIN fixed', before: crmBase, after: edit(crmBase, (r) => { r.addresses[0].pin = '600018'; r.addresses.push({ kind: 'work', line1: '4 Mount Road', city: 'Chennai', pin: '600002' }); }) },
  { name: 'home address removed', before: crmBase, after: edit(crmBase, (r) => { r.addresses = []; }) },
  { name: 'notes reordered and one edited', before: crmBase, after: edit(crmBase, (r) => { r.notes = [{ ...r.notes[1], body: 'Wants samples by Friday' }, r.notes[0]]; }) },
  { name: 'PAN corrected and password set', before: crmBase, after: edit(crmBase, (r) => { r.panNumber = 'ABCDE1234G'; r.password = 'hunter2'; }) },
  { name: 'dates', before: crmBase, after: edit(crmBase, (r) => { r.dateOfBirth = '1988-03-14'; r.lastContactedAt = '2026-10-21T14:05:00Z'; r.updatedAt = '2026-10-21T14:05:00Z'; }) },
  { name: 'credit and opt-in', before: crmBase, after: edit(crmBase, (r) => { r.creditLimit = 125000; r.whatsappOptIn = true; }) },
  { name: 'company added, last name cleared', before: crmBase, after: edit(crmBase, (r) => { r.company = { name: 'Kumar Textiles', gstin: '33ABCDE1234F1Z5' }; r.lastName = ''; }) },
  { name: 'field from an integration', before: { ...crmBase, zohoId: 'Z-1' }, after: { ...crmBase, zohoId: 'Z-2' } },
  { name: 'only updatedAt changed', before: crmBase, after: edit(crmBase, (r) => { r.updatedAt = '2026-10-22T00:00:00Z'; }) },
  { name: 'contact created', before: null, after: crmBase },
  { name: 'contact deleted', before: crmBase, after: null },
];

export const plmSchema = {
  title: 'Style',
  type: 'object',
  properties: {
    styleNo: { type: 'string', title: 'Style no.' },
    name: { type: 'string', title: 'Style name' },
    season: { type: 'string', enum: ['SS27', 'AW27'] },
    stage: {
      type: 'string',
      oneOf: [
        { const: 'concept', title: 'Concept' },
        { const: 'proto', title: 'Proto sample' },
        { const: 'approved', title: 'Approved for production' },
        { const: 'dropped', title: 'Dropped' },
      ],
    },
    targetFob: { type: 'number', title: 'Target FOB (USD)', 'x-sensitive': true },
    launchDate: { type: 'string', format: 'date', title: 'Launch date' },
    fabric: {
      type: 'object',
      properties: {
        composition: { type: 'string' },
        gsm: { type: 'integer', title: 'GSM' },
        mill: { type: 'string' },
      },
    },
    colourways: {
      type: 'array',
      'x-key': 'code',
      'x-label': '{name}',
      items: {
        type: 'object',
        title: 'Colourway',
        properties: {
          code: { type: 'string' },
          name: { type: 'string' },
          pantone: { type: 'string', title: 'Pantone' },
          sizes: {
            type: 'array',
            title: 'Size breakdown',
            'x-key': ['size', 'fit'],
            items: {
              type: 'object',
              title: 'Size',
              properties: { size: { type: 'string' }, fit: { type: 'string' }, qty: { type: 'integer', title: 'Quantity' } },
            },
          },
        },
      },
    },
    bom: {
      type: 'array',
      title: 'Bill of materials',
      'x-key': ['component', 'supplier'],
      'x-label': '{component} ({supplier})',
      items: {
        type: 'object',
        title: 'BOM line',
        properties: {
          component: { type: 'string' },
          supplier: { type: 'string' },
          consumption: { type: 'number' },
          unit: { type: 'string', enum: ['m', 'pcs', 'kg'] },
        },
      },
    },
  },
};

const plmBase: Rec = {
  styleNo: 'ST-1001',
  name: 'Anarkali kurta',
  season: 'SS27',
  stage: 'proto',
  targetFob: 8.5,
  launchDate: '2027-02-15',
  fabric: { composition: '100% cotton', gsm: 140, mill: 'Arvind' },
  colourways: [
    { code: 'NVY', name: 'Navy', pantone: '19-4024', sizes: [{ size: 'S', fit: 'Regular', qty: 200 }, { size: 'M', fit: 'Regular', qty: 300 }] },
    { code: 'ROS', name: 'Rose', pantone: '15-1621', sizes: [{ size: 'M', fit: 'Regular', qty: 150 }] },
  ],
  bom: [
    { component: 'Shell fabric', supplier: 'Arvind', consumption: 2.4, unit: 'm' },
    { component: 'Button', supplier: 'YKK', consumption: 6, unit: 'pcs' },
  ],
};

export const plmScenarios: Scenario[] = [
  { name: 'approved for next season', before: plmBase, after: edit(plmBase, (r) => { r.stage = 'approved'; r.season = 'AW27'; }) },
  { name: 'fabric changed', before: plmBase, after: edit(plmBase, (r) => { r.fabric.composition = '95% cotton, 5% elastane'; r.fabric.gsm = 160; }) },
  { name: 'colourway added', before: plmBase, after: edit(plmBase, (r) => { r.colourways.push({ code: 'MST', name: 'Mustard', pantone: '14-0952', sizes: [] }); }) },
  { name: 'colourway dropped', before: plmBase, after: edit(plmBase, (r) => { r.colourways = r.colourways.filter((c: Rec) => c.code !== 'ROS'); }) },
  { name: 'colourways reordered', before: plmBase, after: edit(plmBase, (r) => { r.colourways.reverse(); }) },
  { name: 'size added, quantity changed', before: plmBase, after: edit(plmBase, (r) => { r.colourways[0].sizes[1].qty = 1250; r.colourways[1].sizes.push({ size: 'L', fit: 'Slim', qty: 80 }); }) },
  { name: 'sizes reordered within a colourway', before: plmBase, after: edit(plmBase, (r) => { r.colourways[0].sizes.reverse(); }) },
  { name: 'BOM consumption changed, button supplier switched', before: plmBase, after: edit(plmBase, (r) => { r.bom[0].consumption = 2.55; r.bom[1].supplier = 'Shingora'; }) },
  { name: 'target FOB revised', before: plmBase, after: edit(plmBase, (r) => { r.targetFob = 9.1; }) },
  { name: 'launch date moved', before: plmBase, after: edit(plmBase, (r) => { r.launchDate = '2027-03-01'; }) },
  { name: 'fabric cleared, pantone renamed', before: plmBase, after: edit(plmBase, (r) => { r.fabric = null; r.colourways[1].pantone = '15-1626'; }) },
  { name: 'style dropped', before: plmBase, after: edit(plmBase, (r) => { r.stage = 'dropped'; r.launchDate = null; }) },
];
