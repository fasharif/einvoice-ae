/**
 * Maps a TopFlow Hub trade order to a PINT AE invoice.
 *
 * TopFlow Hub is a portfolio project (a B2B/B2C platform built for, and with the permission
 * of, Top Flow, a UAE irrigation supplier; https://github.com/fasharif/topflow). The types
 * below mirror its Prisma `Order` (with its `Organization`), `OrderItem` and the JSON
 * address snapshot, including which fields may be null: money as DECIMAL(…, 2) strings,
 * VAT rates in basis points, integer quantities.
 *
 * TopFlow's money model (its ADR-006) computes in integer fils, applies rates in basis
 * points with half-up rounding and calculates VAT per line plus VAT on the delivery fee.
 * The mapping therefore uses `vatRounding: 'line'`, so the invoice VAT equals the VAT
 * TopFlow computed, and it reconciles every line and total before the invoice is used.
 *
 * All data below is made up. The seller is labelled as a demo and every document carries
 * the note "DEMO - not a tax invoice". This is not Top Flow's invoicing system.
 *
 * Run: npm run example:topflow
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type Address,
  type BuiltDocument,
  type Buyer,
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
export type TopFlowPaymentStatus = 'UNPAID' | 'PAID' | 'REFUNDED';

/** `OrderItem`: a snapshot of the product at order time. Money fields are DECIMAL strings. */
export interface TopFlowOrderItem {
  sku: string;
  productName: string;
  uom: TopFlowUnitOfMeasure;
  /** Net unit price after the line discount. The list price is not stored on the order. */
  unitPrice: string;
  /** Line discount in percent (0-100). */
  discountRate: string;
  quantity: number;
  /** Net line subtotal (unitPrice x quantity). */
  totalPrice: string;
  vatAmount: string;
}

/** The JSON address snapshot stored on `Order.deliveryAddress` (TopFlow's `AddressSnapshot`). */
export interface TopFlowAddressSnapshot {
  label: string;
  contactName: string;
  phoneNumber: string;
  line1: string;
  line2: string | null;
  area: string;
  city: string;
  emirate: TopFlowEmirate;
  country: string;
}

/** `Organization`: the B2B customer. Unverified organisations may lack most identifiers. */
export interface TopFlowOrganization {
  name: string;
  legalName: string | null;
  /** UAE VAT Tax Registration Number (15 digits); null when the customer is not registered. */
  trn: string | null;
  tradeLicenseNumber: string | null;
  paymentTerms: TopFlowPaymentTerms;
  email: string | null;
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
  paymentMethod: TopFlowPaymentMethod | null;
  paymentStatus: TopFlowPaymentStatus;
  purchaseOrderNumber: string | null;
  projectReference: string | null;
  /** Free-text address, always present. */
  shippingAddress: string;
  /** Structured address, present when the customer picked a saved address. */
  deliveryAddress: TopFlowAddressSnapshot | null;
  deliveredAt: string | null;
  organization: TopFlowOrganization | null;
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
  /**
   * The buyer's postal address. Defaults to the order's structured delivery address;
   * required when the order has only the free-text shipping address.
   */
  buyerAddress?: Address;
  /**
   * List prices by SKU, as decimal strings. B2B orders come from quotations, and
   * `QuotationItem.listPrice` holds them; pass them when available. Otherwise the list
   * price is recovered from the stored unit price (see `listPriceCandidates`).
   */
  listPrices?: Readonly<Record<string, string>>;
  /** Seller account that receives bank transfers. */
  payeeAccount: NonNullable<PaymentMeans['account']>;
  note?: string;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** TopFlow's line formula: unit = list - round_half_up(list x rate). */
function discountedPrice(listPriceFils: number, discountBps: number): number {
  return listPriceFils - Number(percentOf(listPriceFils, { units: BigInt(discountBps), scale: 2 }));
}

/**
 * Every list price that TopFlow's formula turns into the stored unit price, in ascending
 * order. Usually there is one. At some rates neighbouring list prices round to the same
 * unit price (at 7.5 %, both 100.06 and 100.07 give 92.56; at 99.99 % thousands give
 * 0.01). The formula rises in steps of 0 or 1 fils, so every unit price has at least one
 * candidate below a 100 % discount. A rate of 0 or 100 % gives the unit price itself.
 */
export function listPriceCandidates(unitPriceFils: number, discountRate: string): number[] {
  const discountBps = parseAmount(discountRate); // "7.50" % -> 750 basis points
  if (discountBps <= 0 || discountBps >= 10_000) return [unitPriceFils];
  const matches = (candidate: number): boolean => candidate >= 0 && discountedPrice(candidate, discountBps) === unitPriceFils;
  // The formula never decreases as the list price grows, so the matches form one run
  // around the exact inverse; find a match next to it and extend the run both ways.
  const estimate = Math.round((unitPriceFils * 10_000) / (10_000 - discountBps));
  const start = [0, -1, 1, -2, 2].map((offset) => estimate + offset).find(matches);
  if (start === undefined) return [];
  let low = start;
  let high = start;
  while (matches(low - 1)) low -= 1;
  while (matches(high + 1)) high += 1;
  return Array.from({ length: high - low + 1 }, (_, i) => low + i);
}

/** Most combinations of ambiguous list prices tried against the stored discount total. */
const MAX_COMBINATIONS = 4096;

/**
 * Chooses the list price of each line: the given list price when there is one (checked
 * against the stored unit price), the only candidate otherwise, and for lines with several
 * candidates the one combination that reproduces the order's stored discount total. It
 * throws, asking for the list prices, when no combination or more than one matches.
 */
export function resolveListPrices(order: TopFlowOrder, listPrices: Readonly<Record<string, string>> = {}): number[] {
  const choices = order.items.map((item) => {
    const unitPrice = parseAmount(item.unitPrice);
    const given = listPrices[item.sku];
    if (given !== undefined) {
      const listPrice = parseAmount(given);
      const expected = discountedPrice(listPrice, parseAmount(item.discountRate));
      if (expected !== unitPrice) {
        throw new Error(
          `List price ${given} of ${item.sku} less ${item.discountRate} % gives ${formatAmount(expected)}, not the stored ${item.unitPrice}`,
        );
      }
      return [listPrice];
    }
    const candidates = listPriceCandidates(unitPrice, item.discountRate);
    if (candidates.length === 0) throw new Error(`${item.sku} has an invalid unit price ${item.unitPrice}`);
    return candidates;
  });

  const ambiguous = choices.flatMap((candidates, index) => (candidates.length > 1 ? [index] : []));
  const first = choices.map((candidates) => candidates[0] as number);
  if (ambiguous.length === 0) return first;

  const describe = (): string =>
    ambiguous
      .map((i) => {
        const candidates = choices[i] ?? [];
        const text =
          candidates.length <= 3
            ? candidates.map((c) => formatAmount(c)).join(' or ')
            : `${candidates.length} prices from ${formatAmount(candidates[0] ?? 0)} to ${formatAmount(candidates.at(-1) ?? 0)}`;
        return `${order.items[i]?.sku} (${text})`;
      })
      .join(', ');
  const combinations = ambiguous.reduce((product, i) => product * (choices[i]?.length ?? 1), 1);
  if (combinations > MAX_COMBINATIONS) {
    throw new Error(`The list prices of ${describe()} cannot be recovered from the unit prices. Pass options.listPrices from the quotation`);
  }
  const target = parseAmount(order.discountTotal);
  const discountOf = (prices: readonly number[]): number =>
    prices.reduce((sum, price, i) => sum + (price - parseAmount(order.items[i]?.unitPrice ?? '0')) * (order.items[i]?.quantity ?? 0), 0);
  const matches: number[][] = [];
  for (let n = 0; n < combinations; n += 1) {
    // Read n as a number whose digit for each ambiguous line picks one of its candidates.
    const prices = [...first];
    let rest = n;
    for (const line of ambiguous) {
      const candidates = choices[line] as number[];
      prices[line] = candidates[rest % candidates.length] as number;
      rest = Math.floor(rest / candidates.length);
    }
    if (discountOf(prices) === target) matches.push(prices);
  }
  if (matches.length !== 1) {
    throw new Error(
      `The list prices of ${describe()} cannot be recovered from the unit prices` +
        (matches.length === 0 ? ' and the discount total' : `; ${matches.length} combinations match the discount total`) +
        '. Pass options.listPrices from the quotation',
    );
  }
  return matches[0] as number[];
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
    case null:
      throw new Error(`Order ${order.orderNumber} has no payment method; an invoice needs one (ibr-191-ae)`);
  }
}

/** The structured delivery address, if the order has one. TopFlow delivers in the UAE only. */
function snapshotAddress(order: TopFlowOrder): Address | undefined {
  const address = order.deliveryAddress;
  if (!address) return undefined;
  if (address.country !== 'AE') {
    throw new Error(`Order ${order.orderNumber} has a delivery address in ${address.country}; TopFlow addresses are in the UAE`);
  }
  return {
    street: address.line1,
    ...(address.line2 ? { additionalStreet: address.line2 } : {}),
    city: address.city,
    subdivision: EMIRATE_CODES[address.emirate],
    country: 'AE',
  };
}

/** Builds the invoice input for a delivered TopFlow B2B order. */
export function mapTopFlowOrderToInvoice(order: TopFlowOrder, options: TopFlowInvoiceOptions): InvoiceInput {
  if (order.currency !== 'AED') throw new Error(`Order ${order.orderNumber} is in ${order.currency}; TopFlow invoices are in AED`);
  if (order.vatRateBps !== 500) throw new Error(`Order ${order.orderNumber} uses a VAT rate of ${order.vatRateBps} bps; only 500 (5 %) maps to category S`);
  if (order.channel !== 'B2B') throw new Error(`Order ${order.orderNumber} is a retail order; this example maps B2B orders`);
  if (order.paymentStatus === 'REFUNDED') {
    throw new Error(`Order ${order.orderNumber} was refunded; invoice it only with a matching credit note, not from this mapping`);
  }
  const organization = order.organization;
  if (!organization) throw new Error(`Order ${order.orderNumber} has no organisation; a B2B invoice needs the buyer`);
  if (!organization.legalName) {
    throw new Error(`Organisation "${organization.name}" has no legal name (IBT-044); complete its verification in TopFlow first`);
  }

  const deliveryAddress = snapshotAddress(order);
  const buyerAddress = options.buyerAddress ?? deliveryAddress;
  if (!buyerAddress) {
    throw new Error(
      `Order ${order.orderNumber} has only a free-text shipping address ("${order.shippingAddress}"); ` +
        'pass options.buyerAddress with the emirate',
    );
  }
  const listPrices = resolveListPrices(order, options.listPrices);
  const lines: LineInput[] = order.items.map((item, i) => ({
    quantity: String(item.quantity),
    unitCode: UNIT_CODES[item.uom],
    unitPrice: parseAmount(item.unitPrice),
    grossUnitPrice: listPrices[i] as number,
    item: {
      name: item.productName,
      description: `${item.productName} (SKU ${item.sku})`,
      sellerItemId: item.sku,
    },
    tax: { category: 'S' },
  }));

  const deliveryFee = parseAmount(order.deliveryFee);
  const total = parseAmount(order.totalAmount);
  const paid = order.paymentStatus === 'PAID';
  const contact = order.deliveryAddress;

  // A buyer without a TRN is not VAT registered; PINT AE then needs only the endpoint.
  const buyer: Buyer = {
    name: organization.legalName,
    tradingName: organization.name,
    endpoint: { id: options.buyerEndpointTin },
    ...(organization.trn ? { trn: organization.trn } : {}),
    ...(organization.tradeLicenseNumber
      ? { legalRegistration: { id: organization.tradeLicenseNumber, type: 'TL' as const, authority: options.buyerLicenceAuthority } }
      : {}),
    address: buyerAddress,
    ...(contact || organization.email
      ? {
          contact: {
            ...(contact ? { name: contact.contactName, telephone: contact.phoneNumber } : {}),
            ...(organization.email ? { email: organization.email } : {}),
          },
        }
      : {}),
  };

  return {
    id: options.invoiceNumber,
    ...(options.uuid ? { uuid: options.uuid } : {}),
    issueDate: options.issueDate,
    ...(options.issueTime ? { issueTime: options.issueTime } : {}),
    ...(paid ? {} : { dueDate: addDays(options.issueDate, PAYMENT_TERM_DAYS[organization.paymentTerms]) }),
    note: options.note ?? 'DEMO - not a tax invoice',
    currency: 'AED',
    ...(order.purchaseOrderNumber
      ? { orderReference: { id: order.purchaseOrderNumber, salesOrderId: order.orderNumber } }
      : { buyerReference: order.orderNumber }),
    ...(order.projectReference ? { projectReference: order.projectReference } : {}),
    seller: options.seller,
    buyer,
    delivery: {
      ...(order.deliveredAt ? { date: order.deliveredAt.slice(0, 10) } : {}),
      ...(deliveryAddress ? { address: deliveryAddress } : {}),
      partyName: organization.name,
    },
    paymentMeans: [paymentMeansFor(order, options.payeeAccount)],
    paymentTerms: organization.paymentTerms === 'PREPAID' ? 'Prepaid' : `Net ${PAYMENT_TERM_DAYS[organization.paymentTerms]} days`,
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
  shippingAddress: 'Plot 12, Demo Villas, Demo Community, Abu Dhabi',
  deliveredAt: '2026-09-10T10:15:00.000Z',
  deliveryAddress: {
    label: 'Villa cluster B site',
    contactName: 'Demo Site Engineer',
    phoneNumber: '+971 50 000 0000',
    line1: 'Plot 12, Demo Villas',
    line2: null,
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
