export const contactSchema = {
  title: 'Contact',
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    phone: { type: 'string', title: 'Phone' },
    email: { type: 'string', format: 'email' },
    status: {
      type: 'string',
      title: 'Status',
      oneOf: [
        { const: 'lead', title: 'Lead' },
        { const: 'active', title: 'Active customer' },
      ],
    },
    password: { type: 'string', writeOnly: true },
    address: { $ref: '#/$defs/address', title: 'Address' },
    tags: { type: 'array', items: { type: 'string', title: 'Tag' } },
    orders: {
      type: 'array',
      title: 'Orders',
      'x-key': 'id',
      'x-label': '{product}',
      items: {
        type: 'object',
        title: 'Order',
        properties: {
          id: { type: 'string' },
          product: { type: 'string', title: 'Product' },
          qty: { type: 'integer', title: 'Quantity' },
          note: { type: 'string', 'x-sensitive': true },
        },
      },
    },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  $defs: {
    address: {
      type: 'object',
      properties: { city: { type: 'string' }, pin: { type: 'string', title: 'PIN' } },
    },
  },
};

export const specBefore = {
  name: 'Rajesh Kumar', phone: '98400 11111', status: 'lead',
  orders: [{ id: 'A1', product: 'Blue kurta', qty: 2 }, { id: 'A2', product: 'Red saree', qty: 1 }],
};

export const specAfter = {
  name: 'Rajesh Kumar', phone: '98400 22222', status: 'active',
  orders: [{ id: 'A1', product: 'Blue kurta', qty: 3 }],
};
