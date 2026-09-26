/**
 * Credit notes are the only way to correct an issued invoice. `creditNoteFor` builds the
 * input for a credit note from the input of the original invoice.
 *
 * A partial credit is pro-rated on the cumulative credited quantity: the credit note that
 * takes a line from quantity c0 to c1 (of Q invoiced) carries round(A x c1 / Q) -
 * round(A x c0 / Q) of each amount A that depends on the quantity. The parts telescope, so
 * however an invoice is split, its credit notes add up to it exactly: line net amounts,
 * line allowances and charges, document-level allowances and charges, and the VAT
 * (see ADR-019).
 */
import { type DocumentLevelAllowanceCharge, type DocumentTotals, type LineTotals, type ResolvedAllowanceCharge, calculateTotals } from './calculate.js';
import type { CreditNoteReasonCode, CreditNoteTypeCode, SupportedTaxCategory } from './codelists/pint-ae.js';
import { type Decimal, addDecimal, compareDecimal, decimalToString, divideRoundHalfUp, parseDecimal, pow10 } from './decimal.js';
import { EInvoiceError } from './errors.js';
import type { IssuedDocument } from './immutability.js';
import type {
  CreditNoteInput,
  DecimalInput,
  DocumentAllowanceCharge,
  DocumentLevelTax,
  InvoiceInput,
  LineAllowanceCharge,
  LineInput,
  LineTax,
} from './model.js';

export interface CreditNoteDetails {
  /** IBT-001 of the credit note. */
  id: string;
  issueDate: string;
  issueTime?: string;
  uuid?: string;
  /** BTAE-03. VD (volume discount) cannot reference an invoice, so it is not accepted here. */
  reason: Exclude<CreditNoteReasonCode, 'VD'>;
  note?: string;
  /**
   * IBT-003. By default 81 for a 480 invoice; for a 380 invoice 381, or 81 when every
   * credited line is exempt (E) or out of scope (O), because a 381 needs at least one
   * other line (ibr-151-ae).
   */
  typeCode?: CreditNoteTypeCode;
  /**
   * Which lines to credit. "all" (default) credits everything not yet credited: the whole
   * invoice when nothing was credited before, otherwise the remaining quantity of every
   * line. A list credits the named lines, each with the given quantity or, without one,
   * with its remaining quantity.
   *
   * A partial credit pro-rates the line allowances and charges, the document-level
   * allowances and charges (by the credited share of the line amounts in their VAT
   * category) and the VAT, rounding on the cumulative credited quantity so that all the
   * credit notes for the invoice add up to it exactly. Where the credited quantity's own
   * amount rounds differently from its cumulative share (2.5 x 3.33 = 8.325), the credit
   * note carries the difference, a few minor units at most, as a document-level allowance
   * or charge in the line's VAT category with the reason `ROUNDING_ADJUSTMENT_REASON`.
   */
  lines?: 'all' | { lineId: string; quantity?: DecimalInput }[];
  /**
   * Quantities of the invoice lines credited by earlier credit notes, keyed by line
   * identifier (see `DocumentLedger.creditedQuantities`). A line cannot be credited beyond
   * its invoiced quantity minus these, and the pro-rating continues from them.
   */
  alreadyCredited?: Readonly<Record<string, DecimalInput>>;
}

type State = 'before' | 'after';

interface LinePlan {
  readonly id: string;
  readonly input: LineInput;
  readonly totals: LineTotals;
  readonly invoiced: Decimal;
  readonly baseQuantity: Decimal;
  readonly before: Decimal;
  after: Decimal;
}

const ZERO: Decimal = { units: 0n, scale: 0 };

function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

function quantityOf(value: DecimalInput, what: string): Decimal {
  const parsed = parseDecimal(value);
  if (!parsed) throw new EInvoiceError(`${what} is not a decimal number: ${String(value)}`);
  return parsed;
}

function subtract(a: Decimal, b: Decimal): Decimal {
  return addDecimal(a, { units: -b.units, scale: b.scale });
}

/** amount x part / whole for decimal part and whole, rounded half away from zero. */
function proRate(amount: bigint, part: Decimal, whole: Decimal): bigint {
  return divideRoundHalfUp(amount * part.units * pow10(whole.scale), whole.units * pow10(part.scale));
}

/** quantity x net price / base quantity as an exact fraction of minor units. */
function itemFraction(quantity: Decimal, plan: LinePlan): { numerator: bigint; divisor: bigint } {
  return {
    numerator: quantity.units * BigInt(plan.input.unitPrice) * pow10(plan.baseQuantity.scale),
    divisor: plan.baseQuantity.units * pow10(quantity.scale),
  };
}

function isComplete(plan: LinePlan, state: State): boolean {
  return compareDecimal(plan[state], plan.invoiced) >= 0;
}

/** Share of a line-level amount credited once the line reaches `state`. */
function lineShare(amount: number, plan: LinePlan, state: State): bigint {
  const quantity = plan[state];
  if (quantity.units === 0n) return 0n;
  if (isComplete(plan, state)) return BigInt(amount);
  return proRate(BigInt(amount), quantity, plan.invoiced);
}

/** Net amount of a line credited in total once it reaches `state`. */
function lineNetAt(plan: LinePlan, state: State): bigint {
  const quantity = plan[state];
  if (quantity.units === 0n) return 0n;
  if (isComplete(plan, state)) return BigInt(plan.totals.netAmount);
  const { numerator, divisor } = itemFraction(quantity, plan);
  const sum = (items: readonly ResolvedAllowanceCharge[]): bigint => items.reduce((t, ac) => t + lineShare(ac.amount, plan, state), 0n);
  return divideRoundHalfUp(numerator, divisor) + sum(plan.totals.charges) - sum(plan.totals.allowances);
}

function reasonOf(ac: ResolvedAllowanceCharge): Pick<LineAllowanceCharge, 'reason' | 'reasonCode'> {
  return {
    ...(ac.reasonCode !== undefined ? { reasonCode: ac.reasonCode } : {}),
    ...(ac.reason !== undefined ? { reason: ac.reason } : {}),
  };
}

/**
 * Reason of the document-level allowance or charge that carries a rounding difference of
 * a partial credit (see `CreditNoteDetails.lines`).
 */
export const ROUNDING_ADJUSTMENT_REASON = 'Rounding difference to the invoiced amount';

/**
 * Reason codes for that allowance or charge. A code is required only in category E
 * (ibr-168-ae, ibr-169-ae); neither code list has one for rounding, so the closest are
 * used: UNCL 7161 ADK (adjustments) and UNCL 5189 95 (discount).
 */
const ROUNDING_CHARGE_CODE = 'ADK';
const ROUNDING_ALLOWANCE_CODE = '95';

function netAmountOf(line: LineInput, currency: string): bigint {
  return BigInt((calculateTotals({ currency, lines: [line] }).lines[0] as LineTotals).netAmount);
}

/**
 * The credit note line for a partly credited line, with pro-rated allowances and charges,
 * and its rounding residual: the cumulative credited net amount after this credit minus
 * the one before it, less the net amount the document calculation gives the line. The
 * residual is not zero when quantity x price is not a whole number of minor units, or at
 * a half-fil tie that rule ibr-147-ae evaluates in binary floating point (ADR-004).
 */
function partialLine(plan: LinePlan, currency: string): { line: LineInput; residual: bigint } {
  const prorated = (items: readonly ResolvedAllowanceCharge[]): LineAllowanceCharge[] =>
    items.flatMap((ac) => {
      const amount = lineShare(ac.amount, plan, 'after') - lineShare(ac.amount, plan, 'before');
      return amount === 0n ? [] : [{ amount: Number(amount), ...reasonOf(ac) }];
    });
  const { allowances: _allowances, charges: _charges, ...rest } = deepCopy(plan.input);
  const allowances = prorated(plan.totals.allowances);
  const charges = prorated(plan.totals.charges);
  const line: LineInput = {
    ...rest,
    id: plan.id,
    quantity: decimalToString(subtract(plan.after, plan.before)),
    ...(allowances.length > 0 ? { allowances } : {}),
    ...(charges.length > 0 ? { charges } : {}),
  };
  const target = lineNetAt(plan, 'after') - lineNetAt(plan, 'before');
  return { line, residual: target - netAmountOf(line, currency) };
}

/** A document-level allowance or charge in the VAT category of a line. */
function roundingItem(amount: bigint, tax: LineTax): { isCharge: boolean; item: DocumentAllowanceCharge } {
  const isCharge = amount > 0n;
  const documentTax: DocumentLevelTax =
    tax.category === 'E'
      ? { category: 'E', exemptionReasonCode: tax.exemptionReasonCode, ...(tax.exemptionReason !== undefined ? { exemptionReason: tax.exemptionReason } : {}) }
      : { category: tax.category };
  return {
    isCharge,
    item: {
      amount: Number(isCharge ? amount : -amount),
      ...(tax.category === 'E' ? { reasonCode: isCharge ? ROUNDING_CHARGE_CODE : ROUNDING_ALLOWANCE_CODE } : {}),
      reason: ROUNDING_ADJUSTMENT_REASON,
      tax: documentTax,
    },
  };
}

function planLines(
  originalInput: InvoiceInput,
  totals: DocumentTotals,
  invoiceId: string,
  details: CreditNoteDetails,
): LinePlan[] {
  const plans = originalInput.lines.map((line, index): LinePlan => {
    const id = line.id ?? String(index + 1);
    const invoiced = quantityOf(line.quantity, `quantity of line ${id}`);
    const given = details.alreadyCredited?.[id];
    const before = given === undefined ? ZERO : quantityOf(given, `alreadyCredited.${id}`);
    if (before.units < 0n || compareDecimal(before, invoiced) > 0) {
      throw new EInvoiceError(
        `alreadyCredited.${id} is ${decimalToString(before)}, but line ${id} of invoice ${invoiceId} was invoiced with quantity ${decimalToString(invoiced)}`,
      );
    }
    const baseQuantity = quantityOf(line.priceBaseQuantity ?? '1', `price base quantity of line ${id}`);
    return { id, input: line, totals: totals.lines[index] as LineTotals, invoiced, baseQuantity, before, after: before };
  });
  const byId = new Map(plans.map((plan) => [plan.id, plan] as const));
  for (const id of Object.keys(details.alreadyCredited ?? {})) {
    if (!byId.has(id)) throw new EInvoiceError(`alreadyCredited names line ${id}, but invoice ${invoiceId} has no such line`);
  }

  if (details.lines === undefined || details.lines === 'all') {
    if (plans.every((plan) => isComplete(plan, 'before'))) {
      throw new EInvoiceError(`Invoice ${invoiceId} has already been credited in full`);
    }
    for (const plan of plans) plan.after = plan.invoiced;
    return plans;
  }

  if (details.lines.length === 0) throw new EInvoiceError('List at least one line to credit, or pass lines: "all"');
  const seen = new Set<string>();
  for (const { lineId, quantity } of details.lines) {
    const plan = byId.get(lineId);
    if (!plan) throw new EInvoiceError(`Invoice ${invoiceId} has no line ${lineId}`);
    if (seen.has(lineId)) throw new EInvoiceError(`Line ${lineId} is listed twice; credit each line once`);
    seen.add(lineId);
    const remaining = subtract(plan.invoiced, plan.before);
    const requested = quantity === undefined ? remaining : quantityOf(quantity, `quantity to credit on line ${lineId}`);
    if (remaining.units <= 0n || requested.units <= 0n || compareDecimal(requested, remaining) > 0) {
      throw new EInvoiceError(
        `Line ${lineId} of invoice ${invoiceId} was invoiced with quantity ${decimalToString(plan.invoiced)}` +
          (plan.before.units > 0n ? ` and ${decimalToString(plan.before)} has already been credited` : '') +
          `; ${decimalToString(requested)} cannot be credited`,
      );
    }
    plan.after = addDecimal(plan.before, requested);
  }
  return plans;
}

/**
 * Pro-rates the document-level allowances and charges and the VAT of category S for a
 * partial credit. A document-level item follows the credited share of the line net
 * amounts in its own VAT category (or of all lines when its category has none).
 */
function documentLevelCredit(plans: readonly LinePlan[], totals: DocumentTotals) {
  const lineTotal = new Map<SupportedTaxCategory, bigint>();
  const credited: Record<State, Map<SupportedTaxCategory, bigint>> = { before: new Map(), after: new Map() };
  let allLines = 0n;
  const allCredited: Record<State, bigint> = { before: 0n, after: 0n };
  for (const plan of plans) {
    const category = plan.input.tax.category;
    lineTotal.set(category, (lineTotal.get(category) ?? 0n) + BigInt(plan.totals.netAmount));
    allLines += BigInt(plan.totals.netAmount);
    for (const state of ['before', 'after'] as const) {
      const net = lineNetAt(plan, state);
      credited[state].set(category, (credited[state].get(category) ?? 0n) + net);
      allCredited[state] += net;
    }
  }
  const complete = (state: State): boolean => plans.every((plan) => isComplete(plan, state));

  const shareAt = (amount: bigint, category: SupportedTaxCategory, state: State): bigint => {
    const total = lineTotal.get(category) ?? 0n;
    const [part, whole] =
      total > 0n
        ? [credited[state].get(category) ?? 0n, total]
        : allLines > 0n
          ? [allCredited[state], allLines]
          : [complete(state) ? 1n : 0n, 1n];
    if (part >= whole) return amount;
    return part <= 0n ? 0n : divideRoundHalfUp(amount * part, whole);
  };

  const items = (resolved: readonly DocumentLevelAllowanceCharge[]): DocumentAllowanceCharge[] =>
    resolved.flatMap((ac) => {
      const amount = shareAt(BigInt(ac.amount), ac.tax.category, 'after') - shareAt(BigInt(ac.amount), ac.tax.category, 'before');
      return amount <= 0n ? [] : [{ amount: Number(amount), ...reasonOf(ac), tax: deepCopy(ac.tax) }];
    });
  const allowances = items(totals.allowances);
  const charges = items(totals.charges);

  // VAT of category S: the invoice VAT in proportion to the credited taxable amount,
  // rounded on the cumulative amount, so the credit notes add up to the invoice VAT.
  const standard = totals.breakdown.find((b) => b.category === 'S');
  const hasStandard =
    plans.some((plan) => plan.input.tax.category === 'S' && compareDecimal(plan.after, plan.before) > 0) ||
    [...allowances, ...charges].some((ac) => ac.tax.category === 'S');
  let standardRatedVat: number | undefined;
  if (standard && hasStandard) {
    const signed = (list: readonly DocumentLevelAllowanceCharge[], sign: bigint, state: State): bigint =>
      list.filter((ac) => ac.tax.category === 'S').reduce((t, ac) => t + sign * shareAt(BigInt(ac.amount), 'S', state), 0n);
    const taxableAt = (state: State): bigint =>
      (credited[state].get('S') ?? 0n) + signed(totals.charges, 1n, state) + signed(totals.allowances, -1n, state);
    const taxable = BigInt(standard.taxableAmount);
    const vat = BigInt(standard.taxAmount);
    const vatAt = (state: State): bigint => {
      const part = taxableAt(state);
      if (taxable <= 0n || part <= 0n) return 0n;
      return part >= taxable ? vat : divideRoundHalfUp(vat * part, taxable);
    };
    standardRatedVat = Number(vatAt('after') - vatAt('before'));
  }
  return { allowances, charges, standardRatedVat };
}

/**
 * Builds the input for a credit note that corrects an issued invoice. Parties, currency,
 * exchange rate and line details are copied from the original input; the credit note
 * references the invoice number and issue date (IBG-03). See `CreditNoteDetails.lines`
 * for whole and partial credits.
 */
export function creditNoteFor(
  originalInput: InvoiceInput,
  issuedInvoice: Pick<IssuedDocument, 'kind' | 'id' | 'issueDate' | 'typeCode'> & Partial<Pick<IssuedDocument, 'totals'>>,
  details: CreditNoteDetails,
): CreditNoteInput {
  if (issuedInvoice.kind !== 'Invoice') throw new EInvoiceError('A credit note can only correct an invoice');
  if (originalInput.id !== issuedInvoice.id) {
    throw new EInvoiceError(`The input is for ${originalInput.id} but the issued invoice is ${issuedInvoice.id}`);
  }
  if (details.issueDate < issuedInvoice.issueDate) {
    throw new EInvoiceError(`The credit note date ${details.issueDate} is before the invoice date ${issuedInvoice.issueDate}`);
  }
  const totals = calculateTotals(originalInput);
  if (issuedInvoice.totals && issuedInvoice.totals.taxInclusiveAmount !== totals.taxInclusiveAmount) {
    throw new EInvoiceError(`The input does not reproduce invoice ${issuedInvoice.id}: its totals differ from the issued document`);
  }

  const plans = planLines(originalInput, totals, issuedInvoice.id, details);
  const credited = plans.filter((plan) => compareDecimal(plan.after, plan.before) > 0);
  const whole = plans.every((plan) => plan.before.units === 0n && isComplete(plan, 'after'));

  let lines: LineInput[];
  let documentLevel: Pick<CreditNoteInput, 'allowances' | 'charges' | 'standardRatedVat'>;
  if (whole) {
    // The whole invoice in one credit note: the same amounts, calculated the same way.
    lines = plans.map((plan) => ({ ...deepCopy(plan.input), id: plan.id }));
    documentLevel = {
      ...(originalInput.allowances !== undefined ? { allowances: deepCopy(originalInput.allowances) } : {}),
      ...(originalInput.charges !== undefined ? { charges: deepCopy(originalInput.charges) } : {}),
    };
  } else {
    // Rounding residuals of the lines, per VAT category, go into one document-level
    // allowance or charge per category, so the lines keep the amounts the rules compute.
    const residuals = new Map<SupportedTaxCategory, { amount: bigint; tax: LineTax }>();
    lines = credited.map((plan) => {
      if (plan.before.units === 0n && isComplete(plan, 'after')) return { ...deepCopy(plan.input), id: plan.id };
      const { line, residual } = partialLine(plan, originalInput.currency);
      const entry = residuals.get(line.tax.category) ?? { amount: 0n, tax: line.tax };
      entry.amount += residual;
      residuals.set(line.tax.category, entry);
      return line;
    });
    const { allowances, charges, standardRatedVat } = documentLevelCredit(plans, totals);
    for (const { amount, tax } of residuals.values()) {
      if (amount === 0n) continue;
      const { isCharge, item } = roundingItem(amount, tax);
      (isCharge ? charges : allowances).push(item);
    }
    documentLevel = {
      ...(allowances.length > 0 ? { allowances } : {}),
      ...(charges.length > 0 ? { charges } : {}),
      ...(standardRatedVat !== undefined ? { standardRatedVat } : {}),
    };
  }

  const onlyExemptOrOutOfScope = lines.every((line) => line.tax.category === 'E' || line.tax.category === 'O');
  const typeCode: CreditNoteTypeCode = details.typeCode ?? (issuedInvoice.typeCode === '480' || onlyExemptOrOutOfScope ? '81' : '381');

  const copy = <K extends keyof InvoiceInput>(key: K): Partial<Pick<InvoiceInput, K>> =>
    originalInput[key] !== undefined ? ({ [key]: deepCopy(originalInput[key]) } as Partial<Pick<InvoiceInput, K>>) : {};

  return {
    id: details.id,
    issueDate: details.issueDate,
    ...(details.issueTime !== undefined ? { issueTime: details.issueTime } : {}),
    ...(details.uuid !== undefined ? { uuid: details.uuid } : {}),
    typeCode,
    reason: details.reason,
    precedingInvoices: [{ id: issuedInvoice.id, issueDate: issuedInvoice.issueDate }],
    ...(details.note !== undefined ? { note: details.note } : {}),
    currency: originalInput.currency,
    ...copy('exchangeRate'),
    ...copy('buyerReference'),
    ...copy('orderReference'),
    ...copy('contractReference'),
    ...copy('projectReference'),
    ...copy('invoicePeriod'),
    ...copy('transactionType'),
    ...copy('beneficiaryId'),
    ...copy('principalId'),
    ...copy('delivery'),
    ...copy('customsReference'),
    ...copy('vatRounding'),
    seller: deepCopy(originalInput.seller),
    buyer: deepCopy(originalInput.buyer),
    ...documentLevel,
    lines,
  };
}
