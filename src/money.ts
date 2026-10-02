/**
 * Money in integer minor units.
 *
 * Every amount in the input model and in the calculated totals is an integer number of
 * hundredths of the document currency. For AED that is fils (1 AED = 100 fils). PINT AE
 * allows at most two decimals for document-level amounts (rules ibr-091, ibr-121 to
 * ibr-125), so hundredths are used for every currency, including those whose ISO 4217
 * exponent is 0 or 3.
 */
import { type Decimal, divideRoundHalfUp, parseDecimal, pow10 } from './decimal.js';

/** An integer number of hundredths of the currency unit (fils for AED). */
export type MinorUnits = number;

export const MINOR_UNITS_PER_UNIT = 100;

/**
 * Largest single amount accepted in the input, in minor units (AED 1 trillion). Sums are
 * computed with BigInt and checked again before they are returned as numbers.
 */
export const MAX_AMOUNT_MINOR = 100_000_000_000_000;

export function isMinorUnits(value: unknown): value is MinorUnits {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Formats minor units as a two-decimal string: 123450 becomes "1234.50". */
export function formatAmount(minor: MinorUnits | bigint): string {
  const value = typeof minor === 'bigint' ? minor : BigInt(assertSafe(minor, 'amount'));
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * Parses a decimal amount with at most two decimals into minor units: "45.5" becomes 4550.
 * Throws a RangeError for more decimals instead of rounding silently.
 */
export function parseAmount(text: string): MinorUnits {
  const parsed = parseDecimal(text);
  if (!parsed) throw new RangeError(`Invalid amount: "${text}"`);
  if (parsed.scale > 2) {
    throw new RangeError(`Amount "${text}" has more than two decimals`);
  }
  return toSafeNumber(parsed.units * pow10(2 - parsed.scale), `amount "${text}"`);
}

/**
 * Applies a percentage to an amount in minor units and rounds half away from zero:
 * percentOf(10486_00, 2.5%) = 262_15.
 */
export function percentOf(minor: MinorUnits | bigint, percent: Decimal): bigint {
  const base = typeof minor === 'bigint' ? minor : BigInt(assertSafe(minor, 'amount'));
  return divideRoundHalfUp(base * percent.units, 100n * pow10(percent.scale));
}

/**
 * Converts an amount with an exchange rate (units of the target currency per unit of the
 * source currency) and rounds half away from zero to the target's minor units.
 */
export function convertAmount(minor: MinorUnits | bigint, rate: Decimal): bigint {
  const base = typeof minor === 'bigint' ? minor : BigInt(assertSafe(minor, 'amount'));
  return divideRoundHalfUp(base * rate.units, pow10(rate.scale));
}

/** Converts a BigInt result back to a number, refusing values that would lose precision. */
export function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${what} is too large to represent exactly`);
  }
  return Number(value);
}

function assertSafe(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be an integer number of minor units (got ${value})`);
  }
  return value;
}
