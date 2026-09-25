import { describe, expect, it } from 'vitest';
import { exemptInvoiceInput, standardInvoiceInput } from '../../corpus/scenarios.js';
import {
  type CreditNoteInput,
  type InvoiceInput,
  InvoiceInputError,
  type ValidationIssue,
  buildInvoice,
  validateCreditNoteInput,
  validateInvoiceInput,
} from '../../src/index.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function invoice(change: (input: Mutable<InvoiceInput>) => void = () => undefined): InvoiceInput {
  const input = structuredClone(standardInvoiceInput());
  change(input);
  return input;
}

function creditNote(change: (input: Mutable<CreditNoteInput>) => void = () => undefined): CreditNoteInput {
  const base = standardInvoiceInput();
  const input: CreditNoteInput = {
    id: 'CN-1',
    issueDate: '2026-09-15',
    reason: 'DL8.61.1.A',
    precedingInvoices: [{ id: base.id, issueDate: base.issueDate }],
    currency: 'AED',
    seller: base.seller,
    buyer: base.buyer,
    lines: base.lines,
  };
  const copy = structuredClone(input);
  change(copy);
  return copy;
}

const rulesOf = (issues: readonly ValidationIssue[]): string[] => issues.map((i) => i.rule ?? i.code);

describe('a valid input', () => {
  it('produces no issues', () => {
    expect(validateInvoiceInput(standardInvoiceInput())).toEqual([]);
    expect(validateInvoiceInput(exemptInvoiceInput())).toEqual([]);
    expect(validateCreditNoteInput(creditNote())).toEqual([]);
  });
});

describe('checks that mirror official rules', () => {
  const cases: [string, (i: Mutable<InvoiceInput>) => void, string][] = [
    ['seller TRN format', (i) => (i.seller = { ...i.seller, trn: '100000000100004' }), 'ibr-132-ae'],
    ['buyer TRN format', (i) => (i.buyer = { ...i.buyer, trn: '12345' }), 'ibr-132-ae'],
    ['seller TIN format', (i) => (i.seller = { ...i.seller, tin: '2000000000' }), 'ibr-148-ae'],
    ['seller TRN missing on a tax invoice', (i) => (i.seller = { ...i.seller, trn: undefined as unknown as string }), 'ibr-134-ae'],
    ['emirate code', (i) => (i.seller = { ...i.seller, address: { ...i.seller.address, subdivision: 'Dubai' } }), 'ibr-128-ae'],
    ['seller city', (i) => (i.seller = { ...i.seller, address: { ...i.seller.address, city: undefined as unknown as string } }), 'ibr-143-ae'],
    ['buyer street', (i) => (i.buyer = { ...i.buyer, address: { ...i.buyer.address, street: undefined as unknown as string } }), 'ibr-144-ae'],
    ['country code', (i) => (i.buyer = { ...i.buyer, address: { ...i.buyer.address, country: 'UAE' } }), 'ibr-cl-14'],
    ['seller legal registration', (i) => (i.seller = { ...i.seller, legalRegistration: undefined as never }), 'ibr-150-ae'],
    ['licence authority', (i) => (i.seller = { ...i.seller, legalRegistration: { id: 'X', type: 'TL' } }), 'ibr-172-ae'],
    ['passport country', (i) => (i.buyer = { ...i.buyer, legalRegistration: { id: 'X', type: 'PAS' } }), 'ibr-010-ae'],
    ['registration type', (i) => (i.buyer = { ...i.buyer, legalRegistration: { id: 'X', type: 'XX' as 'TL' } }), 'ibr-183-ae'],
    ['currency code', (i) => (i.currency = 'DIRHAM'), 'ibr-cl-04'],
    ['exchange rate missing', (i) => (i.currency = 'USD'), 'ibr-159-ae'],
    ['exchange rate precision', (i) => Object.assign(i, { currency: 'USD', exchangeRate: '3.6725001' }), 'ibr-002-ae'],
    ['exchange rate on an AED invoice', (i) => (i.exchangeRate = '1'), 'ibr-077'],
    ['VAT point date after issue', (i) => (i.taxPointDate = '2026-09-02'), 'ibr-141-ae'],
    ['payment means', (i) => (i.paymentMeans = []), 'ibr-191-ae'],
    ['account for a credit transfer', (i) => (i.paymentMeans = [{ code: '30' }]), 'ibr-192-ae'],
    ['payment means code', (i) => (i.paymentMeans = [{ code: 'XX', account: { id: '1' } }]), 'ibr-cl-16'],
    ['unit code', (i) => (i.lines = [{ ...i.lines[0]!, unitCode: 'PCS' }]), 'ibr-cl-23'],
    ['item description', (i) => (i.lines = [{ ...i.lines[0]!, item: { ...i.lines[0]!.item, description: undefined as unknown as string } }]), 'ibr-125-ae'],
    ['HS code for goods', (i) => (i.lines = [{ ...i.lines[0]!, item: { name: 'X', description: 'X', type: 'G' } }]), 'ibr-184-ae'],
    ['service accounting code', (i) => (i.lines = [{ ...i.lines[0]!, item: { name: 'X', description: 'X', type: 'S' } }]), 'ibr-185-ae'],
    ['gross price below net', (i) => (i.lines = [{ ...i.lines[0]!, grossUnitPrice: 1 }]), 'ibr-083'],
    ['document allowance reason', (i) => (i.allowances = [{ amount: 1, tax: { category: 'S' } }]), 'ibr-033'],
    ['document charge amount', (i) => (i.charges = [{ reason: 'Fee', tax: { category: 'S' } }]), 'ibr-036'],
    ['line allowance reason', (i) => (i.lines = [{ ...i.lines[0]!, allowances: [{ amount: 1 }] }]), 'ibr-042'],
    ['line charge amount', (i) => (i.lines = [{ ...i.lines[0]!, charges: [{ reason: 'Fee' }] }]), 'ibr-043'],
    ['allowance base without percent', (i) => (i.allowances = [{ reason: 'X', baseAmount: 100, amount: 1, tax: { category: 'S' } }]), 'aligned-ibrp-057'],
    ['allowance reason code', (i) => (i.allowances = [{ reasonCode: 'FC', amount: 1, tax: { category: 'S' } }]), 'ibr-cl-19'],
    ['charge reason code', (i) => (i.charges = [{ reasonCode: '95', amount: 1, tax: { category: 'S' } }]), 'ibr-cl-20'],
    ['exempt charge reason code', (i) => (i.charges = [{ reason: 'Fee', amount: 1, tax: { category: 'E' } }]), 'ibr-169-ae'],
    ['exempt line reason', (i) => (i.lines = [...i.lines, { ...i.lines[0]!, id: '9', tax: { category: 'E' } as never }]), 'ibr-167-ae'],
    ['only exempt lines on a 380', (i) => (i.lines = exemptInvoiceInput().lines), 'ibr-151-ae'],
    ['free trade zone beneficiary', (i) => (i.transactionType = { freeTradeZone: true }), 'ibr-007-ae'],
    ['disclosed agent principal', (i) => (i.transactionType = { disclosedAgentBilling: true }), 'ibr-137-ae'],
    ['principal equals seller', (i) => Object.assign(i, { transactionType: { disclosedAgentBilling: true }, principalId: i.seller.trn }), 'ibr-176-ae'],
    ['summary invoice period', (i) => (i.transactionType = { summaryInvoice: true }), 'ibr-138-ae'],
    ['e-commerce delivery address', (i) => Object.assign(i, { transactionType: { eCommerce: true }, delivery: { date: '2026-09-01' } }), 'ibr-142-ae'],
    ['export delivery address', (i) => Object.assign(i, { transactionType: { exports: true }, delivery: undefined }), 'ibr-152-ae'],
    ['billing frequency', (i) => (i.invoicePeriod = { frequency: 'MONTHLY' as 'MTH' }), 'ibr-005-ae'],
    ['note for frequency OTH', (i) => Object.assign(i, { note: undefined, invoicePeriod: { frequency: 'OTH' } }), 'ibr-160-ae'],
    ['invoice period order', (i) => (i.invoicePeriod = { start: '2026-09-30', end: '2026-09-01' }), 'ibr-029'],
    ['line period inside invoice period', (i) => Object.assign(i, { invoicePeriod: { start: '2026-09-01', end: '2026-09-30' }, lines: [{ ...i.lines[0]!, period: { start: '2026-08-01' } }] }), 'ibr-085'],
    ['date format', (i) => (i.issueDate = '2026-02-30'), 'ibr-073'],
    ['time format', (i) => (i.issueTime = '9:30'), 'ibr-119'],
    ['blank text', (i) => (i.buyerReference = '   '), 'ibr-079'],
    ['at least one line', (i) => (i.lines = []), 'ibr-016'],
    ['invoice type code', (i) => (i.typeCode = '389' as '380'), 'ibr-cl-01'],
  ];

  it.each(cases)('%s', (_name, change, rule) => {
    const issues = validateInvoiceInput(invoice(change));
    expect(rulesOf(issues)).toContain(rule);
  });

  it('requires the buyer TRN, goods type and GTIN on reverse-charge lines', () => {
    const issues = validateInvoiceInput(
      invoice((i) => {
        i.buyer = { ...i.buyer, trn: undefined as unknown as string };
        i.lines = [{ ...i.lines[0]!, tax: { category: 'AE' } }];
      }),
    );
    expect(rulesOf(issues)).toEqual(expect.arrayContaining(['ibr-103-ae', 'ibr-166-ae', 'ibr-174-ae']));
  });

  it('allows only E, O and Z on out-of-scope invoices and requires the buyer registration', () => {
    const issues = validateInvoiceInput({
      ...exemptInvoiceInput(),
      buyer: { ...exemptInvoiceInput().buyer, legalRegistration: undefined as never },
      lines: [...exemptInvoiceInput().lines, { ...standardInvoiceInput().lines[0]!, id: '2' }],
    });
    expect(rulesOf(issues)).toEqual(expect.arrayContaining(['ibr-122-ae', 'ibr-136-ae']));
  });

  it('requires the predefined endpoint for a deemed supply', () => {
    const issues = validateInvoiceInput(invoice((i) => (i.transactionType = { deemedSupply: true })));
    expect(issues.map((i) => i.code)).toContain('PREDEFINED_ENDPOINT_REQUIRED');
  });

  it('rejects the profit margin scheme and category N as unsupported', () => {
    const issues = validateInvoiceInput(
      invoice((i) => {
        i.transactionType = { profitMarginScheme: true };
        i.lines = [{ ...i.lines[0]!, tax: { category: 'N' } as never }];
      }),
    );
    expect(issues.filter((i) => i.code === 'UNSUPPORTED')).toHaveLength(2);
  });

  it('reports every problem at once, each with a path', () => {
    const issues = validateInvoiceInput(
      invoice((i) => {
        i.id = '';
        i.currency = 'XYZ';
        i.lines = [{ ...i.lines[0]!, quantity: '0', unitPrice: -1 }];
      }),
    );
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['id', 'currency', 'lines[0].quantity', 'lines[0].unitPrice']));
  });

  it('detects duplicate line identifiers', () => {
    const issues = validateInvoiceInput(invoice((i) => (i.lines = [{ ...i.lines[0]!, id: 'A' }, { ...i.lines[1]!, id: 'A' }])));
    expect(issues.map((i) => i.code)).toContain('DUPLICATE_LINE_ID');
  });

  it('rejects characters that XML cannot carry', () => {
    const issues = validateInvoiceInput(invoice((i) => (i.note = 'bell \u0007')));
    expect(issues.map((i) => i.code)).toContain('INVALID_CHARACTER');
  });
});

describe('credit note checks', () => {
  it('requires a preceding invoice unless the reason is VD', () => {
    expect(rulesOf(validateCreditNoteInput(creditNote((c) => (c.precedingInvoices = []))))).toContain('ibr-055-ae');
  });

  it('follows the published ibr-055-ae: a VD credit note must not reference an invoice', () => {
    expect(rulesOf(validateCreditNoteInput(creditNote((c) => (c.reason = 'VD'))))).toContain('ibr-055-ae');
    expect(validateCreditNoteInput(creditNote((c) => Object.assign(c, { reason: 'VD', precedingInvoices: undefined })))).toEqual([]);
  });

  it('checks the reason code list and presence', () => {
    expect(rulesOf(validateCreditNoteInput(creditNote((c) => (c.reason = 'X' as 'VD'))))).toContain('ibr-001-ae');
    expect(rulesOf(validateCreditNoteInput(creditNote((c) => (c.reason = undefined as unknown as 'VD'))))).toContain('ibr-158-ae');
  });

  it('refuses invoice-only fields passed by plain JavaScript callers', () => {
    const issues = validateCreditNoteInput({ ...creditNote(), taxPointDate: '2026-09-01', dueDate: '2026-10-01' } as CreditNoteInput);
    expect(rulesOf(issues)).toEqual(expect.arrayContaining(['ibr-124-ae', 'NOT_ALLOWED']));
  });

  it('checks the credit note type code', () => {
    expect(rulesOf(validateCreditNoteInput(creditNote((c) => (c.typeCode = '380' as '381'))))).toContain('ibr-cl-01');
  });
});

describe('buildInvoice error reporting', () => {
  it('throws InvoiceInputError with the issues and a readable message', () => {
    try {
      buildInvoice(invoice((i) => (i.seller = { ...i.seller, trn: 'bad' })));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvoiceInputError);
      const e = error as InvoiceInputError;
      expect(e.issues[0]).toMatchObject({ path: 'seller.trn', code: 'INVALID_TRN', rule: 'ibr-132-ae' });
      expect(e.message).toContain('seller.trn');
    }
  });

  it('requires a due date when an amount is due (ibr-127-ae)', () => {
    expect(() => buildInvoice(invoice((i) => (i.dueDate = undefined as unknown as string)))).toThrow(/due date/);
  });

  it('does not require a due date once the invoice is fully prepaid', () => {
    const built = buildInvoice(invoice((i) => Object.assign(i, { dueDate: undefined, prepaidAmount: 3013_50 })));
    expect(built.totals.payableAmount).toBe(0);
    expect(built.xml).not.toContain('<cbc:DueDate>');
  });

  it('refuses a prepaid amount above the total', () => {
    expect(() => buildInvoice(invoice((i) => (i.prepaidAmount = 4000_00)))).toThrow(/prepaid amount exceeds/);
  });

  it('turns calculation failures into input errors that name the rule', () => {
    const lines = Array.from({ length: 6 }, (_, n) => ({ ...standardInvoiceInput().lines[0]!, id: String(n + 1), quantity: '1', unitPrice: 10 }));
    try {
      buildInvoice(invoice((i) => Object.assign(i, { lines, vatRounding: 'line' })));
      expect.unreachable();
    } catch (error) {
      expect((error as InvoiceInputError).issues[0]?.rule).toBe('aligned-ibrp-s-09');
    }
  });
});
