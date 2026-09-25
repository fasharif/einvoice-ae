/**
 * Input checks run before any XML is built. Each check that mirrors an official rule names
 * that rule, so an error message can be traced to the specification. The official
 * Schematron remains the authority; these checks exist so that mistakes surface as clear
 * errors in the caller's code rather than as rejections from an Accredited Service Provider.
 */
import {
  ALLOWANCE_REASON_CODES,
  CHARGE_REASON_CODES,
  COUNTRY_CODES,
  CURRENCY_CODES,
  ENDPOINT_SCHEME_CODES,
  ICD_SCHEME_CODES,
  PAYMENT_MEANS_CODES,
  UNIT_CODES,
} from './codelists/generated.js';
import {
  BILLING_FREQUENCIES,
  CREDIT_NOTE_REASONS,
  CREDIT_NOTE_TYPE_CODES,
  EMIRATES,
  INVOICE_TYPE_CODES,
  ITEM_TYPES,
  LEGAL_REGISTRATION_TYPES,
  REVERSE_CHARGE_GOODS,
  SUPPORTED_TAX_CATEGORIES,
  TAX_EXEMPTION_REASONS,
  TRANSACTION_TYPE_FLAGS,
} from './codelists/pint-ae.js';
import { PINT_AE, PREDEFINED_ENDPOINTS } from './constants.js';
import { type Decimal, fractionDigits, parseDecimal } from './decimal.js';
import type { ValidationIssue } from './errors.js';
import { isValidTin, isValidTrn, isValidUaeEndpoint } from './identifiers.js';
import type {
  Address,
  Buyer,
  CreditNoteInput,
  DecimalInput,
  Delivery,
  DocumentAllowanceCharge,
  InvoiceInput,
  LegalRegistration,
  LineAllowanceCharge,
  LineInput,
  PaymentMeans,
  Seller,
} from './model.js';
import { MAX_AMOUNT_MINOR } from './money.js';
import { containsInvalidXmlCharacter } from './xml.js';

class Issues {
  readonly list: ValidationIssue[] = [];

  add(path: string, code: string, message: string, rule?: string): void {
    this.list.push(rule ? { path, code, message, rule } : { path, code, message });
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d+)?(Z|[+-](0\d|1[0-4]):[0-5]\d)?$/;

function has<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Checks a required text field: a non-blank string with only valid XML characters. */
function text(issues: Issues, value: unknown, path: string, required: boolean): value is string {
  if (value === undefined) {
    if (required) issues.add(path, 'REQUIRED', 'is required');
    return false;
  }
  if (typeof value !== 'string') {
    issues.add(path, 'INVALID_TYPE', 'must be a string');
    return false;
  }
  if (value.trim() === '') {
    issues.add(path, 'EMPTY', 'must not be empty or blank (empty elements are not allowed)', 'ibr-079');
    return false;
  }
  if (containsInvalidXmlCharacter(value)) {
    issues.add(path, 'INVALID_CHARACTER', 'contains a character that XML cannot carry');
    return false;
  }
  return true;
}

function date(issues: Issues, value: unknown, path: string, required: boolean): value is string {
  if (value === undefined) {
    if (required) issues.add(path, 'REQUIRED', 'is required');
    return false;
  }
  if (!isIsoDate(value)) {
    issues.add(path, 'INVALID_DATE', `must be a calendar date in the form YYYY-MM-DD (got ${JSON.stringify(value)})`, 'ibr-073');
    return false;
  }
  return true;
}

function minor(
  issues: Issues,
  value: unknown,
  path: string,
  options: { required: boolean; min?: number },
): value is number {
  if (value === undefined) {
    if (options.required) issues.add(path, 'REQUIRED', 'is required');
    return false;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    issues.add(path, 'INVALID_AMOUNT', 'must be an integer number of minor units (fils for AED), for example 4550 for 45.50');
    return false;
  }
  if (Math.abs(value) > MAX_AMOUNT_MINOR) {
    issues.add(path, 'AMOUNT_TOO_LARGE', `must not exceed ${MAX_AMOUNT_MINOR} minor units`);
    return false;
  }
  if (options.min !== undefined && value < options.min) {
    issues.add(path, 'NEGATIVE_AMOUNT', `must be at least ${options.min}`);
    return false;
  }
  return true;
}

function decimal(issues: Issues, value: DecimalInput | undefined, path: string, positive: boolean): Decimal | undefined {
  if (value === undefined) return undefined;
  const parsed = parseDecimal(value);
  if (!parsed) {
    issues.add(path, 'INVALID_DECIMAL', `must be a decimal number such as "2.5" (got ${JSON.stringify(value)})`);
    return undefined;
  }
  if (positive && parsed.units <= 0n) {
    issues.add(path, 'NOT_POSITIVE', 'must be greater than zero');
    return undefined;
  }
  if (!positive && parsed.units < 0n) {
    issues.add(path, 'NEGATIVE', 'must not be negative');
    return undefined;
  }
  return parsed;
}

function code(
  issues: Issues,
  value: unknown,
  allowed: ReadonlySet<string> | Record<string, unknown>,
  path: string,
  what: string,
  rule?: string,
): boolean {
  const known =
    typeof value === 'string' && (allowed instanceof Set ? allowed.has(value) : has(allowed as Record<string, unknown>, value));
  if (!known) issues.add(path, 'INVALID_CODE', `${JSON.stringify(value)} is not a valid ${what}`, rule);
  return known;
}

function validateAddress(issues: Issues, address: Address | undefined, path: string, rule: string): void {
  if (!address || typeof address !== 'object') {
    issues.add(path, 'REQUIRED', 'is required', rule);
    return;
  }
  for (const field of ['street', 'city', 'subdivision'] as const) {
    if (address[field] === undefined) issues.add(`${path}.${field}`, 'REQUIRED', 'is required', rule);
    else text(issues, address[field], `${path}.${field}`, true);
  }
  text(issues, address.additionalStreet, `${path}.additionalStreet`, false);
  text(issues, address.addressLine, `${path}.addressLine`, false);
  text(issues, address.postalZone, `${path}.postalZone`, false);
  if (code(issues, address.country, COUNTRY_CODES, `${path}.country`, 'ISO 3166-1 country code', 'ibr-cl-14')) {
    if (address.country === 'AE' && address.subdivision !== undefined && !has(EMIRATES, address.subdivision)) {
      issues.add(
        `${path}.subdivision`,
        'INVALID_EMIRATE',
        `must be one of ${Object.keys(EMIRATES).join(', ')} for an AE address (got ${JSON.stringify(address.subdivision)})`,
        'ibr-128-ae',
      );
    }
  }
}

function validateLegalRegistration(
  issues: Issues,
  registration: LegalRegistration,
  path: string,
  party: 'seller' | 'buyer',
): void {
  text(issues, registration.id, `${path}.id`, true);
  const rules =
    party === 'seller'
      ? { type: 'ibr-173-ae', authority: 'ibr-172-ae', passport: 'ibr-012-ae', passportList: 'ibr-013-ae' }
      : { type: 'ibr-183-ae', authority: 'ibr-101-ae', passport: 'ibr-010-ae', passportList: 'ibr-011-ae' };
  if (!code(issues, registration.type, LEGAL_REGISTRATION_TYPES, `${path}.type`, 'legal registration type (TL, EID, PAS or CD)', rules.type)) {
    return;
  }
  if (registration.type === 'TL') {
    if (registration.authority === undefined) {
      issues.add(`${path}.authority`, 'REQUIRED', 'the issuing authority is required for a trade licence', rules.authority);
    } else text(issues, registration.authority, `${path}.authority`, true);
  } else if (registration.authority !== undefined) {
    issues.add(`${path}.authority`, 'NOT_ALLOWED', 'is only used with type TL');
  }
  if (registration.type === 'PAS') {
    if (registration.passportCountry === undefined) {
      issues.add(`${path}.passportCountry`, 'REQUIRED', 'the passport issuing country is required for type PAS', rules.passport);
    } else {
      code(issues, registration.passportCountry, COUNTRY_CODES, `${path}.passportCountry`, 'ISO 3166-1 country code', rules.passportList);
    }
  } else if (registration.passportCountry !== undefined) {
    issues.add(`${path}.passportCountry`, 'NOT_ALLOWED', 'is only used with type PAS');
  }
}

function endpointScheme(party: Seller | Buyer): string {
  return party.endpoint?.scheme ?? PINT_AE.endpointScheme;
}

function validateEndpoint(issues: Issues, party: Seller | Buyer, path: string, role: 'seller' | 'buyer'): void {
  if (!party.endpoint || typeof party.endpoint !== 'object') {
    issues.add(path, 'REQUIRED', 'is required', role === 'seller' ? 'ibr-081' : 'ibr-080');
    return;
  }
  const scheme = endpointScheme(party);
  code(issues, scheme, ENDPOINT_SCHEME_CODES, `${path}.scheme`, 'Electronic Address Scheme code', 'ibr-cl-25');
  if (!text(issues, party.endpoint.id, `${path}.id`, true)) return;
  if (scheme === PINT_AE.endpointScheme) {
    const id = party.endpoint.id;
    if (role === 'seller' && !isValidTin(id)) {
      issues.add(`${path}.id`, 'INVALID_ENDPOINT', 'must be the seller TIN: 10 digits starting with 1');
    } else if (role === 'buyer' && !isValidUaeEndpoint(id)) {
      issues.add(
        `${path}.id`,
        'INVALID_ENDPOINT',
        'must be the buyer TIN (10 digits starting with 1) or a predefined endpoint (9900000097, 9900000098 or 9900000099)',
      );
    }
  }
}

function validateContact(issues: Issues, contact: Seller['contact'], path: string): void {
  if (contact === undefined) return;
  text(issues, contact.name, `${path}.name`, false);
  text(issues, contact.telephone, `${path}.telephone`, false);
  text(issues, contact.email, `${path}.email`, false);
}

interface DocumentContext {
  kind: 'Invoice' | 'CreditNote';
  typeCode: string;
  outOfScope: boolean;
  flags: Record<string, boolean>;
}

function validateSeller(issues: Issues, seller: Seller | undefined, ctx: DocumentContext): void {
  if (!seller || typeof seller !== 'object') {
    issues.add('seller', 'REQUIRED', 'is required');
    return;
  }
  text(issues, seller.name, 'seller.name', true);
  text(issues, seller.tradingName, 'seller.tradingName', false);
  text(issues, seller.legalForm, 'seller.legalForm', false);
  validateEndpoint(issues, seller, 'seller.endpoint', 'seller');
  validateAddress(issues, seller.address, 'seller.address', 'ibr-143-ae');
  validateContact(issues, seller.contact, 'seller.contact');

  if (seller.trn === undefined) {
    if (!ctx.outOfScope) {
      issues.add('seller.trn', 'REQUIRED', 'the seller VAT identifier (TRN) is required unless the document is out of scope of VAT (480 or 81)', 'ibr-134-ae');
    }
  } else if (text(issues, seller.trn, 'seller.trn', true) && seller.address?.country === 'AE' && !isValidTrn(seller.trn)) {
    issues.add('seller.trn', 'INVALID_TRN', 'must be 15 digits, start with 1 and end with 03', 'ibr-132-ae');
  }
  if (seller.tin !== undefined && text(issues, seller.tin, 'seller.tin', true) && !isValidTin(seller.tin)) {
    issues.add('seller.tin', 'INVALID_TIN', 'must be 10 digits starting with 1', 'ibr-148-ae');
  }
  if (ctx.flags['disclosedAgentBilling'] && seller.trn === undefined && seller.tin === undefined) {
    issues.add('seller', 'REQUIRED', 'a TRN or a TIN is required for disclosed agent billing', 'ibr-177-ae');
  }
  if (seller.legalRegistration === undefined) {
    if (endpointScheme(seller) === PINT_AE.endpointScheme) {
      issues.add('seller.legalRegistration', 'REQUIRED', 'is required when the seller endpoint scheme is 0235', 'ibr-150-ae');
    } else if (seller.trn === undefined) {
      issues.add('seller', 'REQUIRED', 'give a TRN or a legal registration so the buyer can identify the seller', 'ibr-co-26');
    }
  } else {
    validateLegalRegistration(issues, seller.legalRegistration, 'seller.legalRegistration', 'seller');
  }
}

function validateBuyer(issues: Issues, buyer: Buyer | undefined, ctx: DocumentContext): void {
  if (!buyer || typeof buyer !== 'object') {
    issues.add('buyer', 'REQUIRED', 'is required');
    return;
  }
  text(issues, buyer.name, 'buyer.name', true);
  text(issues, buyer.tradingName, 'buyer.tradingName', false);
  validateEndpoint(issues, buyer, 'buyer.endpoint', 'buyer');
  validateAddress(issues, buyer.address, 'buyer.address', 'ibr-144-ae');
  validateContact(issues, buyer.contact, 'buyer.contact');

  if (buyer.trn !== undefined && text(issues, buyer.trn, 'buyer.trn', true) && buyer.address?.country === 'AE' && !isValidTrn(buyer.trn)) {
    issues.add('buyer.trn', 'INVALID_TRN', 'must be 15 digits, start with 1 and end with 03', 'ibr-132-ae');
  }
  if (buyer.identifier !== undefined) {
    text(issues, buyer.identifier.id, 'buyer.identifier.id', true);
    if (buyer.identifier.scheme !== undefined) {
      code(issues, buyer.identifier.scheme, ICD_SCHEME_CODES, 'buyer.identifier.scheme', 'ISO 6523 ICD scheme code', 'ibr-cl-10');
    }
  }
  if (buyer.legalRegistration !== undefined) {
    validateLegalRegistration(issues, buyer.legalRegistration, 'buyer.legalRegistration', 'buyer');
  } else if (ctx.outOfScope) {
    issues.add('buyer.legalRegistration', 'REQUIRED', 'is required when the document is out of scope of VAT (480 or 81)', 'ibr-136-ae');
  }

  const endpointId = buyer.endpoint?.id;
  if (
    endpointScheme(buyer) === PINT_AE.endpointScheme &&
    typeof endpointId === 'string' &&
    !isValidTin(endpointId) &&
    !ctx.flags['exports'] &&
    buyer.identifier === undefined &&
    buyer.trn === undefined
  ) {
    issues.add('buyer', 'REQUIRED', 'give a buyer identifier or TRN when the buyer endpoint is a predefined endpoint', 'ibr-135-ae');
  }
  if (ctx.flags['deemedSupply'] && endpointId !== PREDEFINED_ENDPOINTS.deemedSupply) {
    issues.add('buyer.endpoint.id', 'PREDEFINED_ENDPOINT_REQUIRED', `must be ${PREDEFINED_ENDPOINTS.deemedSupply} for a deemed supply (BIS section 1.5.3)`);
  }
}

function validateAllowanceCharge(
  issues: Issues,
  ac: LineAllowanceCharge,
  path: string,
  isCharge: boolean,
  level: 'document' | 'line',
): void {
  const ids = {
    document: { allowance: ['ibr-031', 'ibr-033'], charge: ['ibr-036', 'ibr-038'] },
    line: { allowance: ['ibr-041', 'ibr-042'], charge: ['ibr-043', 'ibr-044'] },
  }[level][isCharge ? 'charge' : 'allowance'];
  const rules = {
    amount: ids[0] as string,
    reason: ids[1] as string,
    basePercent: isCharge ? 'aligned-ibrp-058' : 'aligned-ibrp-057',
    codeList: isCharge ? 'ibr-cl-20' : 'ibr-cl-19',
  };
  const hasPercent = ac.percent !== undefined;
  const hasBase = ac.baseAmount !== undefined;
  if (hasPercent !== hasBase) {
    issues.add(path, 'BASE_AND_PERCENT', 'give both a percent and a base amount, or neither', rules.basePercent);
  }
  if (ac.amount === undefined && !(hasPercent && hasBase)) {
    issues.add(`${path}.amount`, 'REQUIRED', 'give an amount, or a percent with a base amount', rules.amount);
  }
  minor(issues, ac.amount, `${path}.amount`, { required: false, min: 0 });
  minor(issues, ac.baseAmount, `${path}.baseAmount`, { required: false, min: 0 });
  decimal(issues, ac.percent, `${path}.percent`, false);
  if (ac.reason === undefined && ac.reasonCode === undefined) {
    issues.add(path, 'REASON_REQUIRED', 'give a reason or a reason code', rules.reason);
  }
  text(issues, ac.reason, `${path}.reason`, false);
  if (ac.reasonCode !== undefined) {
    code(
      issues,
      ac.reasonCode,
      isCharge ? CHARGE_REASON_CODES : ALLOWANCE_REASON_CODES,
      `${path}.reasonCode`,
      isCharge ? 'UNCL 7161 charge reason code' : 'UNCL 5189 allowance reason code',
      rules.codeList,
    );
  }
}

function validateDocumentAllowanceCharge(
  issues: Issues,
  ac: DocumentAllowanceCharge,
  path: string,
  isCharge: boolean,
  ctx: DocumentContext,
): void {
  validateAllowanceCharge(issues, ac, path, isCharge, 'document');
  const category = (ac.tax as { category?: unknown } | undefined)?.category;
  if (ac.tax === undefined) {
    issues.add(`${path}.tax`, 'REQUIRED', 'a VAT category is required on a document-level allowance or charge', isCharge ? 'aligned-ibrp-037' : 'aligned-ibrp-032');
    return;
  }
  if (!code(issues, category, new Set(SUPPORTED_TAX_CATEGORIES), `${path}.tax.category`, 'supported VAT category (S, Z, E, O or AE)', isCharge ? 'ibr-114-ae' : 'ibr-115-ae')) {
    return;
  }
  if (ac.tax.category === 'E') {
    if (ac.reasonCode === undefined) {
      issues.add(`${path}.reasonCode`, 'REQUIRED', 'an exempt (E) allowance or charge needs a reason code', isCharge ? 'ibr-169-ae' : 'ibr-168-ae');
    }
    if (ac.tax.exemptionReasonCode !== undefined) {
      code(issues, ac.tax.exemptionReasonCode, TAX_EXEMPTION_REASONS, `${path}.tax.exemptionReasonCode`, 'PINT AE exemption reason code');
    }
    text(issues, ac.tax.exemptionReason, `${path}.tax.exemptionReason`, false);
  }
  if (ctx.outOfScope && !['E', 'O', 'Z'].includes(ac.tax.category)) {
    issues.add(`${path}.tax.category`, 'CATEGORY_NOT_ALLOWED', 'must be E, O or Z when the document is out of scope of VAT (480 or 81)', 'ibr-122-ae');
  }
}

function validateLine(issues: Issues, line: LineInput, index: number, ctx: DocumentContext, buyer: Buyer | undefined): void {
  const path = `lines[${index}]`;
  if (!line || typeof line !== 'object') {
    issues.add(path, 'REQUIRED', 'must be an object');
    return;
  }
  if (line.id !== undefined) text(issues, line.id, `${path}.id`, true);
  text(issues, line.note, `${path}.note`, false);
  text(issues, line.orderLineReference, `${path}.orderLineReference`, false);

  if (line.quantity === undefined) issues.add(`${path}.quantity`, 'REQUIRED', 'is required', 'ibr-022');
  else decimal(issues, line.quantity, `${path}.quantity`, true);
  if (line.unitCode === undefined) issues.add(`${path}.unitCode`, 'REQUIRED', 'is required', 'ibr-023');
  else code(issues, line.unitCode, UNIT_CODES, `${path}.unitCode`, 'UN/ECE Recommendation 20 or 21 unit code', 'ibr-cl-23');

  const netOk = minor(issues, line.unitPrice, `${path}.unitPrice`, { required: true, min: 0 });
  const grossOk = minor(issues, line.grossUnitPrice, `${path}.grossUnitPrice`, { required: false, min: 0 });
  if (netOk && grossOk && line.grossUnitPrice !== undefined && line.grossUnitPrice < line.unitPrice) {
    issues.add(
      `${path}.grossUnitPrice`,
      'GROSS_BELOW_NET',
      'must not be lower than the net unit price; a price-level charge is not allowed',
      'ibr-083',
    );
  }
  if (line.priceBaseQuantity !== undefined) decimal(issues, line.priceBaseQuantity, `${path}.priceBaseQuantity`, true);

  (line.allowances ?? []).forEach((a, i) => validateAllowanceCharge(issues, a, `${path}.allowances[${i}]`, false, 'line'));
  (line.charges ?? []).forEach((c, i) => validateAllowanceCharge(issues, c, `${path}.charges[${i}]`, true, 'line'));

  if (line.period !== undefined) {
    const startOk = date(issues, line.period.start, `${path}.period.start`, false);
    const endOk = date(issues, line.period.end, `${path}.period.end`, false);
    if (line.period.start === undefined && line.period.end === undefined) {
      issues.add(`${path}.period`, 'REQUIRED', 'give a start date, an end date or both', 'ibr-co-20');
    }
    if (startOk && endOk && (line.period.end as string) < (line.period.start as string)) {
      issues.add(`${path}.period.end`, 'END_BEFORE_START', 'must not be before the start date', 'ibr-030');
    }
  }

  const item = line.item;
  if (!item || typeof item !== 'object') {
    issues.add(`${path}.item`, 'REQUIRED', 'is required', 'ibr-025');
  } else {
    text(issues, item.name, `${path}.item.name`, true);
    if (item.description === undefined) {
      issues.add(`${path}.item.description`, 'REQUIRED', 'is required', 'ibr-125-ae');
    } else text(issues, item.description, `${path}.item.description`, true);
    text(issues, item.sellerItemId, `${path}.item.sellerItemId`, false);
    text(issues, item.buyerItemId, `${path}.item.buyerItemId`, false);
    if (item.standardItemId !== undefined) {
      text(issues, item.standardItemId.id, `${path}.item.standardItemId.id`, true);
      code(issues, item.standardItemId.scheme, ICD_SCHEME_CODES, `${path}.item.standardItemId.scheme`, 'ISO 6523 ICD scheme code', 'ibr-cl-21');
    }
    if (item.originCountry !== undefined) {
      code(issues, item.originCountry, COUNTRY_CODES, `${path}.item.originCountry`, 'ISO 3166-1 country code', 'ibr-cl-15');
    }
    text(issues, item.hsCode, `${path}.item.hsCode`, false);
    text(issues, item.serviceAccountingCode, `${path}.item.serviceAccountingCode`, false);
    if (item.type !== undefined && code(issues, item.type, ITEM_TYPES, `${path}.item.type`, 'item type (G, S or B)')) {
      if ((item.type === 'G' || item.type === 'B') && item.hsCode === undefined) {
        issues.add(`${path}.item.hsCode`, 'REQUIRED', `an HS classification code is required for item type ${item.type}`, item.type === 'G' ? 'ibr-184-ae' : 'ibr-186-ae');
      }
      if ((item.type === 'S' || item.type === 'B') && item.serviceAccountingCode === undefined) {
        issues.add(`${path}.item.serviceAccountingCode`, 'REQUIRED', `a service accounting code is required for item type ${item.type}`, item.type === 'S' ? 'ibr-185-ae' : 'ibr-186-ae');
      }
    }
    if (item.reverseChargeGoods !== undefined) {
      code(issues, item.reverseChargeGoods, REVERSE_CHARGE_GOODS, `${path}.item.reverseChargeGoods`, 'reverse-charge goods code', 'ibr-006-ae');
    }
    (item.properties ?? []).forEach((p, i) => {
      text(issues, p?.name, `${path}.item.properties[${i}].name`, true);
      text(issues, p?.value, `${path}.item.properties[${i}].value`, true);
    });
  }

  const tax = line.tax as { category?: unknown } | undefined;
  if (!tax || typeof tax !== 'object') {
    issues.add(`${path}.tax`, 'REQUIRED', 'a VAT category is required on every line', 'ibr-145-ae');
    return;
  }
  if (tax.category === 'N') {
    issues.add(`${path}.tax.category`, 'UNSUPPORTED', 'category N (standard rate additional VAT, profit margin scheme) is not supported by this library');
    return;
  }
  if (!code(issues, tax.category, new Set(SUPPORTED_TAX_CATEGORIES), `${path}.tax.category`, 'VAT category (S, Z, E, O or AE)', 'ibr-139-ae')) {
    return;
  }
  const lineTax = line.tax;
  if (lineTax.category === 'E') {
    if (lineTax.exemptionReasonCode === undefined) {
      issues.add(`${path}.tax.exemptionReasonCode`, 'REQUIRED', 'an exempt line needs an exemption reason code such as DL8.46.2', 'ibr-167-ae');
    } else {
      code(issues, lineTax.exemptionReasonCode, TAX_EXEMPTION_REASONS, `${path}.tax.exemptionReasonCode`, 'PINT AE exemption reason code');
    }
    text(issues, lineTax.exemptionReason, `${path}.tax.exemptionReason`, false);
  }
  if (lineTax.category === 'AE') {
    if (item?.reverseChargeGoods === undefined) {
      issues.add(`${path}.item.reverseChargeGoods`, 'REQUIRED', 'a reverse-charge line needs the type of goods or services (BTAE-09)', 'ibr-166-ae');
    }
    if (item?.standardItemId?.scheme !== '0160') {
      issues.add(`${path}.item.standardItemId`, 'REQUIRED', 'a reverse-charge line needs a standard item identifier with scheme 0160 (GTIN)', 'ibr-174-ae');
    }
    if (buyer && buyer.trn === undefined) {
      issues.add('buyer.trn', 'REQUIRED', 'the buyer TRN is required when a line is reverse charged (AE)', 'ibr-103-ae');
    }
  }
  if (ctx.outOfScope && !['E', 'O', 'Z'].includes(lineTax.category)) {
    issues.add(`${path}.tax.category`, 'CATEGORY_NOT_ALLOWED', 'must be E, O or Z when the document is out of scope of VAT (480 or 81)', 'ibr-122-ae');
  }
}

function validateDelivery(issues: Issues, delivery: Delivery | undefined, ctx: DocumentContext): void {
  const needsAddress = (flag: string, rule: string, allowAeCountry: boolean): void => {
    if (!ctx.flags[flag]) return;
    const address = delivery?.address;
    if (allowAeCountry && address?.country === 'AE') return;
    if (!address || address.street === undefined || address.city === undefined || address.subdivision === undefined) {
      issues.add('delivery.address', 'REQUIRED', `street, city and subdivision of the deliver-to address are required for ${flag === 'exports' ? 'exports delivered outside the UAE' : 'e-commerce supplies'}`, rule);
    }
  };
  needsAddress('eCommerce', 'ibr-142-ae', false);
  needsAddress('exports', 'ibr-152-ae', true);
  if (delivery === undefined) return;
  date(issues, delivery.date, 'delivery.date', false);
  text(issues, delivery.partyName, 'delivery.partyName', false);
  text(issues, delivery.incoterms, 'delivery.incoterms', false);
  if (delivery.locationId !== undefined) {
    text(issues, delivery.locationId.id, 'delivery.locationId.id', true);
    if (delivery.locationId.scheme !== undefined) {
      code(issues, delivery.locationId.scheme, ICD_SCHEME_CODES, 'delivery.locationId.scheme', 'ISO 6523 ICD scheme code', 'ibr-cl-26');
    }
  }
  const address = delivery.address;
  if (address !== undefined) {
    code(issues, address.country, COUNTRY_CODES, 'delivery.address.country', 'ISO 3166-1 country code', 'ibr-057');
    for (const field of ['street', 'additionalStreet', 'city', 'postalZone', 'subdivision'] as const) {
      text(issues, address[field], `delivery.address.${field}`, false);
    }
  }
  if (delivery.date === undefined && delivery.locationId === undefined && address === undefined && delivery.partyName === undefined && delivery.incoterms === undefined) {
    issues.add('delivery', 'EMPTY', 'give at least one delivery detail or leave delivery out', 'ibr-079');
  }
}

function validatePaymentMeans(issues: Issues, means: PaymentMeans[] | undefined, ctx: DocumentContext): void {
  const exempt = ctx.kind === 'CreditNote' || ctx.flags['deemedSupply'];
  if ((means === undefined || means.length === 0) && !exempt) {
    issues.add('paymentMeans', 'REQUIRED', 'at least one payment means is required on an invoice', 'ibr-191-ae');
  }
  let cards = 0;
  (means ?? []).forEach((m, i) => {
    const path = `paymentMeans[${i}]`;
    code(issues, m.code, PAYMENT_MEANS_CODES, `${path}.code`, 'UNCL 4461 payment means code', 'ibr-cl-16');
    text(issues, m.name, `${path}.name`, false);
    text(issues, m.paymentId, `${path}.paymentId`, false);
    if (m.account !== undefined) {
      text(issues, m.account.id, `${path}.account.id`, true);
      text(issues, m.account.name, `${path}.account.name`, false);
      text(issues, m.account.financialInstitutionId, `${path}.account.financialInstitutionId`, false);
    } else if (m.code === '30') {
      issues.add(`${path}.account.id`, 'REQUIRED', 'a credit transfer (code 30) needs the payee account identifier', 'ibr-192-ae');
    }
    if (m.card !== undefined) {
      cards += 1;
      text(issues, m.card.primaryAccountNumberId, `${path}.card.primaryAccountNumberId`, true);
      text(issues, m.card.network, `${path}.card.network`, true);
      text(issues, m.card.holderName, `${path}.card.holderName`, false);
    }
  });
  if (cards > 1) issues.add('paymentMeans', 'TOO_MANY_CARDS', 'at most one payment card account is allowed', 'ibr-066');
}

type CommonInput = InvoiceInput | CreditNoteInput;

function validateCommon(issues: Issues, input: CommonInput, ctx: DocumentContext): void {
  text(issues, input.id, 'id', true);
  text(issues, input.uuid, 'uuid', false);
  date(issues, input.issueDate, 'issueDate', true);
  if (input.issueTime !== undefined && (typeof input.issueTime !== 'string' || !ISO_TIME.test(input.issueTime))) {
    issues.add('issueTime', 'INVALID_TIME', 'must be hh:mm:ss with an optional time zone, for example 09:30:00+04:00', 'ibr-119');
  }
  text(issues, input.note, 'note', false);
  text(issues, input.buyerReference, 'buyerReference', false);
  text(issues, input.contractReference, 'contractReference', false);
  text(issues, input.projectReference, 'projectReference', false);
  text(issues, input.customsReference, 'customsReference', false);
  text(issues, input.paymentTerms, 'paymentTerms', false);
  if (input.orderReference !== undefined) {
    text(issues, input.orderReference.id, 'orderReference.id', true);
    text(issues, input.orderReference.salesOrderId, 'orderReference.salesOrderId', false);
  }

  if (code(issues, input.currency, CURRENCY_CODES, 'currency', 'ISO 4217 currency code', 'ibr-cl-04')) {
    if (input.currency === PINT_AE.taxCurrency) {
      if (input.exchangeRate !== undefined) {
        issues.add('exchangeRate', 'NOT_ALLOWED', 'is only used when the document currency is not AED', 'ibr-077');
      }
    } else if (input.exchangeRate === undefined) {
      issues.add('exchangeRate', 'REQUIRED', 'the AED exchange rate is required when the document currency is not AED', 'ibr-159-ae');
    } else {
      const rate = decimal(issues, input.exchangeRate, 'exchangeRate', true);
      if (rate && fractionDigits(rate) > 6) {
        issues.add('exchangeRate', 'TOO_PRECISE', 'must have at most 6 decimals', 'ibr-002-ae');
      }
    }
  }

  if (input.invoicePeriod !== undefined) {
    const period = input.invoicePeriod;
    const startOk = date(issues, period.start, 'invoicePeriod.start', false);
    const endOk = date(issues, period.end, 'invoicePeriod.end', false);
    if (period.start === undefined && period.end === undefined && period.frequency === undefined) {
      issues.add('invoicePeriod', 'REQUIRED', 'give a start date, an end date or a billing frequency', 'ibr-co-19');
    }
    if (startOk && endOk && (period.end as string) < (period.start as string)) {
      issues.add('invoicePeriod.end', 'END_BEFORE_START', 'must not be before the start date', 'ibr-029');
    }
    if (period.frequency !== undefined) {
      code(issues, period.frequency, BILLING_FREQUENCIES, 'invoicePeriod.frequency', 'billing frequency code', 'ibr-005-ae');
      if (period.frequency === 'OTH' && input.note === undefined) {
        issues.add('note', 'REQUIRED', 'describe the billing frequency in the note when the frequency is OTH', 'ibr-160-ae');
      }
    }
  }

  const flags = input.transactionType ?? {};
  for (const key of Object.keys(flags)) {
    if (!(TRANSACTION_TYPE_FLAGS as readonly string[]).includes(key)) {
      issues.add(`transactionType.${key}`, 'UNKNOWN_FLAG', `is not a transaction type; use ${TRANSACTION_TYPE_FLAGS.join(', ')}`);
    }
  }
  if (flags.profitMarginScheme) {
    issues.add('transactionType.profitMarginScheme', 'UNSUPPORTED', 'the profit margin scheme needs VAT category N, which this library does not support');
  }
  if (ctx.outOfScope && (flags.summaryInvoice || flags.deemedSupply || flags.profitMarginScheme)) {
    issues.add('transactionType', 'NOT_ALLOWED', 'summary invoice, deemed supply and profit margin scheme are not allowed out of scope of VAT (480 or 81)', 'ibr-157-ae');
  }
  if (flags.freeTradeZone && input.beneficiaryId === undefined) {
    issues.add('beneficiaryId', 'REQUIRED', 'the beneficiary identifier is required for a free trade zone supply', 'ibr-007-ae');
  }
  text(issues, input.beneficiaryId, 'beneficiaryId', false);
  if (flags.disclosedAgentBilling) {
    if (input.principalId === undefined) {
      issues.add('principalId', 'REQUIRED', 'the principal identifier is required for disclosed agent billing', 'ibr-137-ae');
    } else if (text(issues, input.principalId, 'principalId', true)) {
      if (!isValidTrn(input.principalId)) {
        issues.add('principalId', 'INVALID_TRN', 'must be the principal TRN: 15 digits, start with 1 and end with 03', 'ibr-132-ae');
      }
      if (input.principalId === input.seller?.trn) {
        issues.add('principalId', 'SAME_AS_SELLER', 'must differ from the seller VAT identifier', 'ibr-176-ae');
      }
    }
  } else {
    text(issues, input.principalId, 'principalId', false);
  }
  if (flags.summaryInvoice && input.invoicePeriod === undefined) {
    issues.add('invoicePeriod', 'REQUIRED', 'the invoicing period is required for a summary invoice', 'ibr-138-ae');
  }

  validateSeller(issues, input.seller, ctx);
  validateBuyer(issues, input.buyer, ctx);
  validateDelivery(issues, input.delivery, ctx);
  validatePaymentMeans(issues, input.paymentMeans, ctx);

  (input.allowances ?? []).forEach((a, i) => validateDocumentAllowanceCharge(issues, a, `allowances[${i}]`, false, ctx));
  (input.charges ?? []).forEach((c, i) => validateDocumentAllowanceCharge(issues, c, `charges[${i}]`, true, ctx));

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    issues.add('lines', 'REQUIRED', 'at least one line is required', 'ibr-016');
  } else {
    const ids = new Set<string>();
    input.lines.forEach((line, index) => {
      validateLine(issues, line, index, ctx, input.buyer);
      const id = line?.id ?? String(index + 1);
      if (ids.has(id)) issues.add(`lines[${index}].id`, 'DUPLICATE_LINE_ID', `line identifier ${id} is used twice`);
      ids.add(id);
      if (input.invoicePeriod && line?.period) {
        const { start, end } = input.invoicePeriod;
        if (line.period.start && start && isIsoDate(line.period.start) && line.period.start < start) {
          issues.add(`lines[${index}].period.start`, 'OUTSIDE_INVOICE_PERIOD', 'must be within the invoicing period', 'ibr-085');
        }
        if (line.period.end && end && isIsoDate(line.period.end) && line.period.end > end) {
          issues.add(`lines[${index}].period.end`, 'OUTSIDE_INVOICE_PERIOD', 'must be within the invoicing period', 'ibr-086');
        }
      }
    });
    if (!ctx.outOfScope && input.lines.every((line) => ['E', 'O'].includes(String((line?.tax as { category?: unknown } | undefined)?.category)))) {
      issues.add(
        'lines',
        'ONLY_EXEMPT_OR_OUT_OF_SCOPE',
        `a ${ctx.kind === 'Invoice' ? 'tax invoice (380)' : 'tax credit note (381)'} needs at least one line that is not E or O; use type ${ctx.kind === 'Invoice' ? '480' : '81'} instead`,
        'ibr-151-ae',
      );
    }
  }

  minor(issues, input.prepaidAmount, 'prepaidAmount', { required: false, min: 0 });
  minor(issues, input.roundingAmount, 'roundingAmount', { required: false });
  if (input.vatRounding !== undefined && input.vatRounding !== 'category' && input.vatRounding !== 'line') {
    issues.add('vatRounding', 'INVALID_OPTION', 'must be "category" or "line"');
  }
}

function transactionFlags(input: CommonInput): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(input.transactionType ?? {})) flags[key] = value === true;
  return flags;
}

export function validateInvoiceInput(input: InvoiceInput): ValidationIssue[] {
  const issues = new Issues();
  if (!input || typeof input !== 'object') {
    issues.add('', 'INVALID_INPUT', 'the invoice input must be an object');
    return issues.list;
  }
  const typeCode = input.typeCode ?? '380';
  code(issues, typeCode, INVOICE_TYPE_CODES, 'typeCode', 'invoice type code (380 or 480)', 'ibr-cl-01');
  const ctx: DocumentContext = { kind: 'Invoice', typeCode, outOfScope: typeCode === '480', flags: transactionFlags(input) };
  validateCommon(issues, input, ctx);
  date(issues, input.dueDate, 'dueDate', false);
  if (date(issues, input.taxPointDate, 'taxPointDate', false) && isIsoDate(input.issueDate) && !(input.taxPointDate < input.issueDate)) {
    issues.add('taxPointDate', 'NOT_BEFORE_ISSUE_DATE', 'must be before the issue date', 'ibr-141-ae');
  }
  return issues.list;
}

export function validateCreditNoteInput(input: CreditNoteInput): ValidationIssue[] {
  const issues = new Issues();
  if (!input || typeof input !== 'object') {
    issues.add('', 'INVALID_INPUT', 'the credit note input must be an object');
    return issues.list;
  }
  const typeCode = input.typeCode ?? '381';
  code(issues, typeCode, CREDIT_NOTE_TYPE_CODES, 'typeCode', 'credit note type code (381 or 81)', 'ibr-cl-01');
  const ctx: DocumentContext = { kind: 'CreditNote', typeCode, outOfScope: typeCode === '81', flags: transactionFlags(input) };
  validateCommon(issues, input, ctx);

  // Fields that exist on invoices only; plain JavaScript callers could still pass them.
  const loose = input as unknown as Record<string, unknown>;
  if (loose['taxPointDate'] !== undefined) {
    issues.add('taxPointDate', 'NOT_ALLOWED', 'a credit note must not carry a VAT point date', 'ibr-124-ae');
  }
  if (loose['dueDate'] !== undefined) {
    issues.add('dueDate', 'NOT_ALLOWED', 'the UBL 2.1 CreditNote has no due date element');
  }

  if (input.reason === undefined) {
    issues.add('reason', 'REQUIRED', 'the credit note reason code (BTAE-03) is required', 'ibr-158-ae');
    return issues.list;
  }
  if (!code(issues, input.reason, CREDIT_NOTE_REASONS, 'reason', 'credit note reason code', 'ibr-001-ae')) return issues.list;
  const preceding = input.precedingInvoices ?? [];
  if (input.reason === 'VD') {
    if (preceding.length > 0) {
      issues.add(
        'precedingInvoices',
        'NOT_ALLOWED',
        'rule ibr-055-ae as published rejects a preceding invoice reference on a volume discount (VD) credit note',
        'ibr-055-ae',
      );
    }
  } else if (preceding.length === 0) {
    issues.add('precedingInvoices', 'REQUIRED', 'reference the credited invoice (only volume discount credit notes may omit it)', 'ibr-055-ae');
  }
  preceding.forEach((ref, i) => {
    text(issues, ref?.id, `precedingInvoices[${i}].id`, true);
    date(issues, ref?.issueDate, `precedingInvoices[${i}].issueDate`, false);
  });
  return issues.list;
}

