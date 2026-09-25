/**
 * Typed input model. Field comments name the PINT AE business term (IBT-xxx for the PINT
 * semantic model, BTAE-xx for UAE-specific terms) that each field fills.
 *
 * Money is always an integer number of minor units (fils for AED). Quantities, percentages
 * and exchange rates are decimal strings (numbers are accepted when they print in plain
 * decimal notation) so that no digit is lost to binary floating point.
 */
import type {
  BillingFrequencyCode,
  CreditNoteReasonCode,
  CreditNoteTypeCode,
  InvoiceTypeCode,
  ItemTypeCode,
  LegalRegistrationType,
  ReverseChargeGoodsCode,
  TaxExemptionReasonCode,
  TransactionTypeFlag,
} from './codelists/pint-ae.js';
import type { MinorUnits } from './money.js';

/** Calendar date in ISO 8601 form YYYY-MM-DD, without a time zone. */
export type IsoDate = string;

/** Decimal text such as "2.5"; a number is accepted when it prints in plain decimal form. */
export type DecimalInput = string | number;

export interface Address {
  /** IBT-035 / IBT-050, address line 1 (required by ibr-143-ae and ibr-144-ae). */
  street: string;
  /** IBT-036 / IBT-051. */
  additionalStreet?: string;
  /** IBT-162 / IBT-163, a third address line. */
  addressLine?: string;
  /** IBT-037 / IBT-052. */
  city: string;
  /** IBT-038 / IBT-053. */
  postalZone?: string;
  /**
   * IBT-039 / IBT-054, country subdivision. For an AE address this must be an emirate
   * code: AUH, DXB, SHJ, AJM, UAQ, RAK or FUJ (ibr-128-ae).
   */
  subdivision: string;
  /** IBT-040 / IBT-055, ISO 3166-1 alpha-2 country code. */
  country: string;
}

export interface Endpoint {
  /** Electronic Address Scheme code. Defaults to "0235", the UAE scheme. */
  scheme?: string;
  /** For scheme 0235: the party's TIN (1 followed by 9 digits) or a predefined endpoint. */
  id: string;
}

export interface LegalRegistration {
  /** IBT-030 / IBT-047, the registration number. */
  id: string;
  /** BTAE-15 / BTAE-16: TL trade licence, EID Emirates ID, PAS passport, CD Cabinet Decision. */
  type: LegalRegistrationType;
  /** BTAE-12 / BTAE-11, the issuing authority. Required when type is TL. */
  authority?: string;
  /** BTAE-18 / BTAE-19, ISO 3166-1 code of the issuing country. Required when type is PAS. */
  passportCountry?: string;
}

export interface Contact {
  name?: string;
  telephone?: string;
  email?: string;
}

interface PartyBase {
  /** IBT-027 / IBT-044, registered legal name. */
  name: string;
  /** IBT-028 / IBT-045, trading name. */
  tradingName?: string;
  /** IBT-034 / IBT-049, Peppol electronic address. */
  endpoint: Endpoint;
  address: Address;
  /** IBT-031 / IBT-048, VAT identifier (TRN): 15 digits, starts with 1, ends with 03. */
  trn?: string;
  legalRegistration?: LegalRegistration;
  contact?: Contact;
}

export interface Seller extends PartyBase {
  /** IBT-032, seller tax registration identifier (TIN), 10 digits starting with 1. */
  tin?: string;
  /** IBT-033, additional legal information such as the legal form. */
  legalForm?: string;
}

export interface Buyer extends PartyBase {
  /** IBT-046, buyer identifier. The scheme, when given, must be an ISO 6523 ICD code. */
  identifier?: { id: string; scheme?: string };
}

/** An allowance or charge on an invoice line (IBG-27, IBG-28). It carries no VAT category. */
export interface LineAllowanceCharge {
  /** IBT-136 / IBT-141. Give either this or percent with baseAmount (or all three). */
  amount?: MinorUnits;
  /** IBT-138 / IBT-143, for example "10" for 10 %. */
  percent?: DecimalInput;
  /** IBT-137 / IBT-142. */
  baseAmount?: MinorUnits;
  /** IBT-140 (UNCL 5189) for allowances, IBT-145 (UNCL 7161) for charges. */
  reasonCode?: string;
  /** IBT-139 / IBT-144. A reason or a reason code is required. */
  reason?: string;
}

/**
 * VAT of an invoice line. Rates are fixed by the category because the UAE has one
 * standard rate: S and AE use 5 %, Z uses 0 %, E and O carry no rate.
 */
export type LineTax =
  | { category: 'S' }
  | { category: 'Z' }
  | { category: 'O' }
  | { category: 'AE' }
  | {
      category: 'E';
      /** IBT-186, reason for exemption (ibr-167-ae), for example DL8.46.2. */
      exemptionReasonCode: TaxExemptionReasonCode;
      /** IBT-185, optional free text. */
      exemptionReason?: string;
    };

/** VAT of a document-level allowance or charge (IBT-095 / IBT-102). */
export type DocumentLevelTax =
  | { category: 'S' }
  | { category: 'Z' }
  | { category: 'O' }
  | { category: 'AE' }
  | { category: 'E'; exemptionReasonCode?: TaxExemptionReasonCode; exemptionReason?: string };

/** A document-level allowance (IBG-20) or charge (IBG-21). */
export interface DocumentAllowanceCharge extends LineAllowanceCharge {
  tax: DocumentLevelTax;
}

export interface Item {
  /** IBT-153. */
  name: string;
  /** IBT-154, required by ibr-125-ae. */
  description: string;
  /** IBT-155, the seller's article number (for example a SKU). */
  sellerItemId?: string;
  /** IBT-156. */
  buyerItemId?: string;
  /** IBT-157 with IBT-157-1 (ISO 6523 ICD, for example 0160 for GTIN). */
  standardItemId?: { id: string; scheme: string };
  /** IBT-159, ISO 3166-1 alpha-2. */
  originCountry?: string;
  /** BTAE-13: G goods, S services, B both. */
  type?: ItemTypeCode;
  /** IBT-158 with scheme HS; required when type is G or B (ibr-184-ae, ibr-186-ae). */
  hsCode?: string;
  /** BTAE-17 with scheme SAC; required when type is S or B (ibr-185-ae, ibr-186-ae). */
  serviceAccountingCode?: string;
  /** BTAE-09, required for reverse-charge (AE) lines (ibr-166-ae). */
  reverseChargeGoods?: ReverseChargeGoodsCode;
  /** IBG-32 item attributes. */
  properties?: { name: string; value: string }[];
}

export interface LineInput {
  /** IBT-126. Defaults to the 1-based position of the line. */
  id?: string;
  /** IBT-127. */
  note?: string;
  /** IBT-129, must be greater than zero. */
  quantity: DecimalInput;
  /** IBT-130, UN/ECE Recommendation 20 or 21 code, for example H87 (piece) or MTR (metre). */
  unitCode: string;
  /** IBT-146, item net price per price base quantity, in minor units. */
  unitPrice: MinorUnits;
  /** IBT-148, item gross price before the price discount. Defaults to the net price. */
  grossUnitPrice?: MinorUnits;
  /** IBT-149, the quantity the price refers to. Defaults to 1. */
  priceBaseQuantity?: DecimalInput;
  allowances?: LineAllowanceCharge[];
  charges?: LineAllowanceCharge[];
  item: Item;
  tax: LineTax;
  /** IBT-132, purchase order line reference. */
  orderLineReference?: string;
  /** IBG-26, invoice line period. */
  period?: { start?: IsoDate; end?: IsoDate };
}

export interface DeliveryAddress {
  street?: string;
  additionalStreet?: string;
  city?: string;
  postalZone?: string;
  subdivision?: string;
  /** IBT-080, required. */
  country: string;
}

export interface Delivery {
  /** IBT-072, actual delivery date. */
  date?: IsoDate;
  /** IBT-071 with an optional ISO 6523 ICD scheme. */
  locationId?: { id: string; scheme?: string };
  /** IBG-15, deliver-to address. */
  address?: DeliveryAddress;
  /** IBT-070. */
  partyName?: string;
  /** BTAE-22, Incoterms code such as CIF. */
  incoterms?: string;
}

export interface PaymentMeans {
  /** IBT-081, UNCL 4461 code: 30 credit transfer, 10 cash, 48/54/55 card, and so on. */
  code: string;
  /** IBT-082, payment means text. */
  name?: string;
  /** IBT-083, remittance information. */
  paymentId?: string;
  /** IBG-17. The account identifier (IBT-084) is required for code 30 (ibr-192-ae). */
  account?: { id: string; name?: string; financialInstitutionId?: string };
  /**
   * IBG-18, card details. IBT-087 must not be the full card number: give the last four
   * digits, optionally masked (for example XXXXXXXXXXXX1234); at most the first six and
   * the last four digits may be shown. Anything else is refused.
   */
  card?: { primaryAccountNumberId: string; network: string; holderName?: string };
}

/** Special transaction types (BTAE-02). Every flag defaults to false. */
export type TransactionType = Partial<Record<TransactionTypeFlag, boolean>>;

interface DocumentInputBase {
  /** IBT-001, the document number. */
  id: string;
  /** BTAE-07, unique identifier. A random UUID is generated when it is omitted. */
  uuid?: string;
  /** IBT-002. */
  issueDate: IsoDate;
  /** IBT-168, hh:mm:ss with an optional time zone such as +04:00. */
  issueTime?: string;
  /** IBT-022, a single invoice note (ibr-sr-51). */
  note?: string;
  /** IBT-005, ISO 4217 code. */
  currency: string;
  /**
   * BTAE-04, AED per one unit of the document currency, at most 6 decimals (ibr-002-ae).
   * Required when the currency is not AED (ibr-159-ae), and only allowed then.
   */
  exchangeRate?: DecimalInput;
  /** IBT-010. */
  buyerReference?: string;
  /** IBT-013 purchase order reference and IBT-014 sales order reference. */
  orderReference?: { id: string; salesOrderId?: string };
  /** IBT-012. */
  contractReference?: string;
  /** IBT-011. */
  projectReference?: string;
  /** IBG-14 with BTAE-06 frequency of billing. */
  invoicePeriod?: { start?: IsoDate; end?: IsoDate; frequency?: BillingFrequencyCode };
  /** BTAE-02. */
  transactionType?: TransactionType;
  seller: Seller;
  buyer: Buyer;
  /** BTAE-01, beneficiary identifier, required for free trade zone supplies (ibr-007-ae). */
  beneficiaryId?: string;
  /** BTAE-14, principal identifier (TRN), required for disclosed agent billing (ibr-137-ae). */
  principalId?: string;
  delivery?: Delivery;
  /** BTAE-21, customs declaration reference for exports. */
  customsReference?: string;
  paymentMeans?: PaymentMeans[];
  /** IBT-020, payment terms text. */
  paymentTerms?: string;
  /** IBG-20. */
  allowances?: DocumentAllowanceCharge[];
  /** IBG-21. */
  charges?: DocumentAllowanceCharge[];
  /** IBG-25, at least one line. */
  lines: LineInput[];
  /** IBT-113, amount already paid, in minor units. */
  prepaidAmount?: MinorUnits;
  /** IBT-114, rounding added to the amount due, in minor units (may be negative). */
  roundingAmount?: MinorUnits;
  /**
   * How the VAT of each category is rounded:
   * - "category" (default): VAT = taxable amount x rate, rounded once per category.
   * - "line": VAT = sum of the rounded VAT of each line, plus VAT on document-level
   *   charges minus VAT on allowances. Accepted only while the result stays within the
   *   0.02 tolerance of rule aligned-ibrp-s-09.
   */
  vatRounding?: 'category' | 'line';
}

export interface InvoiceInput extends DocumentInputBase {
  /** IBT-003: 380 tax invoice (default) or 480 invoice out of scope of tax. */
  typeCode?: InvoiceTypeCode;
  /** IBT-009, required when an amount is due (ibr-127-ae). */
  dueDate?: IsoDate;
  /** IBT-007, VAT point date; must be before the issue date (ibr-141-ae). */
  taxPointDate?: IsoDate;
}

export interface PrecedingInvoiceReference {
  /** IBT-025. */
  id: string;
  /** IBT-026. */
  issueDate?: IsoDate;
}

export interface CreditNoteInput extends DocumentInputBase {
  /** IBT-003: 381 tax credit note (default) or 81 credit note out of scope of tax. */
  typeCode?: CreditNoteTypeCode;
  /** BTAE-03, reason for the credit note. */
  reason: CreditNoteReasonCode;
  /**
   * IBG-03, the invoices being credited. Required unless the reason is VD; for VD the
   * official rule ibr-055-ae as published rejects a preceding invoice reference.
   */
  precedingInvoices?: PrecedingInvoiceReference[];
}

export type DocumentKind = 'Invoice' | 'CreditNote';
