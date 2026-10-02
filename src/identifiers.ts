/**
 * UAE identifier formats, exactly as far as PINT AE 1.0.4 defines them. The specification
 * describes a length, a prefix and a suffix; it defines no check digit, so none is tested.
 */
import { PREDEFINED_ENDPOINTS } from './constants.js';

const TRN_PATTERN = /^1\d{12}03$/;
const TIN_PATTERN = /^1\d{9}$/;
const PREDEFINED = new Set<string>(Object.values(PREDEFINED_ENDPOINTS));

/**
 * Tax Registration Number (VAT identifier): 15 digits, starting with 1 and ending with 03
 * (rule ibr-132-ae, which applies to the VAT identifiers of parties with an AE address).
 */
export function isValidTrn(value: string): boolean {
  return TRN_PATTERN.test(value);
}

/** Tax Identification Number: 10 digits starting with 1 (rule ibr-148-ae, BIS section 1.6). */
export function isValidTin(value: string): boolean {
  return TIN_PATTERN.test(value);
}

/** One of the three predefined endpoints of BIS section 1.5.3 (99000000 97, 98 or 99). */
export function isPredefinedEndpoint(value: string): boolean {
  return PREDEFINED.has(value);
}

/**
 * A participant identifier under scheme 0235: the party's TIN, or a predefined endpoint
 * (BIS sections 1.5.3 and 1.6).
 */
export function isValidUaeEndpoint(value: string): boolean {
  return isValidTin(value) || isPredefinedEndpoint(value);
}
