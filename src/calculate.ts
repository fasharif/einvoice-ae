/**
 * Totals, VAT breakdown and AED amounts, computed in integer minor units.
 *
 * Formulas follow chapter 4 of the PINT AE BIS:
 * - line net (IBT-131) = quantity x (net price / base quantity) + line charges - line allowances
 * - category taxable amount (IBT-116) = sum of line nets + document charges - document allowances
 * - category VAT (IBT-117) = taxable amount x rate / 100, zero for E, O, Z and AE
 * - totals IBT-106 to IBT-115 as in section 4.1.1
 *
 * Every product is rounded once, half away from zero, to whole minor units.
 */
import { PINT_AE } from './constants.js';
import {
  type Decimal,
  decimalToString,
  divideRoundHalfUp,
  parseDecimal,
  pow10,
} from './decimal.js';
import { CalculationError } from './errors.js';
import type {
  DecimalInput,
  DocumentAllowanceCharge,
  DocumentLevelTax,
  LineAllowanceCharge,
  LineInput,
  LineTax,
} from './model.js';
import { type MinorUnits, convertAmount, formatAmount, percentOf, toSafeNumber } from './money.js';
import { passesAllowanceChargeRule, passesLineNetAmountRule } from './xpath-emulation.js';
import type { SupportedTaxCategory } from './codelists/pint-ae.js';

const STANDARD_RATE = parseRequired(PINT_AE.standardRatePercent);
const ZERO = parseRequired('0');

/** The rate a category carries on lines; undefined means no rate element (E and O). */
export function lineRate(category: SupportedTaxCategory): Decimal | undefined {
  switch (category) {
    case 'S':
    case 'AE':
      return STANDARD_RATE;
    case 'Z':
      return ZERO;
    case 'E':
    case 'O':
      return undefined;
  }
}

/**
 * The rate a category carries on document-level allowances and charges. The rules differ
 * from lines: E and AE must state 0 (aligned-ibrp-e-06/07, aligned-ibrp-ae-06/07).
 */
export function documentLevelRate(category: SupportedTaxCategory): Decimal | undefined {
  switch (category) {
    case 'S':
      return STANDARD_RATE;
    case 'Z':
    case 'E':
    case 'AE':
      return ZERO;
    case 'O':
      return undefined;
  }
}

export interface ResolvedAllowanceCharge {
  readonly isCharge: boolean;
  readonly amount: MinorUnits;
  readonly percent?: string;
  readonly baseAmount?: MinorUnits;
  readonly reasonCode?: string;
  readonly reason?: string;
}

export interface DocumentLevelAllowanceCharge extends ResolvedAllowanceCharge {
  readonly tax: DocumentLevelTax;
  /** The rate printed on the allowance or charge, or undefined when none is printed. */
  readonly rate?: string;
}

export interface LineTotals {
  readonly id: string;
  readonly quantity: string;
  readonly priceBaseQuantity: string;
  readonly unitPrice: MinorUnits;
  readonly grossUnitPrice: MinorUnits;
  readonly allowances: readonly ResolvedAllowanceCharge[];
  readonly charges: readonly ResolvedAllowanceCharge[];
  /** IBT-131, line net amount in the document currency. */
  readonly netAmount: MinorUnits;
  readonly tax: LineTax;
  /** Rate printed on the line (IBT-152), or undefined for E and O. */
  readonly rate?: string;
  /** VAT of this line in the document currency; undefined for exempt (E) lines. */
  readonly vatAmount?: MinorUnits;
  /** BTAE-08, line VAT in AED; undefined for exempt (E) lines (ibr-163-ae). */
  readonly vatAmountAed?: MinorUnits;
  /** BTAE-10, line amount payable (net plus VAT) in AED. */
  readonly payableAmountAed: MinorUnits;
}

export interface TaxBreakdown {
  readonly category: SupportedTaxCategory;
  /** IBT-119, or undefined for E and O (ibr-121-ae, aligned-ibrp-o-11-ae). */
  readonly rate?: string;
  /** IBT-116. */
  readonly taxableAmount: MinorUnits;
  /** IBT-117. */
  readonly taxAmount: MinorUnits;
}

export interface DocumentTotals {
  readonly currency: string;
  readonly lines: readonly LineTotals[];
  readonly allowances: readonly DocumentLevelAllowanceCharge[];
  readonly charges: readonly DocumentLevelAllowanceCharge[];
  readonly breakdown: readonly TaxBreakdown[];
  /** IBT-106. */
  readonly lineExtensionAmount: MinorUnits;
  /** IBT-107. */
  readonly allowanceTotalAmount: MinorUnits;
  /** IBT-108. */
  readonly chargeTotalAmount: MinorUnits;
  /** IBT-109. */
  readonly taxExclusiveAmount: MinorUnits;
  /** IBT-110. */
  readonly taxAmount: MinorUnits;
  /** IBT-112. */
  readonly taxInclusiveAmount: MinorUnits;
  /** IBT-113. */
  readonly prepaidAmount: MinorUnits;
  /** IBT-114. */
  readonly roundingAmount: MinorUnits;
  /** IBT-115. */
  readonly payableAmount: MinorUnits;
  /** Present when the document currency is not AED. */
  readonly aed?: {
    readonly exchangeRate: string;
    /** IBT-111, total VAT in AED. */
    readonly taxAmount: MinorUnits;
    /** BTAE-20, invoice total with VAT in AED. */
    readonly taxInclusiveAmount: MinorUnits;
  };
}

export interface CalculationInput {
  currency: string;
  exchangeRate?: DecimalInput;
  lines: readonly LineInput[];
  allowances?: readonly DocumentAllowanceCharge[];
  charges?: readonly DocumentAllowanceCharge[];
  prepaidAmount?: MinorUnits;
  roundingAmount?: MinorUnits;
  vatRounding?: 'category' | 'line';
}

function parseRequired(value: DecimalInput, what = 'value'): Decimal {
  const parsed = parseDecimal(value);
  if (!parsed) throw new CalculationError('INVALID_DECIMAL', `${what} is not a decimal number: ${String(value)}`);
  return parsed;
}

/**
 * Resolves an allowance or charge to an amount. With a percentage and base amount the
 * amount is base x percent / 100, rounded half away from zero, and then cross-checked
 * against the double-precision evaluation used by ibr-131-ae / ibr-146-ae.
 */
function resolveAllowanceCharge(input: LineAllowanceCharge, isCharge: boolean, path: string): ResolvedAllowanceCharge {
  const rule = isCharge ? 'ibr-146-ae' : 'ibr-131-ae';
  const optional = {
    ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
  if (input.percent === undefined || input.baseAmount === undefined) {
    if (input.amount === undefined) {
      throw new CalculationError('MISSING_AMOUNT', `${path}: give an amount, or a percent with a base amount`);
    }
    return { isCharge, amount: input.amount, ...optional };
  }

  const percent = parseRequired(input.percent, `${path}.percent`);
  const percentText = decimalToString(percent);
  const baseText = formatAmount(input.baseAmount);
  const exact = percentOf(input.baseAmount, percent);
  const candidates = input.amount !== undefined ? [BigInt(input.amount)] : [exact, exact - 1n, exact + 1n];
  const accepted = candidates.find((candidate) =>
    passesAllowanceChargeRule({ amount: formatAmount(candidate), baseAmount: baseText, percent: percentText }),
  );
  if (accepted === undefined) {
    throw new CalculationError(
      'ALLOWANCE_CHARGE_MISMATCH',
      `${path}: amount must equal ${baseText} x ${percentText} % = ${formatAmount(exact)}`,
      rule,
    );
  }
  return {
    isCharge,
    amount: toSafeNumber(accepted, `${path}.amount`),
    percent: percentText,
    baseAmount: input.baseAmount,
    ...optional,
  };
}

function calculateLine(line: LineInput, index: number, exchangeRate: Decimal | undefined): LineTotals {
  const path = `lines[${index}]`;
  const quantity = parseRequired(line.quantity, `${path}.quantity`);
  const baseQuantity = parseRequired(line.priceBaseQuantity ?? '1', `${path}.priceBaseQuantity`);
  const allowances = (line.allowances ?? []).map((a, i) => resolveAllowanceCharge(a, false, `${path}.allowances[${i}]`));
  const charges = (line.charges ?? []).map((c, i) => resolveAllowanceCharge(c, true, `${path}.charges[${i}]`));

  // quantity x price / baseQuantity, as one exact fraction, rounded once.
  const numerator = quantity.units * BigInt(line.unitPrice) * pow10(baseQuantity.scale);
  const divisor = baseQuantity.units * pow10(quantity.scale);
  const itemAmount = divideRoundHalfUp(numerator, divisor);
  const adjustments =
    charges.reduce((sum, c) => sum + BigInt(c.amount), 0n) - allowances.reduce((sum, a) => sum + BigInt(a.amount), 0n);
  const exact = itemAmount + adjustments;

  const quantityText = decimalToString(quantity);
  const baseQuantityText = decimalToString(baseQuantity);
  const ruleArgs = {
    quantity: quantityText,
    priceAmount: formatAmount(line.unitPrice),
    baseQuantity: baseQuantityText,
    chargeAmounts: charges.map((c) => formatAmount(c.amount)),
    allowanceAmounts: allowances.map((a) => formatAmount(a.amount)),
  };
  const netAmount = [exact, exact - 1n, exact + 1n].find((candidate) =>
    passesLineNetAmountRule({ ...ruleArgs, lineExtensionAmount: formatAmount(candidate) }),
  );
  if (netAmount === undefined) {
    throw new CalculationError(
      'LINE_AMOUNT_ROUNDING',
      `${path}: the line net amount ${formatAmount(exact)} cannot be expressed so that the official ` +
        'rule ibr-147-ae accepts it; change the quantity, price or price base quantity',
      'ibr-147-ae',
    );
  }
  if (netAmount < 0n) {
    throw new CalculationError('NEGATIVE_LINE_AMOUNT', `${path}: line allowances exceed the line amount`);
  }

  const category = line.tax.category;
  const rate = lineRate(category);
  let vatAmount: bigint | undefined;
  if (category === 'S') vatAmount = percentOf(netAmount, STANDARD_RATE);
  else if (category !== 'E') vatAmount = 0n; // Z, O and AE lines carry zero VAT (ibr-165-ae, ibr-162-ae).

  const toAed = (amount: bigint): bigint => (exchangeRate ? convertAmount(amount, exchangeRate) : amount);
  const vatAmountAed = vatAmount === undefined ? undefined : toAed(vatAmount);
  const payableAmountAed = toAed(netAmount + (vatAmount ?? 0n));

  return {
    id: line.id ?? String(index + 1),
    quantity: quantityText,
    priceBaseQuantity: baseQuantityText,
    unitPrice: line.unitPrice,
    grossUnitPrice: line.grossUnitPrice ?? line.unitPrice,
    allowances,
    charges,
    netAmount: toSafeNumber(netAmount, `${path} net amount`),
    tax: line.tax,
    ...(rate !== undefined ? { rate: decimalToString(rate) } : {}),
    ...(vatAmount !== undefined ? { vatAmount: toSafeNumber(vatAmount, `${path} VAT`) } : {}),
    ...(vatAmountAed !== undefined ? { vatAmountAed: toSafeNumber(vatAmountAed, `${path} VAT in AED`) } : {}),
    payableAmountAed: toSafeNumber(payableAmountAed, `${path} amount payable in AED`),
  };
}

function resolveDocumentLevel(input: DocumentAllowanceCharge, isCharge: boolean, path: string): DocumentLevelAllowanceCharge {
  const resolved = resolveAllowanceCharge(input, isCharge, path);
  const rate = documentLevelRate(input.tax.category);
  return { ...resolved, tax: input.tax, ...(rate !== undefined ? { rate: decimalToString(rate) } : {}) };
}

interface Group {
  category: SupportedTaxCategory;
  taxable: bigint;
  lineVat: bigint;
  documentLevelVat: bigint;
  hasLines: boolean;
}

/** Computes every amount of a document. Input is assumed to have passed validation. */
export function calculateTotals(input: CalculationInput): DocumentTotals {
  const exchangeRate =
    input.currency === PINT_AE.taxCurrency || input.exchangeRate === undefined
      ? undefined
      : parseRequired(input.exchangeRate, 'exchangeRate');

  const lines = input.lines.map((line, index) => calculateLine(line, index, exchangeRate));
  const allowances = (input.allowances ?? []).map((a, i) => resolveDocumentLevel(a, false, `allowances[${i}]`));
  const charges = (input.charges ?? []).map((c, i) => resolveDocumentLevel(c, true, `charges[${i}]`));

  const groups = new Map<SupportedTaxCategory, Group>();
  const group = (category: SupportedTaxCategory): Group => {
    let existing = groups.get(category);
    if (!existing) {
      existing = { category, taxable: 0n, lineVat: 0n, documentLevelVat: 0n, hasLines: false };
      groups.set(category, existing);
    }
    return existing;
  };
  for (const line of lines) {
    const g = group(line.tax.category);
    g.taxable += BigInt(line.netAmount);
    g.lineVat += BigInt(line.vatAmount ?? 0);
    g.hasLines = true;
  }
  for (const ac of [...allowances, ...charges]) {
    const g = group(ac.tax.category);
    const sign = ac.isCharge ? 1n : -1n;
    g.taxable += sign * BigInt(ac.amount);
    if (ac.tax.category === 'S') g.documentLevelVat += sign * percentOf(ac.amount, STANDARD_RATE);
  }

  const vatRounding = input.vatRounding ?? 'category';
  const breakdown: TaxBreakdown[] = [];
  for (const g of groups.values()) {
    if (g.taxable < 0n) {
      throw new CalculationError(
        'NEGATIVE_TAXABLE_AMOUNT',
        `Document-level allowances exceed the taxable amount of VAT category ${g.category}`,
      );
    }
    let taxAmount = 0n;
    if (g.category === 'S') {
      const byCategory = percentOf(g.taxable, STANDARD_RATE);
      if (vatRounding === 'line') {
        taxAmount = g.lineVat + g.documentLevelVat;
        const drift = taxAmount - byCategory;
        if (drift > 2n || drift < -2n) {
          throw new CalculationError(
            'VAT_ROUNDING_DRIFT',
            `Per-line VAT rounding gives ${formatAmount(taxAmount)} for category S but the category ` +
              `calculation gives ${formatAmount(byCategory)}; the official rule accepts at most 0.02 ` +
              'difference. Use vatRounding "category" for this document.',
            'aligned-ibrp-s-09',
          );
        }
      } else {
        taxAmount = byCategory;
      }
    }
    // AE: lines state the 5 % rate while document-level AE items state 0 %; the published
    // examples put both into one breakdown at the line rate.
    const rate =
      g.category === 'AE'
        ? g.hasLines
          ? decimalToString(STANDARD_RATE)
          : decimalToString(ZERO)
        : (() => {
            const r = lineRate(g.category);
            return r === undefined ? undefined : decimalToString(r);
          })();
    breakdown.push({
      category: g.category,
      ...(rate !== undefined ? { rate } : {}),
      taxableAmount: toSafeNumber(g.taxable, `taxable amount of category ${g.category}`),
      taxAmount: toSafeNumber(taxAmount, `VAT of category ${g.category}`),
    });
  }

  const sum = (values: readonly { amount: MinorUnits }[]): bigint => values.reduce((t, v) => t + BigInt(v.amount), 0n);
  const lineExtension = lines.reduce((t, l) => t + BigInt(l.netAmount), 0n);
  const allowanceTotal = sum(allowances);
  const chargeTotal = sum(charges);
  const taxExclusive = lineExtension - allowanceTotal + chargeTotal;
  const taxTotal = breakdown.reduce((t, b) => t + BigInt(b.taxAmount), 0n);
  const taxInclusive = taxExclusive + taxTotal;
  const prepaid = BigInt(input.prepaidAmount ?? 0);
  const rounding = BigInt(input.roundingAmount ?? 0);
  const payable = taxInclusive - prepaid + rounding;

  return {
    currency: input.currency,
    lines,
    allowances,
    charges,
    breakdown,
    lineExtensionAmount: toSafeNumber(lineExtension, 'sum of line net amounts'),
    allowanceTotalAmount: toSafeNumber(allowanceTotal, 'sum of allowances'),
    chargeTotalAmount: toSafeNumber(chargeTotal, 'sum of charges'),
    taxExclusiveAmount: toSafeNumber(taxExclusive, 'total without VAT'),
    taxAmount: toSafeNumber(taxTotal, 'total VAT'),
    taxInclusiveAmount: toSafeNumber(taxInclusive, 'total with VAT'),
    prepaidAmount: toSafeNumber(prepaid, 'prepaid amount'),
    roundingAmount: toSafeNumber(rounding, 'rounding amount'),
    payableAmount: toSafeNumber(payable, 'amount due'),
    ...(exchangeRate
      ? {
          aed: {
            exchangeRate: decimalToString(exchangeRate),
            taxAmount: toSafeNumber(convertAmount(taxTotal, exchangeRate), 'total VAT in AED'),
            taxInclusiveAmount: toSafeNumber(convertAmount(taxInclusive, exchangeRate), 'total with VAT in AED'),
          },
        }
      : {}),
  };
}
