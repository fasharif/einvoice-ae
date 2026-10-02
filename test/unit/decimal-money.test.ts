import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  compareDecimal,
  decimalToString,
  divideRoundHalfUp,
  fractionDigits,
  isHalfwayDivision,
  parseDecimal,
  pow10,
} from '../../src/decimal.js';
import { convertAmount, formatAmount, parseAmount, percentOf, toSafeNumber } from '../../src/money.js';

const d = (text: string) => {
  const parsed = parseDecimal(text);
  if (!parsed) throw new Error(`bad decimal ${text}`);
  return parsed;
};

describe('addDecimal', () => {
  it('adds exactly across scales', () => {
    expect(decimalToString(addDecimal(d('2.5'), d('0.75')))).toBe('3.25');
    expect(decimalToString(addDecimal(d('10'), d('-2.5')))).toBe('7.5');
    expect(addDecimal(d('0.1'), d('0.2'))).toEqual({ units: 3n, scale: 1 });
    expect(addDecimal(d('1.5'), d('-1.5'))).toEqual({ units: 0n, scale: 0 });
  });
});

describe('parseDecimal', () => {
  it.each([
    ['12', 12n, 0],
    ['0.125', 125n, 3],
    ['-3.50', -35n, 1],
    ['5.00', 5n, 0],
    ['+7', 7n, 0],
    ['  2.5 ', 25n, 1],
  ])('parses %j exactly', (text, units, scale) => {
    expect(parseDecimal(text)).toEqual({ units, scale });
  });

  it('accepts numbers that print in plain decimal notation', () => {
    expect(parseDecimal(2.5)).toEqual({ units: 25n, scale: 1 });
    expect(parseDecimal(0.1)).toEqual({ units: 1n, scale: 1 });
  });

  it.each(['', '1,5', '1e3', 'abc', '.5', '5.', '--1', 'NaN'])('rejects %j', (text) => {
    expect(parseDecimal(text)).toBeUndefined();
  });

  it('rejects numbers that print in exponent notation, NaN and Infinity', () => {
    expect(parseDecimal(1e-7)).toBeUndefined();
    expect(parseDecimal(Number.NaN)).toBeUndefined();
    expect(parseDecimal(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('rejects text longer than the bound that keeps BigInt arithmetic small', () => {
    expect(parseDecimal('1'.repeat(41))).toBeUndefined();
  });
});

describe('decimal helpers', () => {
  it('prints the canonical form', () => {
    expect(decimalToString(d('5.00'))).toBe('5');
    expect(decimalToString(d('0.050'))).toBe('0.05');
    expect(decimalToString(d('-0.5'))).toBe('-0.5');
    expect(decimalToString({ units: 0n, scale: 3 })).toBe('0');
  });

  it('counts significant fraction digits', () => {
    expect(fractionDigits(d('3.672500'))).toBe(4);
  });

  it('compares values of different scales', () => {
    expect(compareDecimal(d('5'), d('5.00'))).toBe(0);
    expect(compareDecimal(d('4.99'), d('5'))).toBe(-1);
    expect(compareDecimal(d('10'), d('9.999'))).toBe(1);
  });

  it('rounds half away from zero', () => {
    expect(divideRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divideRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divideRoundHalfUp(-5n, 10n)).toBe(-1n);
    expect(divideRoundHalfUp(-4n, 10n)).toBe(0n);
    expect(divideRoundHalfUp(15n, 10n)).toBe(2n);
  });

  it('detects exact halves', () => {
    expect(isHalfwayDivision(5n, 10n)).toBe(true);
    expect(isHalfwayDivision(6n, 10n)).toBe(false);
  });

  it('refuses a non-positive divisor and a bad exponent', () => {
    expect(() => divideRoundHalfUp(1n, 0n)).toThrow(RangeError);
    expect(() => pow10(-1)).toThrow(RangeError);
  });
});

describe('money in minor units', () => {
  it('formats with two decimals', () => {
    expect(formatAmount(123450)).toBe('1234.50');
    expect(formatAmount(5)).toBe('0.05');
    expect(formatAmount(-5)).toBe('-0.05');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(10n)).toBe('0.10');
  });

  it('parses amounts without rounding', () => {
    expect(parseAmount('45.5')).toBe(4550);
    expect(parseAmount('45.50')).toBe(4550);
    expect(parseAmount('7')).toBe(700);
    expect(() => parseAmount('1.005')).toThrow('more than two decimals');
    expect(() => parseAmount('abc')).toThrow('Invalid amount');
  });

  it('refuses a non-integer amount of minor units', () => {
    expect(() => formatAmount(1.5)).toThrow('integer number of minor units');
  });

  it('applies percentages with one rounding step', () => {
    expect(percentOf(10486_00, d('2.5'))).toBe(262_15n);
    expect(percentOf(1, d('50'))).toBe(1n); // 0.5 fils rounds up
    expect(percentOf(2870_00, d('5'))).toBe(143_50n);
    expect(percentOf(2396_70, d('5'))).toBe(119_84n); // 119.835 -> 119.84
  });

  it('converts currencies with the exchange rate', () => {
    // The published Exports example: USD 248,750 at 3.67285 is AED 913,621.44.
    expect(convertAmount(248_750_00, d('3.67285'))).toBe(913_621_44n);
  });

  it('refuses values that would lose precision as a number', () => {
    expect(() => toSafeNumber(2n ** 60n, 'total')).toThrow('too large');
  });
});
