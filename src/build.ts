/**
 * Builds UBL 2.1 Invoice and CreditNote XML that conforms to PINT AE Billing 1.0.4.
 * Element order follows the UBL 2.1 schemas exactly; the Invoice and CreditNote root
 * sequences differ, so each has its own assembly function.
 */
import { randomUUID } from 'node:crypto';
import { type DocumentLevelAllowanceCharge, type DocumentTotals, type LineTotals, type ResolvedAllowanceCharge, calculateTotals } from './calculate.js';
import { TRANSACTION_TYPE_FLAGS } from './codelists/pint-ae.js';
import { PINT_AE, UBL_NAMESPACES } from './constants.js';
import { CalculationError, InvoiceInputError, type ValidationIssue } from './errors.js';
import type {
  Address,
  Buyer,
  CreditNoteInput,
  DeliveryAddress,
  DocumentKind,
  InvoiceInput,
  LineInput,
  Seller,
  TransactionType,
} from './model.js';
import { formatAmount } from './money.js';
import { validateCreditNoteInput, validateInvoiceInput } from './validation.js';
import { type XmlChild, type XmlElement, element, optionalElement, optionalText, serialise, textElement } from './xml.js';

/** A document built from validated input. The XML is final; totals are in minor units. */
export interface BuiltDocument {
  readonly kind: DocumentKind;
  readonly id: string;
  readonly uuid: string;
  readonly issueDate: string;
  readonly typeCode: string;
  readonly currency: string;
  readonly xml: string;
  readonly totals: DocumentTotals;
}

export interface BuildOptions {
  /** Supplies BTAE-07 when the input has no uuid. Defaults to crypto.randomUUID. */
  generateUuid?: () => string;
}

type CommonInput = InvoiceInput | CreditNoteInput;

// --------------------------------------------------------------------------- helpers

const cbc = (name: string, value: string | undefined, attrs?: Record<string, string | undefined>): XmlElement | undefined =>
  optionalText(`cbc:${name}`, value, attrs);

const amount = (name: string, minor: number, currency: string): XmlElement =>
  textElement(`cbc:${name}`, formatAmount(minor), { currencyID: currency });

export function transactionTypeCode(flags: TransactionType | undefined): string {
  return TRANSACTION_TYPE_FLAGS.map((flag) => (flags?.[flag] ? '1' : '0')).join('');
}

function postalAddress(address: Address): XmlElement {
  return element('cac:PostalAddress', [
    cbc('StreetName', address.street),
    cbc('AdditionalStreetName', address.additionalStreet),
    cbc('CityName', address.city),
    cbc('PostalZone', address.postalZone),
    cbc('CountrySubentity', address.subdivision),
    address.addressLine !== undefined ? element('cac:AddressLine', [cbc('Line', address.addressLine)]) : undefined,
    element('cac:Country', [cbc('IdentificationCode', address.country)]),
  ]);
}

function deliveryAddress(address: DeliveryAddress): XmlElement {
  return element('cac:Address', [
    cbc('StreetName', address.street),
    cbc('AdditionalStreetName', address.additionalStreet),
    cbc('CityName', address.city),
    cbc('PostalZone', address.postalZone),
    cbc('CountrySubentity', address.subdivision),
    element('cac:Country', [cbc('IdentificationCode', address.country)]),
  ]);
}

function vatScheme(): XmlElement {
  return element('cac:TaxScheme', [cbc('ID', 'VAT')]);
}

function party(p: Seller | Buyer, role: 'seller' | 'buyer'): XmlElement {
  const buyerIdentifier = role === 'buyer' ? (p as Buyer).identifier : undefined;
  const seller = role === 'seller' ? (p as Seller) : undefined;
  const registration = p.legalRegistration;
  const agencyName =
    registration?.type === 'TL' ? registration.authority : registration?.type === 'PAS' ? registration.passportCountry : undefined;
  return element('cac:Party', [
    cbc('EndpointID', p.endpoint.id, { schemeID: p.endpoint.scheme ?? PINT_AE.endpointScheme }),
    buyerIdentifier
      ? element('cac:PartyIdentification', [cbc('ID', buyerIdentifier.id, { schemeID: buyerIdentifier.scheme })])
      : undefined,
    p.tradingName !== undefined ? element('cac:PartyName', [cbc('Name', p.tradingName)]) : undefined,
    postalAddress(p.address),
    p.trn !== undefined ? element('cac:PartyTaxScheme', [cbc('CompanyID', p.trn), vatScheme()]) : undefined,
    seller?.tin !== undefined
      ? element('cac:PartyTaxScheme', [cbc('CompanyID', seller.tin), element('cac:TaxScheme', [cbc('ID', 'TIN')])])
      : undefined,
    element('cac:PartyLegalEntity', [
      cbc('RegistrationName', p.name),
      registration
        ? cbc('CompanyID', registration.id, { schemeAgencyID: registration.type, schemeAgencyName: agencyName })
        : undefined,
      cbc('CompanyLegalForm', seller?.legalForm),
    ]),
    p.contact
      ? optionalElement('cac:Contact', [
          cbc('Name', p.contact.name),
          cbc('Telephone', p.contact.telephone),
          cbc('ElectronicMail', p.contact.email),
        ])
      : undefined,
  ]);
}

function identificationParty(wrapper: string, id: string | undefined): XmlElement | undefined {
  if (id === undefined) return undefined;
  return element(`cac:${wrapper}`, [element('cac:Party', [element('cac:PartyIdentification', [cbc('ID', id)])])]);
}

function invoicePeriod(period: CommonInput['invoicePeriod']): XmlElement | undefined {
  if (!period) return undefined;
  return element('cac:InvoicePeriod', [
    cbc('StartDate', period.start),
    cbc('EndDate', period.end),
    cbc('DescriptionCode', period.frequency),
  ]);
}

function delivery(input: CommonInput): XmlElement | undefined {
  const d = input.delivery;
  if (!d) return undefined;
  return element('cac:Delivery', [
    cbc('ActualDeliveryDate', d.date),
    d.locationId || d.address
      ? element('cac:DeliveryLocation', [
          d.locationId ? cbc('ID', d.locationId.id, { schemeID: d.locationId.scheme }) : undefined,
          d.address ? deliveryAddress(d.address) : undefined,
        ])
      : undefined,
    d.partyName !== undefined ? element('cac:DeliveryParty', [element('cac:PartyName', [cbc('Name', d.partyName)])]) : undefined,
    d.incoterms !== undefined ? element('cac:DeliveryTerms', [cbc('ID', d.incoterms, { schemeID: 'Incoterms' })]) : undefined,
  ]);
}

function paymentMeans(input: CommonInput): XmlElement[] {
  return (input.paymentMeans ?? []).map((m) =>
    element('cac:PaymentMeans', [
      cbc('PaymentMeansCode', m.code, { name: m.name }),
      cbc('PaymentID', m.paymentId),
      m.card
        ? element('cac:CardAccount', [
            cbc('PrimaryAccountNumberID', m.card.primaryAccountNumberId),
            cbc('NetworkID', m.card.network),
            cbc('HolderName', m.card.holderName),
          ])
        : undefined,
      m.account
        ? element('cac:PayeeFinancialAccount', [
            cbc('ID', m.account.id),
            cbc('Name', m.account.name),
            m.account.financialInstitutionId !== undefined
              ? element('cac:FinancialInstitutionBranch', [cbc('ID', m.account.financialInstitutionId)])
              : undefined,
          ])
        : undefined,
    ]),
  );
}

function allowanceChargeCore(ac: ResolvedAllowanceCharge, currency: string): XmlChild[] {
  return [
    cbc('ChargeIndicator', ac.isCharge ? 'true' : 'false'),
    cbc('AllowanceChargeReasonCode', ac.reasonCode),
    cbc('AllowanceChargeReason', ac.reason),
    cbc('MultiplierFactorNumeric', ac.percent),
    amount('Amount', ac.amount, currency),
    ac.baseAmount !== undefined ? amount('BaseAmount', ac.baseAmount, currency) : undefined,
  ];
}

function documentAllowanceCharge(ac: DocumentLevelAllowanceCharge, currency: string): XmlElement {
  const exemption = ac.tax.category === 'E' ? ac.tax : undefined;
  return element('cac:AllowanceCharge', [
    ...allowanceChargeCore(ac, currency),
    element('cac:TaxCategory', [
      cbc('ID', ac.tax.category),
      cbc('Percent', ac.rate),
      cbc('TaxExemptionReasonCode', exemption?.exemptionReasonCode),
      cbc('TaxExemptionReason', exemption?.exemptionReason),
      vatScheme(),
    ]),
  ]);
}

function taxTotals(totals: DocumentTotals): XmlElement[] {
  const currency = totals.currency;
  const main = element('cac:TaxTotal', [
    amount('TaxAmount', totals.taxAmount, currency),
    cbc('TaxIncludedIndicator', 'false'),
    ...totals.breakdown.map((b) =>
      element('cac:TaxSubtotal', [
        amount('TaxableAmount', b.taxableAmount, currency),
        amount('TaxAmount', b.taxAmount, currency),
        element('cac:TaxCategory', [cbc('ID', b.category), cbc('Percent', b.rate), vatScheme()]),
      ]),
    ),
  ]);
  // The document-currency total must come first: ibr-co-15 reads cac:TaxTotal[1].
  const aed = totals.aed
    ? element('cac:TaxTotal', [amount('TaxAmount', totals.aed.taxAmount, PINT_AE.taxCurrency)])
    : undefined;
  return aed ? [main, aed] : [main];
}

function monetaryTotal(totals: DocumentTotals): XmlElement {
  const c = totals.currency;
  return element('cac:LegalMonetaryTotal', [
    amount('LineExtensionAmount', totals.lineExtensionAmount, c),
    amount('TaxExclusiveAmount', totals.taxExclusiveAmount, c),
    amount('TaxInclusiveAmount', totals.taxInclusiveAmount, c),
    totals.allowances.length > 0 ? amount('AllowanceTotalAmount', totals.allowanceTotalAmount, c) : undefined,
    totals.charges.length > 0 ? amount('ChargeTotalAmount', totals.chargeTotalAmount, c) : undefined,
    totals.prepaidAmount !== 0 ? amount('PrepaidAmount', totals.prepaidAmount, c) : undefined,
    totals.roundingAmount !== 0 ? amount('PayableRoundingAmount', totals.roundingAmount, c) : undefined,
    amount('PayableAmount', totals.payableAmount, c),
  ]);
}

function item(line: LineInput, computed: LineTotals): XmlElement {
  const i = line.item;
  const tax = line.tax;
  const commodity = optionalElement('cac:CommodityClassification', [
    cbc('NatureCode', i.reverseChargeGoods),
    cbc('CommodityCode', i.type),
    cbc('ItemClassificationCode', i.hsCode, { listID: i.hsCode !== undefined ? 'HS' : undefined }),
  ]);
  return element('cac:Item', [
    cbc('Description', i.description),
    cbc('Name', i.name),
    i.buyerItemId !== undefined ? element('cac:BuyersItemIdentification', [cbc('ID', i.buyerItemId)]) : undefined,
    i.sellerItemId !== undefined ? element('cac:SellersItemIdentification', [cbc('ID', i.sellerItemId)]) : undefined,
    i.standardItemId
      ? element('cac:StandardItemIdentification', [cbc('ID', i.standardItemId.id, { schemeID: i.standardItemId.scheme })])
      : undefined,
    i.serviceAccountingCode !== undefined
      ? element('cac:AdditionalItemIdentification', [cbc('ID', i.serviceAccountingCode, { schemeID: 'SAC' })])
      : undefined,
    i.originCountry !== undefined ? element('cac:OriginCountry', [cbc('IdentificationCode', i.originCountry)]) : undefined,
    commodity,
    element('cac:ClassifiedTaxCategory', [
      cbc('ID', tax.category),
      cbc('Percent', computed.rate),
      cbc('TaxExemptionReasonCode', tax.category === 'E' ? tax.exemptionReasonCode : undefined),
      cbc('TaxExemptionReason', tax.category === 'E' ? tax.exemptionReason : undefined),
      vatScheme(),
    ]),
    ...(i.properties ?? []).map((p) => element('cac:AdditionalItemProperty', [cbc('Name', p.name), cbc('Value', p.value)])),
  ]);
}

function documentLine(kind: DocumentKind, line: LineInput, computed: LineTotals, currency: string): XmlElement {
  const discount = computed.grossUnitPrice - computed.unitPrice;
  return element(kind === 'Invoice' ? 'cac:InvoiceLine' : 'cac:CreditNoteLine', [
    cbc('ID', computed.id),
    cbc('Note', line.note),
    textElement(kind === 'Invoice' ? 'cbc:InvoicedQuantity' : 'cbc:CreditedQuantity', computed.quantity, {
      unitCode: line.unitCode,
    }),
    amount('LineExtensionAmount', computed.netAmount, currency),
    line.period ? element('cac:InvoicePeriod', [cbc('StartDate', line.period.start), cbc('EndDate', line.period.end)]) : undefined,
    line.orderLineReference !== undefined
      ? element('cac:OrderLineReference', [cbc('LineID', line.orderLineReference)])
      : undefined,
    ...[...computed.charges, ...computed.allowances].map((ac) => element('cac:AllowanceCharge', allowanceChargeCore(ac, currency))),
    item(line, computed),
    element('cac:Price', [
      amount('PriceAmount', computed.unitPrice, currency),
      textElement('cbc:BaseQuantity', computed.priceBaseQuantity, { unitCode: line.unitCode }),
      // Gross price and price discount (IBT-148, IBT-147) are required by ibr-126-ae.
      element('cac:AllowanceCharge', [
        cbc('ChargeIndicator', 'false'),
        amount('Amount', discount, currency),
        amount('BaseAmount', computed.grossUnitPrice, currency),
      ]),
    ]),
    element('cac:ItemPriceExtension', [
      amount('Amount', computed.payableAmountAed, PINT_AE.taxCurrency),
      computed.vatAmountAed !== undefined
        ? element('cac:TaxTotal', [amount('TaxAmount', computed.vatAmountAed, PINT_AE.taxCurrency)])
        : undefined,
    ]),
  ]);
}

function aedTotalReference(totals: DocumentTotals): XmlElement | undefined {
  if (!totals.aed) return undefined;
  return element('cac:AdditionalDocumentReference', [
    cbc('ID', PINT_AE.taxCurrency),
    cbc('DocumentTypeCode', PINT_AE.aedTotalDocumentTypeCode),
    cbc('DocumentDescription', `${PINT_AE.taxCurrency} ${formatAmount(totals.aed.taxInclusiveAmount)}`),
  ]);
}

function exchangeRate(input: CommonInput, totals: DocumentTotals): XmlElement | undefined {
  if (!totals.aed) return undefined;
  return element('cac:TaxExchangeRate', [
    cbc('SourceCurrencyCode', input.currency),
    cbc('TargetCurrencyCode', PINT_AE.taxCurrency),
    cbc('CalculationRate', totals.aed.exchangeRate),
  ]);
}

function header(input: CommonInput, uuid: string): XmlChild[] {
  return [
    cbc('CustomizationID', PINT_AE.customizationId),
    cbc('ProfileID', PINT_AE.profileId),
    cbc('ProfileExecutionID', transactionTypeCode(input.transactionType)),
    cbc('ID', input.id),
    cbc('UUID', uuid),
    cbc('IssueDate', input.issueDate),
    cbc('IssueTime', input.issueTime),
  ];
}

function parties(input: CommonInput): XmlChild[] {
  return [
    element('cac:AccountingSupplierParty', [party(input.seller, 'seller')]),
    element('cac:AccountingCustomerParty', [party(input.buyer, 'buyer')]),
    identificationParty('BuyerCustomerParty', input.beneficiaryId),
    identificationParty('SellerSupplierParty', input.principalId),
  ];
}

const rootAttributes = (namespace: string): Record<string, string> => ({
  xmlns: namespace,
  'xmlns:cac': UBL_NAMESPACES.cac,
  'xmlns:cbc': UBL_NAMESPACES.cbc,
});

function invoiceXml(input: InvoiceInput, totals: DocumentTotals, uuid: string): XmlElement {
  const c = totals.currency;
  return element(
    'Invoice',
    [
      ...header(input, uuid),
      cbc('DueDate', input.dueDate),
      cbc('InvoiceTypeCode', input.typeCode ?? '380'),
      cbc('Note', input.note),
      cbc('TaxPointDate', input.taxPointDate),
      cbc('DocumentCurrencyCode', c),
      cbc('TaxCurrencyCode', totals.aed ? PINT_AE.taxCurrency : undefined),
      cbc('BuyerReference', input.buyerReference),
      invoicePeriod(input.invoicePeriod),
      input.orderReference
        ? element('cac:OrderReference', [cbc('ID', input.orderReference.id), cbc('SalesOrderID', input.orderReference.salesOrderId)])
        : undefined,
      input.customsReference !== undefined ? element('cac:StatementDocumentReference', [cbc('ID', input.customsReference)]) : undefined,
      input.contractReference !== undefined ? element('cac:ContractDocumentReference', [cbc('ID', input.contractReference)]) : undefined,
      aedTotalReference(totals),
      input.projectReference !== undefined ? element('cac:ProjectReference', [cbc('ID', input.projectReference)]) : undefined,
      ...parties(input),
      delivery(input),
      ...paymentMeans(input),
      input.paymentTerms !== undefined ? element('cac:PaymentTerms', [cbc('Note', input.paymentTerms)]) : undefined,
      ...totals.allowances.map((a) => documentAllowanceCharge(a, c)),
      ...totals.charges.map((a) => documentAllowanceCharge(a, c)),
      exchangeRate(input, totals),
      ...taxTotals(totals),
      monetaryTotal(totals),
      ...input.lines.map((line, i) => documentLine('Invoice', line, totals.lines[i] as LineTotals, c)),
    ],
    rootAttributes(UBL_NAMESPACES.invoice),
  );
}

function creditNoteXml(input: CreditNoteInput, totals: DocumentTotals, uuid: string): XmlElement {
  const c = totals.currency;
  return element(
    'CreditNote',
    [
      ...header(input, uuid),
      cbc('CreditNoteTypeCode', input.typeCode ?? '381'),
      cbc('Note', input.note),
      cbc('DocumentCurrencyCode', c),
      cbc('TaxCurrencyCode', totals.aed ? PINT_AE.taxCurrency : undefined),
      cbc('BuyerReference', input.buyerReference),
      invoicePeriod(input.invoicePeriod),
      element('cac:DiscrepancyResponse', [cbc('ResponseCode', input.reason)]),
      input.orderReference
        ? element('cac:OrderReference', [cbc('ID', input.orderReference.id), cbc('SalesOrderID', input.orderReference.salesOrderId)])
        : undefined,
      ...(input.precedingInvoices ?? []).map((ref) =>
        element('cac:BillingReference', [
          element('cac:InvoiceDocumentReference', [cbc('ID', ref.id), cbc('IssueDate', ref.issueDate)]),
        ]),
      ),
      input.contractReference !== undefined ? element('cac:ContractDocumentReference', [cbc('ID', input.contractReference)]) : undefined,
      aedTotalReference(totals),
      // A credit note has no ProjectReference element (BIS section 2.3.7).
      input.projectReference !== undefined
        ? element('cac:AdditionalDocumentReference', [
            cbc('ID', input.projectReference),
            cbc('DocumentTypeCode', PINT_AE.projectReferenceDocumentTypeCode),
          ])
        : undefined,
      input.customsReference !== undefined ? element('cac:StatementDocumentReference', [cbc('ID', input.customsReference)]) : undefined,
      ...parties(input),
      delivery(input),
      ...paymentMeans(input),
      input.paymentTerms !== undefined ? element('cac:PaymentTerms', [cbc('Note', input.paymentTerms)]) : undefined,
      exchangeRate(input, totals),
      ...totals.allowances.map((a) => documentAllowanceCharge(a, c)),
      ...totals.charges.map((a) => documentAllowanceCharge(a, c)),
      ...taxTotals(totals),
      monetaryTotal(totals),
      ...input.lines.map((line, i) => documentLine('CreditNote', line, totals.lines[i] as LineTotals, c)),
    ],
    rootAttributes(UBL_NAMESPACES.creditNote),
  );
}

// --------------------------------------------------------------------------- public API

function calculateOrThrow(input: CommonInput): DocumentTotals {
  try {
    return calculateTotals(input);
  } catch (error) {
    if (error instanceof CalculationError) {
      const issue: ValidationIssue = error.rule
        ? { path: '', code: error.code, message: error.message, rule: error.rule }
        : { path: '', code: error.code, message: error.message };
      throw new InvoiceInputError([issue]);
    }
    throw error;
  }
}

/**
 * Builds a PINT AE Invoice (380 tax invoice or 480 out of scope of tax).
 * Throws InvoiceInputError listing every problem when the input cannot conform.
 */
export function buildInvoice(input: InvoiceInput, options: BuildOptions = {}): BuiltDocument {
  const issues = validateInvoiceInput(input);
  if (issues.length > 0) throw new InvoiceInputError(issues);
  const totals = calculateOrThrow(input);

  const followUp: ValidationIssue[] = [];
  const deemed = input.transactionType?.deemedSupply === true;
  if (!deemed && totals.payableAmount > 0 && input.dueDate === undefined) {
    followUp.push({ path: 'dueDate', code: 'REQUIRED', message: 'the payment due date is required when an amount is due', rule: 'ibr-127-ae' });
  }
  if (totals.payableAmount < 0) {
    followUp.push({ path: 'prepaidAmount', code: 'NEGATIVE_AMOUNT_DUE', message: 'the prepaid amount exceeds the invoice total; issue a credit note instead' });
  }
  if (followUp.length > 0) throw new InvoiceInputError(followUp);

  const uuid = input.uuid ?? (options.generateUuid ?? randomUUID)();
  return Object.freeze({
    kind: 'Invoice' as const,
    id: input.id,
    uuid,
    issueDate: input.issueDate,
    typeCode: input.typeCode ?? '380',
    currency: input.currency,
    xml: serialise(invoiceXml(input, totals, uuid)),
    totals,
  });
}

/**
 * Builds a PINT AE CreditNote (381 tax credit note or 81 out of scope of tax) that
 * references the credited invoices. Throws InvoiceInputError when the input cannot conform.
 */
export function buildCreditNote(input: CreditNoteInput, options: BuildOptions = {}): BuiltDocument {
  const issues = validateCreditNoteInput(input);
  if (issues.length > 0) throw new InvoiceInputError(issues);
  const totals = calculateOrThrow(input);
  if (totals.payableAmount < 0) {
    throw new InvoiceInputError([
      { path: 'prepaidAmount', code: 'NEGATIVE_AMOUNT_DUE', message: 'the prepaid amount exceeds the credit note total' },
    ]);
  }
  const uuid = input.uuid ?? (options.generateUuid ?? randomUUID)();
  return Object.freeze({
    kind: 'CreditNote' as const,
    id: input.id,
    uuid,
    issueDate: input.issueDate,
    typeCode: input.typeCode ?? '381',
    currency: input.currency,
    xml: serialise(creditNoteXml(input, totals, uuid)),
    totals,
  });
}
