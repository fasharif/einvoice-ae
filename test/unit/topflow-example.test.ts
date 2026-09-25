import { describe, expect, it } from 'vitest';
import {
  EMIRATE_CODES,
  UNIT_CODES,
  mapTopFlowOrderToInvoice,
  reconcile,
  recoverListPrice,
  topFlowDemoInvoiceInput,
  topFlowDemoOrder,
  topFlowDemoSeller,
} from '../../examples/topflow-order.js';
import { EMIRATES, UNIT_CODES as PINT_UNIT_CODES, buildInvoice } from '../../src/index.js';

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

  it('recovers the list price from the discounted price and rate using TopFlow rounding', () => {
    expect(recoverListPrice(134, '7.50')).toBe(145); // 1.45 - round(0.10875) = 1.34
    expect(recoverListPrice(2437, '7.50')).toBe(2635);
    expect(recoverListPrice(5000, '0')).toBe(5000);
    expect(recoverListPrice(1, '99.99')).toBe(9998); // 99.98 - round(99.97) = 0.01
    expect(recoverListPrice(500, '100')).toBe(500); // a 100 % discount hides the list price
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
    const { purchaseOrderNumber: _po, ...order } = topFlowDemoOrder;
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
  });
});
