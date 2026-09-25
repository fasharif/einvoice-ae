/**
 * Re-evaluates two official rules exactly the way the Schematron does, so that the library
 * never emits a value that the validator would reject because of binary rounding.
 *
 * Most PINT AE rules cast amounts to xs:decimal and compare them exactly; the library's
 * BigInt arithmetic matches those. Two rules instead apply arithmetic to untyped values,
 * which XPath 2.0 promotes to xs:double:
 *
 * - ibr-147-ae: line net amount = quantity x (price / base quantity) + charges - allowances
 * - ibr-131-ae / ibr-146-ae: allowance or charge amount = base amount x percent / 100
 *
 * When the exact result lies on a half cent, IEEE 754 doubles can round it the other way.
 * JavaScript numbers are the same IEEE 754 doubles and Math.round rounds half towards
 * positive infinity like XPath fn:round, so the checks below reproduce the validator.
 */

function xpathRound(value: number): number {
  return Math.round(value);
}

/** XPath sum() over untyped values: each is cast to xs:double and added in document order. */
function xpathSum(values: readonly string[]): number {
  return values.reduce((total, value) => total + Number(value), 0);
}

/**
 * ibr-147-ae as published:
 * round(LineExtensionAmount * 100) div 100 =
 * round(((Quantity * (PriceAmount div BaseQuantity)) + sum(charges) - sum(allowances)) * 100) div 100
 */
export function passesLineNetAmountRule(args: {
  lineExtensionAmount: string;
  quantity: string;
  priceAmount: string;
  baseQuantity: string;
  chargeAmounts: readonly string[];
  allowanceAmounts: readonly string[];
}): boolean {
  const left = xpathRound(Number(args.lineExtensionAmount) * 100) / 100;
  const computed =
    Number(args.quantity) * (Number(args.priceAmount) / Number(args.baseQuantity)) +
    xpathSum(args.chargeAmounts) -
    xpathSum(args.allowanceAmounts);
  const right = xpathRound(computed * 100) / 100;
  return left === right;
}

/**
 * ibr-131-ae and ibr-146-ae as published:
 * number(Amount) = number(BaseAmount) * number(MultiplierFactorNumeric) div 100
 * or number(Amount) = round((number(BaseAmount) * number(MultiplierFactorNumeric) div 100) * 100) div 100
 */
export function passesAllowanceChargeRule(args: { amount: string; baseAmount: string; percent: string }): boolean {
  const amount = Number(args.amount);
  const product = (Number(args.baseAmount) * Number(args.percent)) / 100;
  return amount === product || amount === xpathRound(product * 100) / 100;
}
