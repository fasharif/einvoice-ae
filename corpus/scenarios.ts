/**
 * Valid corpus scenarios. Each one is built with the library and must pass the UBL 2.1
 * schema and both official PINT AE Schematron layers (see test/conformance).
 * UUIDs are fixed so that the generated XML is byte-for-byte reproducible.
 */
import {
  type BuiltDocument,
  type CreditNoteInput,
  type InvoiceInput,
  type LineInput,
  buildCreditNote,
  buildInvoice,
  creditNoteFor,
  issueDocument,
} from '../src/index.js';
import { topFlowDemoInvoiceInput } from '../examples/topflow-order.js';
import { DEMO_NOTE, demoBuyer, demoCreditTransfer, demoExportBuyer, demoSeller } from './demo-parties.js';

export interface Scenario {
  /** File name without extension. */
  readonly name: string;
  readonly description: string;
  build(): BuiltDocument;
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const dripLine: LineInput = {
  quantity: '10',
  unitCode: 'XRO',
  unitPrice: 185_00,
  item: {
    name: 'Drip line 16 mm, 100 m roll',
    description: 'Pressure-compensating drip line, 16 mm, emitters every 30 cm',
    sellerItemId: 'DEMO-DL16-100',
    type: 'G',
    hsCode: '39173900',
  },
  tax: { category: 'S' },
};

const sprinkler: LineInput = {
  quantity: '24',
  unitCode: 'H87',
  unitPrice: 42_50,
  item: {
    name: 'Pop-up sprinkler 4 inch',
    description: 'Pop-up spray sprinkler body, 4 inch rise',
    sellerItemId: 'DEMO-SPK-04',
    type: 'G',
    hsCode: '84248200',
  },
  tax: { category: 'S' },
};

/** 1. A standard-rated tax invoice in AED. */
export function standardInvoiceInput(): InvoiceInput {
  return {
    id: 'DEMO-INV-2026-0001',
    uuid: uuid(1),
    issueDate: '2026-09-01',
    issueTime: '09:30:00+04:00',
    dueDate: '2026-10-01',
    note: DEMO_NOTE,
    currency: 'AED',
    buyerReference: 'DEMO-PO-7781',
    orderReference: { id: 'DEMO-PO-7781', salesOrderId: 'DEMO-SO-2026-000123' },
    seller: demoSeller,
    buyer: demoBuyer,
    delivery: {
      date: '2026-08-30',
      address: { street: 'Plot 5, Demo Park', city: 'Abu Dhabi', subdivision: 'AUH', country: 'AE' },
    },
    paymentMeans: [demoCreditTransfer],
    paymentTerms: 'Net 30 days',
    lines: [dripLine, sprinkler],
  };
}

/** 2. A zero-rated export in US dollars to a buyer that is not on Peppol. */
function zeroRatedExportInput(): InvoiceInput {
  return {
    id: 'DEMO-INV-2026-0002',
    uuid: uuid(2),
    issueDate: '2026-09-02',
    dueDate: '2026-10-02',
    note: DEMO_NOTE,
    currency: 'USD',
    exchangeRate: '3.6725',
    transactionType: { exports: true },
    customsReference: 'DEMO-CUSTOMS-0002',
    seller: demoSeller,
    buyer: demoExportBuyer,
    delivery: {
      date: '2026-08-28',
      address: { street: '3 Demo Way', city: 'Muscat', subdivision: 'Muscat Governorate', country: 'OM' },
      incoterms: 'CIF',
    },
    paymentMeans: [demoCreditTransfer],
    lines: [
      {
        quantity: '40',
        unitCode: 'H87',
        unitPrice: 12_75,
        item: {
          name: 'Irrigation controller, 12 zones',
          description: 'Wi-Fi irrigation controller with 12 zones',
          sellerItemId: 'DEMO-CTRL-12',
          type: 'G',
          hsCode: '90328900',
          originCountry: 'AE',
        },
        tax: { category: 'Z' },
      },
      {
        quantity: '15.5',
        unitCode: 'MTR',
        unitPrice: 3_40,
        item: {
          name: 'PE pipe 32 mm',
          description: 'Polyethylene pipe, 32 mm, sold by the metre',
          sellerItemId: 'DEMO-PE32',
          type: 'G',
          hsCode: '39172100',
        },
        tax: { category: 'Z' },
      },
    ],
  };
}

/** 3. Exempt supply: residential units leased as staff housing. Only E lines, so type 480. */
export function exemptInvoiceInput(): InvoiceInput {
  return {
    id: 'DEMO-INV-2026-0003',
    uuid: uuid(3),
    typeCode: '480',
    issueDate: '2026-09-03',
    dueDate: '2026-09-10',
    note: DEMO_NOTE,
    currency: 'AED',
    invoicePeriod: { start: '2026-09-01', end: '2026-09-30', frequency: 'MTH' },
    seller: demoSeller,
    buyer: demoBuyer,
    paymentMeans: [demoCreditTransfer],
    lines: [
      {
        quantity: '3',
        unitCode: 'MON',
        unitPrice: 4_500_00,
        item: {
          name: 'Staff apartment rent',
          description: 'Rent of three residential apartments used as staff housing',
          type: 'S',
          serviceAccountingCode: 'DEMO-SAC-01',
        },
        tax: { category: 'E', exemptionReasonCode: 'DL8.46.2', exemptionReason: 'Supply of residential units' },
      },
    ],
  };
}

/** 4. One invoice with standard-rated, zero-rated, exempt and out-of-scope lines. */
function mixedCategoriesInput(): InvoiceInput {
  return {
    id: 'DEMO-INV-2026-0004',
    uuid: uuid(4),
    issueDate: '2026-09-04',
    dueDate: '2026-10-04',
    note: DEMO_NOTE,
    currency: 'AED',
    seller: demoSeller,
    buyer: demoBuyer,
    paymentMeans: [demoCreditTransfer],
    lines: [
      { ...sprinkler, quantity: '10' },
      {
        quantity: '1',
        unitCode: 'C62',
        unitPrice: 2_000_00,
        item: { name: 'International freight', description: 'Freight of goods from Jebel Ali to Salalah', type: 'S', serviceAccountingCode: 'DEMO-SAC-02' },
        tax: { category: 'Z' },
      },
      {
        quantity: '1',
        unitCode: 'MON',
        unitPrice: 3_000_00,
        item: { name: 'Staff apartment rent', description: 'Residential apartment rent for site staff' },
        tax: { category: 'E', exemptionReasonCode: 'DL8.46.2' },
      },
      {
        quantity: '1',
        unitCode: 'C62',
        unitPrice: 150_00,
        item: { name: 'Municipality permit fee (recharged)', description: 'Government permit fee paid on behalf of the buyer' },
        tax: { category: 'O' },
      },
    ],
  };
}

/** 5. Line and document-level allowances and charges, price discounts and base quantities. */
function allowancesAndChargesInput(): InvoiceInput {
  return {
    id: 'DEMO-INV-2026-0005',
    uuid: uuid(5),
    issueDate: '2026-09-05',
    dueDate: '2026-10-05',
    note: DEMO_NOTE,
    currency: 'AED',
    seller: demoSeller,
    buyer: demoBuyer,
    paymentMeans: [demoCreditTransfer],
    allowances: [
      { reasonCode: '95', reason: 'Loyalty discount', percent: '2.5', baseAmount: 3_182_00, tax: { category: 'S' } },
    ],
    charges: [
      { reasonCode: 'FC', reason: 'Delivery to site', amount: 150_00, tax: { category: 'S' } },
      { reasonCode: 'ABK', reason: 'Export packing for re-export items', amount: 40_00, tax: { category: 'Z' } },
    ],
    lines: [
      {
        ...dripLine,
        quantity: '12',
        grossUnitPrice: 200_00,
        unitPrice: 185_00,
        allowances: [{ reasonCode: '100', reason: 'Project rebate', percent: '5', baseAmount: 2_220_00 }],
        charges: [{ reasonCode: 'CG', reason: 'Cutting to length', amount: 25_00 }],
      },
      {
        quantity: '250',
        unitCode: 'H87',
        unitPrice: 4_50,
        priceBaseQuantity: '10',
        item: { name: 'Hose clamp 25 mm', description: 'Stainless steel hose clamp, priced per 10 pieces', type: 'G', hsCode: '73269098' },
        tax: { category: 'S' },
      },
      {
        quantity: '7.25',
        unitCode: 'MTR',
        unitPrice: 11_00,
        item: { name: 'Layflat hose 50 mm', description: 'Layflat discharge hose, 50 mm, cut to length', type: 'G', hsCode: '40093100' },
        tax: { category: 'S' },
      },
      {
        // 1.05 x 36.90 = 38.745: the official rule ibr-147-ae evaluates this in binary
        // floating point and accepts only 38.74 (see docs/decisions.md, ADR-004).
        quantity: '1.05',
        unitCode: 'MTQ',
        unitPrice: 36_90,
        item: { name: 'Washed sand', description: 'Washed sand for pipe bedding, per cubic metre', type: 'G', hsCode: '25059000' },
        tax: { category: 'S' },
      },
      {
        quantity: '2',
        unitCode: 'H87',
        unitPrice: 310_00,
        item: { name: 'Controller for re-export', description: 'Irrigation controller supplied for re-export', type: 'G', hsCode: '90328900' },
        tax: { category: 'Z' },
      },
    ],
  };
}

/** 7. Domestic reverse charge on electronic devices (category AE). */
function reverseChargeInput(): InvoiceInput {
  return {
    id: 'DEMO-INV-2026-0007',
    uuid: uuid(7),
    issueDate: '2026-09-07',
    dueDate: '2026-10-07',
    note: DEMO_NOTE,
    currency: 'AED',
    seller: demoSeller,
    buyer: demoBuyer,
    paymentMeans: [demoCreditTransfer],
    lines: [
      {
        quantity: '20',
        unitCode: 'H87',
        unitPrice: 1_150_00,
        item: {
          name: 'Tablet computer',
          description: 'Tablet computers for resale (reverse charge on electronic devices)',
          standardItemId: { id: '00000000000017', scheme: '0160' },
          reverseChargeGoods: 'DL8.48.8.2',
          type: 'G',
          hsCode: '84713000',
        },
        tax: { category: 'AE' },
      },
    ],
  };
}

/** 10. A continuous supply billed monthly. */
function continuousSupplyInput(): InvoiceInput {
  return {
    id: 'DEMO-INV-2026-0010',
    uuid: uuid(10),
    issueDate: '2026-09-30',
    dueDate: '2026-10-30',
    note: DEMO_NOTE,
    currency: 'AED',
    transactionType: { continuousSupply: true },
    invoicePeriod: { start: '2026-09-01', end: '2026-09-30', frequency: 'MTH' },
    seller: demoSeller,
    buyer: demoBuyer,
    paymentMeans: [demoCreditTransfer],
    lines: [
      {
        quantity: '1',
        unitCode: 'MON',
        unitPrice: 1_800_00,
        item: { name: 'Irrigation maintenance contract', description: 'Monthly maintenance of irrigation systems, September 2026', type: 'S', serviceAccountingCode: 'DEMO-SAC-03' },
        tax: { category: 'S' },
        period: { start: '2026-09-01', end: '2026-09-30' },
      },
    ],
  };
}

/** 11. A supply involving a free trade zone, with the beneficiary identifier. */
function freeTradeZoneInput(): InvoiceInput {
  return {
    ...standardInvoiceInput(),
    id: 'DEMO-INV-2026-0011',
    uuid: uuid(11),
    transactionType: { freeTradeZone: true },
    beneficiaryId: '100000000500003',
    lines: [sprinkler],
  };
}

/** 12. Disclosed agent billing on behalf of a principal. */
function disclosedAgentInput(): InvoiceInput {
  return {
    ...standardInvoiceInput(),
    id: 'DEMO-INV-2026-0012',
    uuid: uuid(12),
    transactionType: { disclosedAgentBilling: true },
    principalId: '100000000600003',
    lines: [dripLine],
  };
}

/** 13. A deemed supply (goods given away without consideration): predefined endpoint, no payment. */
function deemedSupplyInput(): InvoiceInput {
  return {
    id: 'DEMO-INV-2026-0013',
    uuid: uuid(13),
    issueDate: '2026-09-13',
    note: DEMO_NOTE,
    currency: 'AED',
    transactionType: { deemedSupply: true },
    seller: demoSeller,
    buyer: { ...demoBuyer, endpoint: { id: '9900000097' } },
    lines: [{ ...sprinkler, quantity: '5' }],
  };
}

/** 14. A supply through e-commerce, with the deliver-to address. */
function eCommerceInput(): InvoiceInput {
  return {
    ...standardInvoiceInput(),
    id: 'DEMO-INV-2026-0014',
    uuid: uuid(14),
    transactionType: { eCommerce: true },
    lines: [{ ...sprinkler, quantity: '2' }],
  };
}

/** 16. A standard-rated invoice in euro, with every AED amount the UAE rules ask for. */
function foreignCurrencyInput(): InvoiceInput {
  return {
    ...standardInvoiceInput(),
    id: 'DEMO-INV-2026-0016',
    uuid: uuid(16),
    currency: 'EUR',
    exchangeRate: '4.312345',
    lines: [
      { ...dripLine, unitPrice: 43_10 },
      { ...sprinkler, unitPrice: 9_95, quantity: '13' },
    ],
  };
}

/** 6. Credit note for goods returned from the standard invoice (two of ten rolls). */
function creditNoteInput(): CreditNoteInput {
  const original = standardInvoiceInput();
  const issued = issueDocument(buildInvoice(original), { now: () => new Date('2026-09-01T05:30:00Z') });
  return creditNoteFor(original, issued, {
    id: 'DEMO-CN-2026-0001',
    uuid: uuid(6),
    issueDate: '2026-09-15',
    reason: 'DL8.61.1.D',
    note: DEMO_NOTE,
    lines: [{ lineId: '1', quantity: '2' }],
  });
}

/** 8. Volume discount credit note. Rule ibr-055-ae requires it to carry no invoice reference. */
function volumeDiscountCreditNoteInput(): CreditNoteInput {
  return {
    id: 'DEMO-CN-2026-0002',
    uuid: uuid(8),
    issueDate: '2026-09-30',
    reason: 'VD',
    note: DEMO_NOTE,
    currency: 'AED',
    invoicePeriod: { start: '2026-07-01', end: '2026-09-30' },
    seller: demoSeller,
    buyer: demoBuyer,
    lines: [
      {
        quantity: '1',
        unitCode: 'C62',
        unitPrice: 1_250_00,
        item: { name: 'Quarterly volume rebate', description: 'Rebate of 2.5 % on purchases in Q3 2026' },
        tax: { category: 'S' },
      },
    ],
  };
}

/** 15. Out-of-scope credit note (81) for part of the exempt invoice. */
function outOfScopeCreditNoteInput(): CreditNoteInput {
  const original = exemptInvoiceInput();
  const issued = issueDocument(buildInvoice(original), { now: () => new Date('2026-09-03T05:30:00Z') });
  return creditNoteFor(original, issued, {
    id: 'DEMO-CN-2026-0003',
    uuid: uuid(15),
    issueDate: '2026-09-20',
    reason: 'DL8.61.1.A',
    note: DEMO_NOTE,
    lines: [{ lineId: '1', quantity: '1' }],
  });
}

export const scenarios: readonly Scenario[] = [
  { name: 'standard-rated', description: 'Standard-rated (S, 5 %) tax invoice in AED', build: () => buildInvoice(standardInvoiceInput()) },
  { name: 'zero-rated-export', description: 'Zero-rated (Z) export in USD to a buyer outside Peppol', build: () => buildInvoice(zeroRatedExportInput()) },
  { name: 'exempt', description: 'Exempt (E) residential lease, invoice type 480', build: () => buildInvoice(exemptInvoiceInput()) },
  { name: 'mixed-categories', description: 'S, Z, E and O lines on one tax invoice', build: () => buildInvoice(mixedCategoriesInput()) },
  { name: 'allowances-and-charges', description: 'Line and document-level allowances and charges, price discount, base quantity', build: () => buildInvoice(allowancesAndChargesInput()) },
  { name: 'credit-note', description: 'Tax credit note (381) for returned goods, referencing the standard invoice', build: () => buildCreditNote(creditNoteInput()) },
  { name: 'reverse-charge', description: 'Domestic reverse charge (AE) on electronic devices', build: () => buildInvoice(reverseChargeInput()) },
  { name: 'credit-note-volume-discount', description: 'Volume discount credit note (reason VD)', build: () => buildCreditNote(volumeDiscountCreditNoteInput()) },
  { name: 'topflow-order', description: 'TopFlow-shaped B2B order mapped with per-line VAT rounding', build: () => buildInvoice(topFlowDemoInvoiceInput()) },
  { name: 'continuous-supply', description: 'Continuous supply billed monthly', build: () => buildInvoice(continuousSupplyInput()) },
  { name: 'free-trade-zone', description: 'Supply involving a free trade zone', build: () => buildInvoice(freeTradeZoneInput()) },
  { name: 'disclosed-agent', description: 'Disclosed agent billing', build: () => buildInvoice(disclosedAgentInput()) },
  { name: 'deemed-supply', description: 'Deemed supply to the predefined endpoint', build: () => buildInvoice(deemedSupplyInput()) },
  { name: 'e-commerce', description: 'Supply through e-commerce', build: () => buildInvoice(eCommerceInput()) },
  { name: 'credit-note-out-of-scope', description: 'Out-of-scope credit note (81) for part of the exempt invoice', build: () => buildCreditNote(outOfScopeCreditNoteInput()) },
  { name: 'foreign-currency', description: 'Standard-rated invoice in EUR with AED amounts', build: () => buildInvoice(foreignCurrencyInput()) },
];
