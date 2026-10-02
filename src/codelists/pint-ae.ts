/**
 * PINT AE code lists with their names, copied from the genericode files published with
 * PINT AE Billing 1.0.4 (https://docs.peppol.eu/poac/ae/pint-ae/trn-invoice/codelist/).
 * Code values are facts from the specification; the names are kept for error messages.
 */

/**
 * VAT category codes (Aligned-TaxCategoryCodes, version D.16B).
 *
 * The published genericode file spells the last code with a Greek capital Nu (U+039D),
 * while the Schematron rules test for the Latin letter N. The Latin form is used here
 * because it is what the validator accepts.
 */
export const TAX_CATEGORIES = {
  S: 'Standard rate',
  E: 'Exempt from tax',
  O: 'Services outside scope of tax / Not subject to tax',
  AE: 'VAT Reverse Charge',
  Z: 'Zero rated',
  N: 'Standard rate additional VAT',
} as const;

export type TaxCategoryCode = keyof typeof TAX_CATEGORIES;

/**
 * Categories this library can build. N (standard rate additional VAT, used with the
 * profit margin scheme) is not supported; see docs/decisions.md.
 */
export const SUPPORTED_TAX_CATEGORIES = ['S', 'Z', 'E', 'O', 'AE'] as const;
export type SupportedTaxCategory = (typeof SUPPORTED_TAX_CATEGORIES)[number];

/** Reasons for exemption from tax (Aligned-TaxExemptionCodes, version 2022). */
export const TAX_EXEMPTION_REASONS = {
  'DL8.46.1': 'Certain financial services',
  'DL8.46.2': 'Supply of residential units (lease or sale)',
  'DL8.46.3': 'Bare land',
  'DL8.46.4': 'Local passenger transport',
} as const;

export type TaxExemptionReasonCode = keyof typeof TAX_EXEMPTION_REASONS;

/** Reasons for credit note (CreditReason, version 1), BTAE-03. */
export const CREDIT_NOTE_REASONS = {
  'DL8.61.1.A': 'The supply was cancelled',
  'DL8.61.1.B': 'The tax treatment of the supply changed because the nature of the supply changed',
  'DL8.61.1.C': 'The previously agreed consideration was altered (for example bad debt relief)',
  'DL8.61.1.D': 'The goods or services were returned in full or in part and the consideration was returned',
  'DL8.61.1.E': 'The tax was charged or the tax treatment was applied in error',
  VD: 'Volume discount',
} as const;

export type CreditNoteReasonCode = keyof typeof CREDIT_NOTE_REASONS;

/** Frequency of billing (FreqBilling, version 1), BTAE-06. */
export const BILLING_FREQUENCIES = {
  DLY: 'Daily',
  WKY: 'Weekly',
  Q15: 'Once in 15 days',
  MTH: 'Monthly',
  Q45: 'Once in 45 days',
  Q60: 'Once in 60 days',
  QTR: 'Quarterly',
  YRL: 'Yearly',
  HYR: 'Half-yearly',
  OTH: 'Others',
} as const;

export type BillingFrequencyCode = keyof typeof BILLING_FREQUENCIES;

/** Type of goods or services subject to the reverse charge mechanism (GoodsType, version 1), BTAE-09. */
export const REVERSE_CHARGE_GOODS = {
  'DL8.48.8.2': 'Electronic devices',
  'DL8.48.8.1': 'Gold and diamonds',
  'DL8.48.3.1': 'Crude or refined oil',
  'DL8.48.3.2': 'Unprocessed or processed natural gas',
  'DL8.48.3.3': 'Pure hydrocarbons',
} as const;

export type ReverseChargeGoodsCode = keyof typeof REVERSE_CHARGE_GOODS;

/** Item type (ItemType, version 1), BTAE-13. */
export const ITEM_TYPES = {
  G: 'Goods',
  S: 'Services',
  B: 'Both',
} as const;

export type ItemTypeCode = keyof typeof ITEM_TYPES;

/** Seller and buyer legal registration identifier types, BTAE-15 and BTAE-16 (BIS section 1.6). */
export const LEGAL_REGISTRATION_TYPES = {
  TL: 'Commercial/Trade license',
  EID: 'Emirates ID',
  PAS: 'Passport',
  CD: 'Cabinet Decision',
} as const;

export type LegalRegistrationType = keyof typeof LEGAL_REGISTRATION_TYPES;

/** Emirate codes for the country subdivision of AE addresses (rule ibr-128-ae). */
export const EMIRATES = {
  AUH: 'Abu Dhabi',
  DXB: 'Dubai',
  SHJ: 'Sharjah',
  AJM: 'Ajman',
  UAQ: 'Umm Al Quwain',
  RAK: 'Ras Al Khaimah',
  FUJ: 'Fujairah',
} as const;

export type EmirateCode = keyof typeof EMIRATES;

/**
 * Invoice transaction type flags (transactiontype, version 1), BTAE-02, in the order of
 * the eight positions of cbc:ProfileExecutionID.
 */
export const TRANSACTION_TYPE_FLAGS = [
  'freeTradeZone',
  'deemedSupply',
  'profitMarginScheme',
  'summaryInvoice',
  'continuousSupply',
  'disclosedAgentBilling',
  'eCommerce',
  'exports',
] as const;

export type TransactionTypeFlag = (typeof TRANSACTION_TYPE_FLAGS)[number];

/** Invoice type codes allowed by PINT AE billing (rule ibr-cl-01). */
export const INVOICE_TYPE_CODES = {
  '380': 'Commercial invoice (tax invoice)',
  '480': 'Invoice out of scope of tax',
} as const;

export type InvoiceTypeCode = keyof typeof INVOICE_TYPE_CODES;

/** Credit note type codes allowed by PINT AE billing (rule ibr-cl-01). */
export const CREDIT_NOTE_TYPE_CODES = {
  '381': 'Credit note (tax credit note)',
  '81': 'Credit note related to goods or services (out of scope of tax)',
} as const;

export type CreditNoteTypeCode = keyof typeof CREDIT_NOTE_TYPE_CODES;
