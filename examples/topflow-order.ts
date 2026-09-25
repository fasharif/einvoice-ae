/**
 * Maps a TopFlow Hub trade order to a PINT AE invoice.
 *
 * TopFlow Hub is a portfolio project (a B2B/B2C platform built for, and with the permission
 * of, Top Flow, a UAE irrigation supplier). The types below mirror its Prisma `Order`,
 * `OrderItem` and `Organization` models as the API returns them: money as DECIMAL(…, 2)
 * strings, VAT rates in basis points, integer quantities.
 *
 * TopFlow's money model (its ADR-006) computes in integer fils, applies rates in basis
 * points with half-up rounding and calculates VAT per line plus VAT on the delivery fee.
 * The mapping therefore uses `vatRounding: 'line'`, so the invoice VAT equals the VAT
 * TopFlow stored, and it reconciles every line and total before the invoice is used.
 *
 * All data below is made up. The seller is labelled as a demo and every document carries
 * the note "DEMO - not a tax invoice". This is not Top Flow's invoicing system.
 *
 * Run: npm run example:topflow
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type BuiltDocument,
  type InvoiceInput,
  type LineInput,
  type PaymentMeans,
  type Seller,
  buildInvoice,
  formatAmount,
  parseAmount,
  percentOf,
} from '../src/index.js';

// --------------------------------------------------------------------------- TopFlow shapes

export type TopFlowUnitOfMeasure = 'PIECE' | 'METER' | 'ROLL' | 'BOX' | 'SET';
export type TopFlowEmirate = 'ABU_DHABI' | 'DUBAI' | 'SHARJAH' | 'AJMAN' | 'UMM_AL_QUWAIN' | 'RAS_AL_KHAIMAH' | 'FUJAIRAH';
export type TopFlowPaymentMethod = 'CASH_ON_DELIVERY' | 'CARD' | 'BANK_TRANSFER' | 'CREDIT_ACCOUNT';
export type TopFlowPaymentTerms = 'PREPAID' | 'NET_15' | 'NET_30' | 'NET_60';

/** `OrderItem`: a snapshot of the product at order time. Money fields are DECIMAL strings. */
export interface TopFlowOrderItem {
  sku: string;
  productName: string;
  uom: TopFlowUnitOfMeasure;
  /** Net unit price after the line discount. */
  unitPrice: string;
  /** Line discount in percent (0-100). */
  discountRate: string;
  quantity: number;
  /** Net line subtotal (unitPrice x quantity). */
  totalPrice: string;
  vatAmount: string;
}

/** The JSON address snapshot stored on `Order.deliveryAddress`. */
export interface TopFlowAddressSnapshot {
  contactName: string;
  phoneNumber: string;
  line1: string;
  line2?: string;
  area: string;
  city: string;
  emirate: TopFlowEmirate;
  country: 'AE';
}

export interface TopFlowOrganization {
  legalName: string;
  name: string;
  /** UAE VAT Tax Registration Number (15 digits). */
  trn: string;
  tradeLicenseNumber: string;
  paymentTerms: TopFlowPaymentTerms;
  email?: string;
}

export interface TopFlowOrder {
  orderNumber: string;
  channel: 'RETAIL' | 'B2B';
  currency: string;
  vatRateBps: number;
  subtotal: string;
  discountTotal: string;
  deliveryFee: string;
  vatAmount: string;
  totalAmount: string;
  paymentMethod: TopFlowPaymentMethod;
  paymentStatus: 'UNPAID' | 'PAID' | 'REFUNDED';
  purchaseOrderNumber?: string;
  projectReference?: string;
  deliveryAddress: TopFlowAddressSnapshot;
  deliveredAt?: string;
  organization: TopFlowOrganization;
  items: TopFlowOrderItem[];
}

// --------------------------------------------------------------------------- mapping tables

/** TopFlow units to UN/ECE Recommendation 20 (and 21, prefixed with X) codes. */
export const UNIT_CODES: Record<TopFlowUnitOfMeasure, string> = {
  PIECE: 'H87',
  METER: 'MTR',
  ROLL: 'XRO',
  BOX: 'XBX',
  SET: 'SET',
};

/** TopFlow's Emirate enum to the subdivision codes of rule ibr-128-ae. */
export const EMIRATE_CODES: Record<TopFlowEmirate, string> = {
  ABU_DHABI: 'AUH',
  DUBAI: 'DXB',
  SHARJAH: 'SHJ',
  AJMAN: 'AJM',
  UMM_AL_QUWAIN: 'UAQ',
  RAS_AL_KHAIMAH: 'RAK',
  FUJAIRAH: 'FUJ',
};

const PAYMENT_TERM_DAYS: Record<TopFlowPaymentTerms, number> = { PREPAID: 0, NET_15: 15, NET_30: 30, NET_60: 60 };

export interface TopFlowInvoiceOptions {
  invoiceNumber: string;
  issueDate: string;
  issueTime?: string;
  uuid?: string;
  seller: Seller;
  /**
   * The buyer's Peppol endpoint (its TIN). TopFlow does not store it; a real integration
   * would look it up in the buyer's master data or the Peppol directory.
   */
  buyerEndpointTin: string;
  /** Authority that issued the buyer's trade licence (not stored by TopFlow). */
  buyerLicenceAuthority: string;
  /** Seller account that receives bank transfers. */
  payeeAccount: NonNullable<PaymentMeans['account']>;
  note?: string;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * TopFlow stores the discounted unit price and the discount rate, not the list price.
 * The list price is recovered by searching for the price that TopFlow's own formula
 * (list - round_half_up(list x rate)) turns into the stored unit price. When no price
 * matches (or the rate is 100 %), the net price is also used as the gross price and no
 * discount is shown.
 */
export function recoverListPrice(unitPriceFils: number, discountRate: string): number {
  const discountBps = parseAmount(discountRate); // "7.50" % -> 750 basis points
  if (discountBps <= 0 || discountBps >= 10_000) return unitPriceFils;
  const estimate = Math.round((unitPriceFils * 10_000) / (10_000 - discountBps));
  const rate = { units: BigInt(discountBps), scale: 2 };
  for (let candidate = estimate - 2; candidate <= estimate + 2; candidate += 1) {
    if (candidate - Number(percentOf(candidate, rate)) === unitPriceFils) return candidate;
  }
  return unitPriceFils;
}

function paymentMeansFor(order: TopFlowOrder, account: NonNullable<PaymentMeans['account']>): PaymentMeans {
  switch (order.paymentMethod) {
    case 'BANK_TRANSFER':
    case 'CREDIT_ACCOUNT':
      return { code: '30', name: 'Credit transfer', paymentId: order.orderNumber, account };
    case 'CARD':
      return { code: '48', name: 'Bank card', paymentId: order.orderNumber };
    case 'CASH_ON_DELIVERY':
      return { code: '10', name: 'In cash', paymentId: order.orderNumber };
  }
}

/** Builds the invoice input for a delivered TopFlow B2B order. */
export function mapTopFlowOrderToInvoice(order: TopFlowOrder, options: TopFlowInvoiceOptions): InvoiceInput {
  if (order.currency !== 'AED') throw new Error(`Order ${order.orderNumber} is in ${order.currency}; TopFlow invoices are in AED`);
  if (order.vatRateBps !== 500) throw new Error(`Order ${order.orderNumber} uses a VAT rate of ${order.vatRateBps} bps; only 500 (5 %) maps to category S`);
  if (order.channel !== 'B2B') throw new Error(`Order ${order.orderNumber} is a retail order; this example maps B2B orders`);

  const address = order.deliveryAddress;
  const buyerAddress = {
    street: address.line1,
    ...(address.line2 ? { additionalStreet: address.line2 } : {}),
    city: address.city,
    subdivision: EMIRATE_CODES[address.emirate],
    country: address.country,
  };

  const lines: LineInput[] = order.items.map((item) => {
    const unitPrice = parseAmount(item.unitPrice);
    const listPrice = recoverListPrice(unitPrice, item.discountRate);
    return {
      quantity: String(item.quantity),
      unitCode: UNIT_CODES[item.uom],
      unitPrice,
      grossUnitPrice: listPrice,
      item: {
        name: item.productName,
        description: `${item.productName} (SKU ${item.sku})`,
        sellerItemId: item.sku,
      },
      tax: { category: 'S' },
    };
  });

  const deliveryFee = parseAmount(order.deliveryFee);
  const total = parseAmount(order.totalAmount);
  const paid = order.paymentStatus === 'PAID';

  return {
    id: options.invoiceNumber,
    ...(options.uuid ? { uuid: options.uuid } : {}),
    issueDate: options.issueDate,
    ...(options.issueTime ? { issueTime: options.issueTime } : {}),
    ...(paid ? {} : { dueDate: addDays(options.issueDate, PAYMENT_TERM_DAYS[order.organization.paymentTerms]) }),
    note: options.note ?? 'DEMO - not a tax invoice',
    currency: 'AED',
    ...(order.purchaseOrderNumber
      ? { orderReference: { id: order.purchaseOrderNumber, salesOrderId: order.orderNumber } }
      : { buyerReference: order.orderNumber }),
    ...(order.projectReference ? { projectReference: order.projectReference } : {}),
    seller: options.seller,
    buyer: {
      name: order.organization.legalName,
      tradingName: order.organization.name,
      endpoint: { id: options.buyerEndpointTin },
      trn: order.organization.trn,
      legalRegistration: { id: order.organization.tradeLicenseNumber, type: 'TL', authority: options.buyerLicenceAuthority },
      address: buyerAddress,
      contact: { name: address.contactName, telephone: address.phoneNumber, ...(order.organization.email ? { email: order.organization.email } : {}) },
    },
    delivery: {
      ...(order.deliveredAt ? { date: order.deliveredAt.slice(0, 10) } : {}),
      address: buyerAddress,
      partyName: order.organization.name,
    },
    paymentMeans: [paymentMeansFor(order, options.payeeAccount)],
    paymentTerms: order.organization.paymentTerms === 'PREPAID' ? 'Prepaid' : `Net ${PAYMENT_TERM_DAYS[order.organization.paymentTerms]} days`,
    ...(deliveryFee > 0
      ? { charges: [{ reasonCode: 'FC', reason: 'Delivery', amount: deliveryFee, tax: { category: 'S' as const } }] }
      : {}),
    ...(paid ? { prepaidAmount: total } : {}),
    // TopFlow calculates VAT per line (its ADR-006); keep the invoice VAT identical.
    vatRounding: 'line',
    lines,
  };
}

export interface ReconciliationRow {
  field: string;
  topflow: string;
  invoice: string;
  matches: boolean;
}

/** Compares every stored TopFlow amount with the amount on the built invoice. */
export function reconcile(order: TopFlowOrder, built: BuiltDocument): ReconciliationRow[] {
  const rows: ReconciliationRow[] = [];
  const add = (field: string, topflow: string, invoiceMinor: number): void => {
    const invoice = formatAmount(invoiceMinor);
    rows.push({ field, topflow, invoice, matches: parseAmount(topflow) === invoiceMinor });
  };
  order.items.forEach((item, i) => {
    const line = built.totals.lines[i];
    if (!line) throw new Error(`Invoice has no line ${i + 1}`);
    add(`line ${i + 1} (${item.sku}) net`, item.totalPrice, line.netAmount);
    add(`line ${i + 1} (${item.sku}) VAT`, item.vatAmount, line.vatAmountAed ?? 0);
  });
  const discount = built.totals.lines.reduce((sum, l) => sum + (l.grossUnitPrice - l.unitPrice) * Number(l.quantity), 0);
  add('subtotal', order.subtotal, built.totals.lineExtensionAmount);
  add('discount total', order.discountTotal, discount);
  add('delivery fee', order.deliveryFee, built.totals.chargeTotalAmount);
  add('VAT', order.vatAmount, built.totals.taxAmount);
  add('total', order.totalAmount, built.totals.taxInclusiveAmount);
  return rows;
}

// --------------------------------------------------------------------------- demo data

/**
 * A made-up delivered B2B order. Products come from the TopFlow Hub catalogue; prices,
 * quantities and the customer are invented. The stored amounts were produced with
 * TopFlow's own `calculateTotals` (7.5 % trade discount, AED 150 delivery).
 */
export const topFlowDemoOrder: TopFlowOrder = {
  orderNumber: 'TF-SO-2026-000123',
  channel: 'B2B',
  currency: 'AED',
  vatRateBps: 500,
  subtotal: '3642.44',
  discountTotal: '296.17',
  deliveryFee: '150.00',
  vatAmount: '189.62',
  totalAmount: '3982.06',
  paymentMethod: 'CREDIT_ACCOUNT',
  paymentStatus: 'UNPAID',
  purchaseOrderNumber: 'DEMO-PO-4471',
  projectReference: 'DEMO-VILLA-CLUSTER-B',
  deliveredAt: '2026-09-10T10:15:00.000Z',
  deliveryAddress: {
    contactName: 'Demo Site Engineer',
    phoneNumber: '+971 50 000 0000',
    line1: 'Plot 12, Demo Villas',
    area: 'Demo Community',
    city: 'Abu Dhabi',
    emirate: 'ABU_DHABI',
    country: 'AE',
  },
  organization: {
    legalName: 'Demo Landscaping Contractors LLC',
    name: 'Demo Landscaping',
    trn: '100000000200003',
    tradeLicenseNumber: 'DEMO-TL-000002',
    paymentTerms: 'NET_30',
    email: 'purchasing@demo.invalid',
  },
  items: [
    { sku: 'WS-THR-F', productName: 'Thabit PC Dripline (Flat Emitter)', uom: 'METER', unitPrice: '1.34', discountRate: '7.50', quantity: 500, totalPrice: '670.00', vatAmount: '33.50' },
    { sku: 'TF-DRP-TAPE-8-30', productName: 'Drip Tape 16 mm 8 mil, 30 cm Spacing (2,000 m)', uom: 'ROLL', unitPrice: '288.60', discountRate: '7.50', quantity: 6, totalPrice: '1731.60', vatAmount: '86.58' },
    { sku: 'AX-EFS-001', productName: 'Electrofusion Reducer (63 x 32 mm)', uom: 'PIECE', unitPrice: '24.37', discountRate: '7.50', quantity: 37, totalPrice: '901.69', vatAmount: '45.08' },
    { sku: 'TF-DRP-TAPE-SC-16', productName: 'Drip Tape Start Connector with Grommet 16 mm (Box of 100)', uom: 'BOX', unitPrice: '63.73', discountRate: '7.50', quantity: 3, totalPrice: '191.19', vatAmount: '9.56' },
    { sku: 'TF-BF-13', productName: 'Ratchet Clamp Clips', uom: 'SET', unitPrice: '36.99', discountRate: '7.50', quantity: 4, totalPrice: '147.96', vatAmount: '7.40' },
  ],
};

/** The seller of the demo: a made-up registration standing in for the supplier. */
export const topFlowDemoSeller: Seller = {
  name: 'TopFlow Hub Demo Seller (portfolio project)',
  tradingName: 'TopFlow Hub demo',
  endpoint: { id: '1000000003' },
  trn: '100000000300003',
  legalRegistration: { id: 'DEMO-TL-000003', type: 'TL', authority: 'Demo Licensing Authority' },
  address: { street: '3 Demo Industrial Area', city: 'Sharjah', subdivision: 'SHJ', country: 'AE' },
};

export function topFlowDemoInvoiceInput(): InvoiceInput {
  return mapTopFlowOrderToInvoice(topFlowDemoOrder, {
    invoiceNumber: 'DEMO-TF-INV-2026-000123',
    issueDate: '2026-09-10',
    issueTime: '14:00:00+04:00',
    uuid: '00000000-0000-4000-8000-000000000009',
    seller: topFlowDemoSeller,
    buyerEndpointTin: '1000000002',
    buyerLicenceAuthority: 'Demo Licensing Authority',
    payeeAccount: { id: 'AE000000000000000000003', name: 'TopFlow Hub Demo Seller' },
  });
}

// --------------------------------------------------------------------------- run

async function main(): Promise<void> {
  const built = buildInvoice(topFlowDemoInvoiceInput());
  const rows = reconcile(topFlowDemoOrder, built);
  const width = Math.max(...rows.map((r) => r.field.length));
  console.log(`TopFlow order ${topFlowDemoOrder.orderNumber} -> invoice ${built.id} (${built.totals.lines.length} lines)\n`);
  console.log(`${'field'.padEnd(width)}  ${'TopFlow'.padStart(9)}  ${'invoice'.padStart(9)}  match`);
  for (const r of rows) console.log(`${r.field.padEnd(width)}  ${r.topflow.padStart(9)}  ${r.invoice.padStart(9)}  ${r.matches ? 'yes' : 'NO'}`);

  const outDir = fileURLToPath(new URL('./output/', import.meta.url));
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}topflow-order.xml`, built.xml);
  console.log(`\nWrote examples/output/topflow-order.xml (${Buffer.byteLength(built.xml)} bytes)`);
  if (rows.some((r) => !r.matches)) {
    console.error('Reconciliation failed: the invoice does not match the stored order.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
