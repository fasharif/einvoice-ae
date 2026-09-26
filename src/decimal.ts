/**
 * Exact decimal numbers stored as a scaled integer: value = units / 10^scale.
 *
 * Quantities, percentages and exchange rates arrive as decimal text ("2.5", "3.6725").
 * Parsing them into binary floating point would lose digits, so every calculation in
 * this library multiplies and divides BigInt values and rounds once, explicitly.
 */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** Longest decimal text accepted, to keep BigInt arithmetic bounded. */
export const MAX_DECIMAL_LENGTH = 40;

/**
 * Parses decimal text such as "12", "0.125" or "-3.50". Numbers are accepted when their
 * shortest string form is plain decimal notation (so 1e-7 is rejected; pass "0.0000001").
 * Returns undefined for anything else, including NaN, Infinity, "1,5" and "1e3".
 */
export function parseDecimal(input: string | number): Decimal | undefined {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return undefined;
    text = String(input);
  } else if (typeof input === 'string') {
    text = input.trim();
  } else {
    return undefined;
  }
  if (text.length === 0 || text.length > MAX_DECIMAL_LENGTH) return undefined;
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) return undefined;
  const [, sign, whole = '0', fraction = ''] = match;
  const magnitude = BigInt(whole + fraction);
  return normalise({ units: sign === '-' ? -magnitude : magnitude, scale: fraction.length });
}

/** Removes trailing zeros from the fraction so that 5.00 and 5 compare and print alike. */
export function normalise(value: Decimal): Decimal {
  let { units, scale } = value;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
}

export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new RangeError(`Exponent must be a non-negative integer (got ${exponent})`);
  }
  return 10n ** BigInt(exponent);
}

/** Canonical text form: no trailing zeros, no plus sign, "0" for zero. */
export function decimalToString(value: Decimal): string {
  const { units, scale } = normalise(value);
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Number of digits after the decimal point in the canonical form. */
export function fractionDigits(value: Decimal): number {
  return normalise(value).scale;
}

export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const left = a.units * pow10(scale - a.scale);
  const right = b.units * pow10(scale - b.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Exact sum of two decimals. */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return normalise({ units: a.units * pow10(scale - a.scale) + b.units * pow10(scale - b.scale), scale });
}

export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

export function isPositive(value: Decimal): boolean {
  return value.units > 0n;
}

/**
 * Integer division rounded half away from zero (commercial rounding: 0.5 goes to 1 and
 * -0.5 goes to -1). The divisor must be positive.
 */
export function divideRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError('Divisor must be positive');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** True when an exact division lands on a half (x.5), where rounding direction matters. */
export function isHalfwayDivision(numerator: bigint, divisor: bigint): boolean {
  if (divisor <= 0n) throw new RangeError('Divisor must be positive');
  const magnitude = numerator < 0n ? -numerator : numerator;
  return (magnitude % divisor) * 2n === divisor;
}
