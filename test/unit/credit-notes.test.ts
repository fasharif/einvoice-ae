import { describe, expect, it } from 'vitest';
import { allowancesAndChargesInput, mixedCategoriesInput, standardInvoiceInput } from '../../corpus/scenarios.js';
import { topFlowDemoInvoiceInput } from '../../examples/topflow-order.js';
import {
  type CreditNoteDetails,
  DocumentLedger,
  type DocumentTotals,
  type InvoiceInput,
  InvoiceInputError,
  type IssuedDocument,
  type LineInput,
  ROUNDING_ADJUSTMENT_REASON,
  buildCreditNote,
  buildInvoice,
  creditNoteFor,
  issueDocument,
  validateInvoiceInput,
} from '../../src/index.js';
import { Picker, randomCreditSplit, randomInvoiceInput, seededRandom } from '../support/random-documents.js';

type Lines = NonNullable<CreditNoteDetails['lines']>;

const tenAtHundredWithAllowance = (allowance: NonNullable<LineInput['allowances']>): InvoiceInput => ({
  ...standardInvoiceInput(),
  lines: [
    {
      quantity: '10',
      unitCode: 'H87',
      unitPrice: 100_00,
      allowances: allowance,
      item: { name: 'Valve box', description: 'Valve box, 10 inch' },
      tax: { category: 'S' },
    },
  ],
});

/** Issues the invoice, then one credit note per step, each continuing from the ledger. */
async function creditInSteps(input: InvoiceInput, steps: readonly Lines[]) {
  const ledger = new DocumentLedger();
  const invoice = await ledger.issue(buildInvoice(input));
  const notes: IssuedDocument[] = [];
  for (const [n, lines] of steps.entries()) {
    const alreadyCredited = await ledger.creditedQuantities(invoice.id);
    const creditNote = creditNoteFor(input, invoice, { id: `CN-${n + 1}`, issueDate: '2026-09-20', reason: 'DL8.61.1.D', alreadyCredited, lines });
    notes.push(await ledger.issue(buildCreditNote(creditNote)));
  }
  return { ledger, invoice, notes };
}

type Amount = 'lineExtensionAmount' | 'allowanceTotalAmount' | 'chargeTotalAmount' | 'taxExclusiveAmount' | 'taxAmount' | 'taxInclusiveAmount';
const AMOUNTS: readonly Amount[] = ['lineExtensionAmount', 'allowanceTotalAmount', 'chargeTotalAmount', 'taxExclusiveAmount', 'taxAmount', 'taxInclusiveAmount'];

const roundingOf = (items: readonly { amount: number; reason?: string }[]): number =>
  items.filter((a) => a.reason === ROUNDING_ADJUSTMENT_REASON).reduce((t, a) => t + a.amount, 0);

/**
 * Every total and every VAT breakdown amount of the credit notes, summed. Rounding
 * allowances and charges are counted with the line amounts they correct.
 */
function summed(notes: readonly IssuedDocument[]) {
  const totals = Object.fromEntries(AMOUNTS.map((key) => [key, notes.reduce((t, n) => t + n.totals[key], 0)]));
  for (const n of notes) {
    const charges = roundingOf(n.totals.charges);
    const allowances = roundingOf(n.totals.allowances);
    totals['lineExtensionAmount'] = (totals['lineExtensionAmount'] ?? 0) + charges - allowances;
    totals['chargeTotalAmount'] = (totals['chargeTotalAmount'] ?? 0) - charges;
    totals['allowanceTotalAmount'] = (totals['allowanceTotalAmount'] ?? 0) - allowances;
  }
  const breakdown: Record<string, { taxableAmount: number; taxAmount: number }> = {};
  for (const note of notes) {
    for (const b of note.totals.breakdown) {
      const entry = (breakdown[b.category] ??= { taxableAmount: 0, taxAmount: 0 });
      entry.taxableAmount += b.taxableAmount;
      entry.taxAmount += b.taxAmount;
    }
  }
  return { totals, breakdown };
}

function expected(totals: DocumentTotals) {
  return {
    totals: Object.fromEntries(AMOUNTS.map((key) => [key, totals[key]])),
    breakdown: Object.fromEntries(totals.breakdown.map((b) => [b.category, { taxableAmount: b.taxableAmount, taxAmount: b.taxAmount }])),
  };
}

describe('partial credit notes add up to the invoice exactly', () => {
  it('pro-rates a fixed line allowance instead of repeating it (two half credits)', async () => {
    const input = tenAtHundredWithAllowance([{ amount: 50_00, reason: 'Project discount' }]);
    const { ledger, invoice, notes } = await creditInSteps(input, [[{ lineId: '1', quantity: '5' }], [{ lineId: '1', quantity: '5' }]]);
    expect(invoice.totals.taxInclusiveAmount).toBe(997_50);
    expect(notes.map((n) => n.totals.lines[0]?.netAmount)).toEqual([475_00, 475_00]);
    expect(notes.map((n) => n.totals.taxInclusiveAmount)).toEqual([498_75, 498_75]);
    expect(notes.map((n) => n.totals.lines[0]?.allowances[0]?.amount)).toEqual([25_00, 25_00]);
    expect(await ledger.creditedAmount(invoice.id)).toBe(invoice.totals.taxInclusiveAmount);
    expect(await ledger.creditedQuantities(invoice.id)).toEqual({ '1': '10' });
    const alreadyCredited = await ledger.creditedQuantities(invoice.id);
    expect(() => creditNoteFor(input, invoice, { id: 'CN-3', issueDate: '2026-09-21', reason: 'DL8.61.1.D', alreadyCredited })).toThrow(
      /already been credited in full/,
    );
  });

  it('pro-rates a percentage line allowance and states the credited part as an amount', async () => {
    const input = tenAtHundredWithAllowance([{ percent: '12.5', baseAmount: 1_000_00, reasonCode: '95', reason: 'Discount' }]);
    const { invoice, notes } = await creditInSteps(input, [[{ lineId: '1', quantity: '3' }], [{ lineId: '1', quantity: '3' }], 'all']);
    expect(notes.map((n) => n.totals.lines[0]?.allowances[0])).toEqual([
      { isCharge: false, amount: 37_50, reasonCode: '95', reason: 'Discount' },
      { isCharge: false, amount: 37_50, reasonCode: '95', reason: 'Discount' },
      { isCharge: false, amount: 50_00, reasonCode: '95', reason: 'Discount' },
    ]);
    expect(summed(notes)).toEqual(expected(invoice.totals));
  });

  it('rounds the VAT on the cumulative amount, so two halves do not over-credit by a fil', async () => {
    // 950.20 x 5 % = 47.51; each half alone would be 475.10 x 5 % = 23.755, rounded to 23.76.
    const input: InvoiceInput = { ...standardInvoiceInput(), lines: [{ ...standardInvoiceInput().lines[0]!, quantity: '2', unitPrice: 475_10 }] };
    const { invoice, notes } = await creditInSteps(input, [[{ lineId: '1', quantity: '1' }], 'all']);
    expect(invoice.totals.taxAmount).toBe(47_51);
    expect(notes.map((n) => n.totals.taxAmount)).toEqual([23_76, 23_75]);
    expect(notes[1]?.xml).toContain('<cbc:TaxAmount currencyID="AED">23.75</cbc:TaxAmount>');
    expect(summed(notes)).toEqual(expected(invoice.totals));
  });

  it('pro-rates document-level allowances and charges by the credited share of their category', async () => {
    const input = allowancesAndChargesInput();
    const { invoice, notes } = await creditInSteps(input, [
      [{ lineId: '1', quantity: '5' }, { lineId: '2', quantity: '100' }],
      [{ lineId: '3', quantity: '2.5' }, { lineId: '4', quantity: '1' }],
      'all',
    ]);
    expect(summed(notes)).toEqual(expected(invoice.totals));
    // The S allowance and charge follow the S lines; the Z charge follows the Z line, which
    // only the last credit note credits.
    expect(notes.map((n) => n.totals.charges.map((c) => c.tax.category))).toEqual([['S'], ['S'], ['S', 'Z']]);
    expect(notes.map((n) => n.totals.allowances.map((a) => a.tax.category))).toEqual([['S'], ['S'], ['S', 'S']]);
    // 1.05 x 36.90 was invoiced as 38.74 (ADR-004). The last 0.05 alone is 1.85, so the
    // final credit note carries a one-fil rounding allowance and credits exactly 1.84.
    expect(notes[2]?.totals.lines.find((l) => l.id === '4')?.netAmount).toBe(1_85);
    expect(notes[2]?.totals.allowances.filter((a) => a.reason === ROUNDING_ADJUSTMENT_REASON)).toEqual([
      { isCharge: false, amount: 1, reason: ROUNDING_ADJUSTMENT_REASON, tax: { category: 'S' }, rate: '5' },
    ]);
  });

  it('keeps per-line VAT invoices (TopFlow, vatRounding "line") and the delivery charge exact', async () => {
    const input = topFlowDemoInvoiceInput();
    const { invoice, notes } = await creditInSteps(input, [
      [{ lineId: '1', quantity: '200' }, { lineId: '3', quantity: '10' }],
      [{ lineId: '2', quantity: '1' }],
      'all',
    ]);
    expect(summed(notes)).toEqual(expected(invoice.totals));
    expect(notes.reduce((t, n) => t + n.totals.chargeTotalAmount, 0)).toBe(150_00);
  });

  it('credits an exempt charge with its exempt lines on an out-of-scope credit note', async () => {
    const input = mixedCategoriesInput();
    const { invoice, notes } = await creditInSteps(input, [[{ lineId: '3' }], 'all']);
    expect(notes[0]?.typeCode).toBe('81');
    expect(notes[0]?.totals.charges).toMatchObject([{ amount: 150_00, tax: { category: 'E' } }]);
    expect(notes[1]?.totals.charges).toEqual([]);
    expect(summed(notes)).toEqual(expected(invoice.totals));
  });

  it('gives a whole-invoice credit note exactly the invoice amounts, without a stated VAT', () => {
    const input = allowancesAndChargesInput();
    const invoice = issueDocument(buildInvoice(input));
    const whole = creditNoteFor(input, invoice, { id: 'CN-1', issueDate: '2026-09-20', reason: 'DL8.61.1.A' });
    expect(whole.standardRatedVat).toBeUndefined();
    expect(whole.allowances).toEqual(input.allowances);
    const built = buildCreditNote(whole);
    expect(expected(built.totals)).toEqual(expected(invoice.totals));
  });

  it('holds for 150 seeded random invoices split into random partial credits', async () => {
    const p = new Picker(seededRandom(20260926));
    let checked = 0;
    for (let n = 0; n < 150; n += 1) {
      const input = randomInvoiceInput(p, n);
      const steps = randomCreditSplit(p, input);
      try {
        buildInvoice(input);
      } catch (error) {
        // Some random inputs cannot conform (for example allowances above the taxable amount).
        if (error instanceof InvoiceInputError) continue;
        throw error;
      }
      const { ledger, invoice, notes } = await creditInSteps(input, steps);
      expect(summed(notes), input.id).toEqual(expected(invoice.totals));
      const quantities = await ledger.creditedQuantities(invoice.id);
      expect(Object.keys(quantities).length, input.id).toBe(input.lines.length);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('creditNoteFor input checks', () => {
  const original = standardInvoiceInput();
  const invoice = issueDocument(buildInvoice(original));
  const details = { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.D' } as const;

  it('refuses already-credited quantities that do not fit the invoice', () => {
    expect(() => creditNoteFor(original, invoice, { ...details, alreadyCredited: { '9': '1' } })).toThrow(/names line 9/);
    expect(() => creditNoteFor(original, invoice, { ...details, alreadyCredited: { '1': '11' } })).toThrow(/alreadyCredited.1 is 11/);
    expect(() => creditNoteFor(original, invoice, { ...details, alreadyCredited: { '1': 'x' } })).toThrow(/not a decimal number/);
  });

  it('refuses an empty list of lines and a zero quantity', () => {
    expect(() => creditNoteFor(original, invoice, { ...details, lines: [] })).toThrow(/at least one line/);
    expect(() => creditNoteFor(original, invoice, { ...details, lines: [{ lineId: '1', quantity: '0' }] })).toThrow(/0 cannot be credited/);
  });

  it('refuses an input that does not reproduce the issued invoice', () => {
    const changed = { ...original, lines: [{ ...original.lines[0]!, unitPrice: 1 }, original.lines[1]!] };
    expect(() => creditNoteFor(changed, invoice, details)).toThrow(/does not reproduce invoice/);
  });

  it('continues from earlier credits when "all" is used for the rest', () => {
    const rest = creditNoteFor(original, invoice, { ...details, alreadyCredited: { '1': '4' } });
    expect(rest.lines.map((l) => [l.id, l.quantity])).toEqual([
      ['1', '6'],
      ['2', '24'],
    ]);
  });
});

describe('the stated VAT of category S', () => {
  const base = creditNoteFor(standardInvoiceInput(), issueDocument(buildInvoice(standardInvoiceInput())), {
    id: 'CN-1',
    issueDate: '2026-09-10',
    reason: 'DL8.61.1.D',
    lines: [{ lineId: '1', quantity: '2' }],
  });

  it('is accepted within 0.02 of taxable amount x 5 % and refused beyond, citing aligned-ibrp-s-09', () => {
    expect(base.standardRatedVat).toBe(18_50);
    expect(buildCreditNote({ ...base, standardRatedVat: 18_52 }).totals.taxAmount).toBe(18_52);
    try {
      buildCreditNote({ ...base, standardRatedVat: 18_53 });
      expect.unreachable();
    } catch (error) {
      expect((error as InvoiceInputError).issues[0]).toMatchObject({ path: 'standardRatedVat', code: 'VAT_ROUNDING_DRIFT', rule: 'aligned-ibrp-s-09' });
    }
  });

  it('needs standard-rated amounts, is never negative and is not used on invoices', () => {
    const exemptLine: LineInput = { ...base.lines[0]!, tax: { category: 'Z' } };
    expect(() => buildCreditNote({ ...base, lines: [exemptLine] })).toThrow(/nothing on the document is standard rated/);
    expect(() => buildCreditNote({ ...base, standardRatedVat: -1 })).toThrow(/standardRatedVat/);
    const issues = validateInvoiceInput({ ...standardInvoiceInput(), standardRatedVat: 1 } as InvoiceInput);
    expect(issues).toEqual([expect.objectContaining({ path: 'standardRatedVat', code: 'NOT_ALLOWED' })]);
  });
});
