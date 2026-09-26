import { describe, expect, it } from 'vitest';
import {
  EMIRATE_CODES,
  type TopFlowOrder,
  UNIT_CODES,
  listPriceCandidates,
  mapTopFlowOrderToInvoice,
  reconcile,
  resolveListPrices,
  topFlowDemoInvoiceInput,
  topFlowDemoOrder,
  topFlowDemoSeller,
} from '../../examples/topflow-order.js';
import { EMIRATES, UNIT_CODES as PINT_UNIT_CODES, buildInvoice, formatAmount } from '../../src/index.js';

/** TopFlow's applyRate: basis points, half-up on the absolute value (packages/shared/src/money.ts). */
const applyRate = (fils: number, bps: number): number => Math.sign(fils) * Math.round((Math.abs(fils) * bps) / 10_000);

/** A B2B order whose stored amounts come from TopFlow's own calculateLine and calculateTotals. */
function orderFromListPrices(lines: { sku: string; listPrice: number; quantity: number }[], discountBps = 750): TopFlowOrder {
  const items = lines.map(({ sku, listPrice, quantity }) => {
    const unit = listPrice - applyRate(listPrice, discountBps);
    const subtotal = unit * quantity;
    return { sku, unit, subtotal, discount: listPrice * quantity - subtotal, vat: applyRate(subtotal, 500), quantity };
  });
  const subtotal = items.reduce((t, i) => t + i.subtotal, 0);
  const vat = items.reduce((t, i) => t + i.vat, 0);
  return {
    ...topFlowDemoOrder,
    subtotal: formatAmount(subtotal),
    discountTotal: formatAmount(items.reduce((t, i) => t + i.discount, 0)),
    deliveryFee: '0.00',
    vatAmount: formatAmount(vat),
    totalAmount: formatAmount(subtotal + vat),
    items: items.map((i) => ({
      sku: i.sku,
      productName: `Demo product ${i.sku}`,
      uom: 'PIECE' as const,
      unitPrice: formatAmount(i.unit),
      discountRate: formatAmount(discountBps),
      quantity: i.quantity,
      totalPrice: formatAmount(i.subtotal),
      vatAmount: formatAmount(i.vat),
    })),
  };
}

const options = {
  invoiceNumber: 'INV-1',
  issueDate: '2026-09-10',
  seller: topFlowDemoSeller,
  buyerEndpointTin: '1000000002',
  buyerLicenceAuthority: 'Demo Licensing Authority',
  payeeAccount: { id: 'AE000000000000000000003' },
};

describe('TopFlow order mapping', () => {
  it('reproduces every stored TopFlow amount to the fil', () => {
    const rows = reconcile(topFlowDemoOrder, buildInvoice(topFlowDemoInvoiceInput()));
    expect(rows.filter((r) => !r.matches)).toEqual([]);
    expect(rows.find((r) => r.field === 'VAT')).toMatchObject({ topflow: '189.62', invoice: '189.62' });
  });

  it('maps every TopFlow unit and emirate to a code the rules accept', () => {
    for (const code of Object.values(UNIT_CODES)) expect(PINT_UNIT_CODES.has(code)).toBe(true);
    for (const code of Object.values(EMIRATE_CODES)) expect(Object.keys(EMIRATES)).toContain(code);
  });

  it('finds the list prices that TopFlow rounding turns into the stored price', () => {
    expect(listPriceCandidates(134, '7.50')).toEqual([145]); // 1.45 - round(0.10875) = 1.34
    expect(listPriceCandidates(2437, '7.50')).toEqual([2635]);
    expect(listPriceCandidates(5000, '0')).toEqual([5000]);
    const nearlyFree = listPriceCandidates(1, '99.99'); // 99.98 - round(99.97) = 0.01, and many more
    expect(nearlyFree.length).toBeGreaterThan(1000);
    expect(nearlyFree).toContain(9998);
    expect(listPriceCandidates(92_57, '7.50')).toEqual([100_08]);
    expect(listPriceCandidates(500, '100')).toEqual([500]); // a 100 % discount hides the list price
    // Two list prices round to the same unit price: 100.06 and 100.07 both give 92.56.
    expect(listPriceCandidates(92_56, '7.50')).toEqual([100_06, 100_07]);
  });

  it('settles an ambiguous list price with the stored discount total', () => {
    const order = orderFromListPrices([{ sku: 'A', listPrice: 100_07, quantity: 10 }]);
    expect(order.discountTotal).toBe('75.10');
    expect(resolveListPrices(order)).toEqual([100_07]);
    const rows = reconcile(order, buildInvoice(mapTopFlowOrderToInvoice(order, options)));
    expect(rows.filter((r) => !r.matches)).toEqual([]);
  });

  it('asks for the quotation list prices when the discount total cannot settle them', () => {
    const order = orderFromListPrices([
      { sku: 'A', listPrice: 100_06, quantity: 1 },
      { sku: 'B', listPrice: 100_07, quantity: 1 },
    ]);
    expect(() => resolveListPrices(order)).toThrow('A (100.06 or 100.07), B (100.06 or 100.07)');
    expect(() => resolveListPrices(order)).toThrow(/2 combinations match the discount total\. Pass options\.listPrices/);
    const input = mapTopFlowOrderToInvoice(order, { ...options, listPrices: { A: '100.06', B: '100.07' } });
    expect(reconcile(order, buildInvoice(input)).filter((r) => !r.matches)).toEqual([]);
    expect(() => mapTopFlowOrderToInvoice(order, { ...options, listPrices: { A: '100.10' } })).toThrow(
      'List price 100.10 of A less 7.50 % gives 92.59, not the stored 92.56',
    );
  });

  it('keeps the per-line VAT model of TopFlow (ADR-006)', () => {
    expect(topFlowDemoInvoiceInput().vatRounding).toBe('line');
  });

  it('treats a paid order as prepaid, so no amount is due and no due date is needed', () => {
    const input = mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, paymentStatus: 'PAID' }, options);
    expect(input.dueDate).toBeUndefined();
    expect(buildInvoice(input).totals.payableAmount).toBe(0);
  });

  it('uses the buyer reference when there is no purchase order', () => {
    const order = { ...topFlowDemoOrder, purchaseOrderNumber: null };
    const input = mapTopFlowOrderToInvoice(order, options);
    expect(input.orderReference).toBeUndefined();
    expect(input.buyerReference).toBe(order.orderNumber);
  });

  it('maps payment methods to UNCL 4461 codes', () => {
    const code = (paymentMethod: typeof topFlowDemoOrder.paymentMethod) =>
      mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, paymentMethod }, options).paymentMeans?.[0]?.code;
    expect(code('BANK_TRANSFER')).toBe('30');
    expect(code('CREDIT_ACCOUNT')).toBe('30');
    expect(code('CARD')).toBe('48');
    expect(code('CASH_ON_DELIVERY')).toBe('10');
  });

  it('refuses orders it cannot map', () => {
    expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, currency: 'USD' }, options)).toThrow(/in USD/);
    expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, vatRateBps: 0 }, options)).toThrow(/VAT rate/);
    expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, channel: 'RETAIL' }, options)).toThrow(/retail/);
    expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, paymentStatus: 'REFUNDED' }, options)).toThrow(/was refunded/);
    expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, status: 'CANCELLED' }, options)).toThrow(/was cancelled; there is nothing to invoice/);
    for (const status of ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'DISPATCHED'] as const) {
      expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, status, deliveredAt: null }, options), status).toThrow(
        new RegExp(`is ${status}; this example invoices delivered orders only`),
      );
    }
    expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, paymentMethod: null }, options)).toThrow(/no payment method/);
    expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, organization: null }, options)).toThrow(/no organisation/);
  });

  it('handles the fields TopFlow leaves null for an unverified organisation', () => {
    const organization = topFlowDemoOrder.organization!;
    expect(() => mapTopFlowOrderToInvoice({ ...topFlowDemoOrder, organization: { ...organization, legalName: null } }, options)).toThrow(
      /no legal name/,
    );
    // No TRN: a buyer that is not VAT registered. No licence: no legal registration (optional on a 380).
    const unregistered = { ...topFlowDemoOrder, organization: { ...organization, trn: null, tradeLicenseNumber: null, email: null } };
    const input = mapTopFlowOrderToInvoice(unregistered, options);
    expect(input.buyer.trn).toBeUndefined();
    expect(input.buyer.legalRegistration).toBeUndefined();
    expect(input.buyer.contact).toEqual({ name: 'Demo Site Engineer', telephone: '+971 50 000 0000' });
    expect(buildInvoice(input).xml).not.toContain('100000000200003');
  });

  it('needs a buyer address when the order has only the free-text shipping address', () => {
    const order = { ...topFlowDemoOrder, deliveryAddress: null };
    expect(() => mapTopFlowOrderToInvoice(order, options)).toThrow(/only a free-text shipping address .*options\.buyerAddress/);
    const buyerAddress = { street: '9 Demo Road', city: 'Abu Dhabi', subdivision: 'AUH', country: 'AE' };
    const input = mapTopFlowOrderToInvoice(order, { ...options, buyerAddress });
    expect(input.buyer.address).toEqual(buyerAddress);
    expect(input.delivery?.address).toBeUndefined();
    expect(buildInvoice(input).totals.taxInclusiveAmount).toBe(398_206);
  });
});
