import { describe, expect, it } from 'vitest';
import { calculateTotals } from '../../src/calculate.js';
import { CalculationError } from '../../src/errors.js';
import type { LineInput } from '../../src/model.js';
import { formatAmount } from '../../src/money.js';
import { passesLineNetAmountRule } from '../../src/xpath-emulation.js';

const line = (overrides: Partial<LineInput> = {}): LineInput => ({
  quantity: '1',
  unitCode: 'H87',
  unitPrice: 100_00,
  item: { name: 'Item', description: 'Item' },
  tax: { category: 'S' },
  ...overrides,
});

describe('line amounts', () => {
  it('multiplies quantity by the net price', () => {
    const t = calculateTotals({ currency: 'AED', lines: [line({ quantity: '10', unitPrice: 185_00 })] });
    expect(t.lines[0]?.netAmount).toBe(1850_00);
    expect(t.lines[0]?.vatAmount).toBe(92_50);
  });

  it('divides by the price base quantity and rounds once', () => {
    // 250 clamps priced at 4.50 per 10 pieces = 112.50
    const t = calculateTotals({ currency: 'AED', lines: [line({ quantity: '250', unitPrice: 4_50, priceBaseQuantity: '10' })] });
    expect(t.lines[0]?.netAmount).toBe(112_50);
  });

  it('handles fractional quantities exactly', () => {
    const t = calculateTotals({ currency: 'AED', lines: [line({ quantity: '7.25', unitPrice: 11_00 })] });
    expect(t.lines[0]?.netAmount).toBe(79_75);
  });

  it('adds line charges and subtracts line allowances, including percentage ones', () => {
    const t = calculateTotals({
      currency: 'AED',
      lines: [
        line({
          quantity: '12',
          unitPrice: 185_00,
          allowances: [{ reason: 'Rebate', percent: '5', baseAmount: 2220_00 }],
          charges: [{ reason: 'Cutting', amount: 25_00 }],
        }),
      ],
    });
    expect(t.lines[0]?.allowances[0]?.amount).toBe(111_00);
    expect(t.lines[0]?.netAmount).toBe(2220_00 - 111_00 + 25_00);
  });

  it('follows the official rule where binary rounding disagrees with decimal half-up', () => {
    // 1.05 x 36.90 = 38.745; ibr-147-ae (double arithmetic) accepts only 38.74.
    const t = calculateTotals({ currency: 'AED', lines: [line({ quantity: '1.05', unitPrice: 36_90 })] });
    expect(t.lines[0]?.netAmount).toBe(38_74);
  });

  it('rounds a percentage allowance so that ibr-131-ae accepts it', () => {
    const t = calculateTotals({
      currency: 'AED',
      lines: [line({ unitPrice: 1000_00 })],
      allowances: [{ reason: 'Discount', percent: '2.5', baseAmount: 10486_00, tax: { category: 'S' } }],
    });
    expect(t.allowances[0]?.amount).toBe(262_15);
  });

  it('refuses an explicit amount that does not match base x percent', () => {
    expect(() =>
      calculateTotals({
        currency: 'AED',
        lines: [line()],
        allowances: [{ reason: 'Discount', percent: '10', baseAmount: 100_00, amount: 11_00, tax: { category: 'S' } }],
      }),
    ).toThrow(CalculationError);
  });

  it('refuses line allowances larger than the line', () => {
    expect(() => calculateTotals({ currency: 'AED', lines: [line({ allowances: [{ reason: 'Too much', amount: 200_00 }] })] })).toThrow(
      'line allowances exceed the line amount',
    );
  });

  it('gives zero VAT for Z, O and AE lines and no VAT amount for E lines', () => {
    const t = calculateTotals({
      currency: 'AED',
      lines: [
        line({ tax: { category: 'Z' } }),
        line({ tax: { category: 'O' } }),
        line({ tax: { category: 'AE' } }),
        line({ tax: { category: 'E', exemptionReasonCode: 'DL8.46.2' } }),
      ],
    });
    expect(t.lines.map((l) => l.vatAmount)).toEqual([0, 0, 0, undefined]);
    expect(t.lines.map((l) => l.rate)).toEqual(['0', undefined, '5', undefined]);
    expect(t.taxAmount).toBe(0);
  });
});

describe('VAT breakdown', () => {
  it('groups by category, in order of first appearance, with the rates the rules require', () => {
    const t = calculateTotals({
      currency: 'AED',
      lines: [
        line({ unitPrice: 1000_00 }),
        line({ unitPrice: 500_00, tax: { category: 'Z' } }),
        line({ unitPrice: 200_00, tax: { category: 'E', exemptionReasonCode: 'DL8.46.1' } }),
        line({ unitPrice: 50_00, tax: { category: 'O' } }),
        line({ unitPrice: 300_00 }),
      ],
      charges: [{ reason: 'Freight', amount: 100_00, tax: { category: 'S' } }],
      allowances: [{ reason: 'Discount', amount: 20_00, tax: { category: 'Z' } }],
    });
    expect(t.breakdown).toEqual([
      { category: 'S', rate: '5', taxableAmount: 1400_00, taxAmount: 70_00 },
      { category: 'Z', rate: '0', taxableAmount: 480_00, taxAmount: 0 },
      { category: 'E', taxableAmount: 200_00, taxAmount: 0 },
      { category: 'O', taxableAmount: 50_00, taxAmount: 0 },
    ]);
    expect(t.lineExtensionAmount).toBe(2050_00);
    expect(t.taxExclusiveAmount).toBe(2050_00 + 100_00 - 20_00);
    expect(t.taxInclusiveAmount).toBe(t.taxExclusiveAmount + 70_00);
    expect(t.payableAmount).toBe(t.taxInclusiveAmount);
  });

  it('states 0 % on document-level E and AE items but keeps AE lines at 5 %', () => {
    const t = calculateTotals({
      currency: 'AED',
      lines: [line({ tax: { category: 'AE' } })],
      allowances: [
        { reason: 'Discount', amount: 10_00, tax: { category: 'AE' } },
        { reasonCode: '95', amount: 5_00, tax: { category: 'E' } },
      ],
      charges: [{ reason: 'Handling', amount: 20_00, tax: { category: 'E' } }],
    });
    expect(t.allowances.map((a) => a.rate)).toEqual(['0', '0']);
    expect(t.breakdown).toEqual([
      { category: 'AE', rate: '5', taxableAmount: 90_00, taxAmount: 0 },
      { category: 'E', taxableAmount: 15_00, taxAmount: 0 },
    ]);
  });

  it('refuses allowances larger than the taxable amount of a category', () => {
    expect(() =>
      calculateTotals({ currency: 'AED', lines: [line()], allowances: [{ reason: 'X', amount: 150_00, tax: { category: 'S' } }] }),
    ).toThrow('exceed the taxable amount');
  });

  it('rounds VAT once per category by default', () => {
    // Three lines of 0.10: per-line VAT rounds 0.005 up to 0.01 each (0.03),
    // the category VAT is 0.30 x 5 % = 0.015 -> 0.02.
    const lines = [line({ unitPrice: 10 }), line({ unitPrice: 10 }), line({ unitPrice: 10 })];
    expect(calculateTotals({ currency: 'AED', lines }).taxAmount).toBe(2);
    expect(calculateTotals({ currency: 'AED', lines, vatRounding: 'line' }).taxAmount).toBe(3);
  });

  it('refuses per-line rounding once it drifts more than 0.02 from the category calculation', () => {
    const lines = Array.from({ length: 6 }, () => line({ unitPrice: 10 }));
    // Per line: 6 x 0.01 = 0.06. Per category: 0.60 x 5 % = 0.03. Drift 0.03 > 0.02.
    expect(() => calculateTotals({ currency: 'AED', lines, vatRounding: 'line' })).toThrow(/aligned-ibrp-s-09|at most 0.02/);
    try {
      calculateTotals({ currency: 'AED', lines, vatRounding: 'line' });
    } catch (error) {
      expect(error).toBeInstanceOf(CalculationError);
      expect((error as CalculationError).rule).toBe('aligned-ibrp-s-09');
    }
  });
});

describe('totals and AED amounts', () => {
  it('applies prepaid and rounding amounts to the amount due', () => {
    const t = calculateTotals({ currency: 'AED', lines: [line({ unitPrice: 99_99 })], prepaidAmount: 50_00, roundingAmount: 1 });
    expect(t.taxInclusiveAmount).toBe(99_99 + 5_00);
    expect(t.payableAmount).toBe(99_99 + 5_00 - 50_00 + 1);
  });

  it('converts line and document amounts to AED for foreign-currency documents', () => {
    const t = calculateTotals({ currency: 'USD', exchangeRate: '3.6725', lines: [line({ unitPrice: 1000_00 })] });
    expect(t.lines[0]?.vatAmountAed).toBe(183_63); // 50.00 USD x 3.6725 = 183.625 -> 183.63
    expect(t.lines[0]?.payableAmountAed).toBe(3856_13); // 1050.00 x 3.6725 = 3856.125 -> 3856.13
    expect(t.aed).toEqual({ exchangeRate: '3.6725', taxAmount: 183_63, taxInclusiveAmount: 3856_13 });
  });

  it('keeps AED amounts equal to document amounts for AED documents', () => {
    const t = calculateTotals({ currency: 'AED', lines: [line()] });
    expect(t.lines[0]?.vatAmountAed).toBe(5_00);
    expect(t.lines[0]?.payableAmountAed).toBe(105_00);
    expect(t.aed).toBeUndefined();
  });
});

describe('invariants over random documents (seeded)', () => {
  // Small deterministic generator (mulberry32) so failures are reproducible.
  function random(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('holds the PINT AE totals formulas for 500 generated documents', () => {
    const next = random(20260926);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const categories = ['S', 'S', 'S', 'Z', 'O', 'AE'] as const;
    for (let doc = 0; doc < 500; doc += 1) {
      const lines: LineInput[] = Array.from({ length: 1 + Math.floor(next() * 6) }, () => {
        const scale = pick([0, 1, 2, 3]);
        const quantity = (Math.floor(next() * 5000) + 1) / 10 ** scale;
        return line({
          quantity: quantity.toFixed(scale),
          unitPrice: Math.floor(next() * 50_000),
          priceBaseQuantity: pick(['1', '1', '10', '12', '0.5']),
          tax: { category: pick(categories) },
        });
      });
      const t = calculateTotals({ currency: 'AED', lines });

      // IBT-106..115 (section 4.1.1) and the breakdown sums.
      expect(t.lineExtensionAmount).toBe(t.lines.reduce((s, l) => s + l.netAmount, 0));
      expect(t.taxExclusiveAmount).toBe(t.lineExtensionAmount);
      expect(t.taxAmount).toBe(t.breakdown.reduce((s, b) => s + b.taxAmount, 0));
      expect(t.taxInclusiveAmount).toBe(t.taxExclusiveAmount + t.taxAmount);
      expect(t.breakdown.reduce((s, b) => s + b.taxableAmount, 0)).toBe(t.taxExclusiveAmount);

      for (const [i, l] of t.lines.entries()) {
        // Every line must pass ibr-147-ae exactly as the validator evaluates it.
        expect(
          passesLineNetAmountRule({
            lineExtensionAmount: formatAmount(l.netAmount),
            quantity: l.quantity,
            priceAmount: formatAmount(l.unitPrice),
            baseQuantity: l.priceBaseQuantity,
            chargeAmounts: [],
            allowanceAmounts: [],
          }),
          `document ${doc} line ${i}`,
        ).toBe(true);
      }
      const s = t.breakdown.find((b) => b.category === 'S');
      if (s) {
        // aligned-ibrp-s-09: VAT = round(taxable x 5 %), exact in category mode.
        expect(s.taxAmount).toBe(Math.round((s.taxableAmount * 5) / 100 + 1e-9));
      }
    }
  });
});
