import { buildInvoice, DocumentLedger } from '../src/index.js';

const seller = {
  name: 'Demo Irrigation Supplies LLC',
  endpoint: { id: '1000000001' },        // TIN, Peppol scheme 0235
  trn: '100000000100003',                 // made-up TRN
  legalRegistration: { id: 'DEMO-TL-000001', type: 'TL', authority: 'Demo Licensing Authority' },
  address: { street: '1 Demo Street', city: 'Dubai', subdivision: 'DXB', country: 'AE' },
} as const;

const buyer = {
  name: 'Demo Landscaping Contractors LLC',
  endpoint: { id: '1000000002' },
  trn: '100000000200003',
  legalRegistration: { id: 'DEMO-TL-000002', type: 'TL', authority: 'Demo Licensing Authority' },
  address: { street: '2 Demo Road', city: 'Abu Dhabi', subdivision: 'AUH', country: 'AE' },
} as const;

const invoice = buildInvoice({
  id: 'INV-2026-0001',
  issueDate: '2026-09-01',
  dueDate: '2026-10-01',
  note: 'DEMO - not a tax invoice',
  currency: 'AED',
  seller,
  buyer,
  paymentMeans: [{ code: '30', account: { id: 'AE000000000000000000001' } }],
  lines: [
    {
      quantity: '10',
      unitCode: 'XRO',
      unitPrice: 185_00, // AED 185.00 in fils
      item: { name: 'Drip line 16 mm, 100 m roll', description: 'Pressure-compensating drip line' },
      tax: { category: 'S' },
    },
  ],
});

console.log(invoice.totals.taxAmount); // 9250 (AED 92.50)
const issued = await new DocumentLedger().issue(invoice);
console.log(issued.sha256); // SHA-256 of issued.xml
