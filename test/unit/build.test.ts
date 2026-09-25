import { describe, expect, it } from 'vitest';
import { exemptInvoiceInput, standardInvoiceInput } from '../../corpus/scenarios.js';
import { scenarios } from '../../corpus/scenarios.js';
import { PINT_AE, buildCreditNote, buildInvoice, transactionTypeCode } from '../../src/index.js';
import { all, at, children, localNames, parse, text } from '../support/xml.js';

// Element sequences copied from the UBL 2.1 schemas (xsd/maindoc and CommonAggregateComponents).
const SEQUENCES: Record<string, string[]> = {
  Invoice: 'UBLExtensions UBLVersionID CustomizationID ProfileID ProfileExecutionID ID CopyIndicator UUID IssueDate IssueTime DueDate InvoiceTypeCode Note TaxPointDate DocumentCurrencyCode TaxCurrencyCode PricingCurrencyCode PaymentCurrencyCode PaymentAlternativeCurrencyCode AccountingCostCode AccountingCost LineCountNumeric BuyerReference InvoicePeriod OrderReference BillingReference DespatchDocumentReference ReceiptDocumentReference StatementDocumentReference OriginatorDocumentReference ContractDocumentReference AdditionalDocumentReference ProjectReference Signature AccountingSupplierParty AccountingCustomerParty PayeeParty BuyerCustomerParty SellerSupplierParty TaxRepresentativeParty Delivery DeliveryTerms PaymentMeans PaymentTerms PrepaidPayment AllowanceCharge TaxExchangeRate PricingExchangeRate PaymentExchangeRate PaymentAlternativeExchangeRate TaxTotal WithholdingTaxTotal LegalMonetaryTotal InvoiceLine'.split(' '),
  CreditNote: 'UBLExtensions UBLVersionID CustomizationID ProfileID ProfileExecutionID ID CopyIndicator UUID IssueDate IssueTime TaxPointDate CreditNoteTypeCode Note DocumentCurrencyCode TaxCurrencyCode PricingCurrencyCode PaymentCurrencyCode PaymentAlternativeCurrencyCode AccountingCostCode AccountingCost LineCountNumeric BuyerReference InvoicePeriod DiscrepancyResponse OrderReference BillingReference DespatchDocumentReference ReceiptDocumentReference ContractDocumentReference AdditionalDocumentReference StatementDocumentReference OriginatorDocumentReference Signature AccountingSupplierParty AccountingCustomerParty PayeeParty BuyerCustomerParty SellerSupplierParty TaxRepresentativeParty Delivery DeliveryTerms PaymentMeans PaymentTerms TaxExchangeRate PricingExchangeRate PaymentExchangeRate PaymentAlternativeExchangeRate AllowanceCharge TaxTotal LegalMonetaryTotal CreditNoteLine'.split(' '),
  InvoiceLine: 'ID UUID Note InvoicedQuantity LineExtensionAmount TaxPointDate AccountingCostCode AccountingCost PaymentPurposeCode FreeOfChargeIndicator InvoicePeriod OrderLineReference DespatchLineReference ReceiptLineReference BillingReference DocumentReference PricingReference OriginatorParty Delivery PaymentTerms AllowanceCharge TaxTotal WithholdingTaxTotal Item Price DeliveryTerms SubInvoiceLine ItemPriceExtension'.split(' '),
  CreditNoteLine: 'ID UUID Note CreditedQuantity LineExtensionAmount TaxPointDate AccountingCostCode AccountingCost PaymentPurposeCode FreeOfChargeIndicator InvoicePeriod OrderLineReference DiscrepancyResponse DespatchLineReference ReceiptLineReference BillingReference DocumentReference PricingReference OriginatorParty Delivery PaymentTerms TaxTotal AllowanceCharge Item Price DeliveryTerms SubCreditNoteLine ItemPriceExtension'.split(' '),
  Item: 'Description PackQuantity PackSizeNumeric CatalogueIndicator Name HazardousRiskIndicator AdditionalInformation Keyword BrandName ModelName BuyersItemIdentification SellersItemIdentification ManufacturersItemIdentification StandardItemIdentification CatalogueItemIdentification AdditionalItemIdentification CatalogueDocumentReference ItemSpecificationDocumentReference OriginCountry CommodityClassification TransactionConditions HazardousItem ClassifiedTaxCategory AdditionalItemProperty'.split(' '),
  Party: 'MarkCareIndicator MarkAttentionIndicator WebsiteURI LogoReferenceID EndpointID IndustryClassificationCode PartyIdentification PartyName Language PostalAddress PhysicalLocation PartyTaxScheme PartyLegalEntity Contact Person AgentParty ServiceProviderParty PowerOfAttorney FinancialAccount'.split(' '),
  PostalAddress: 'ID AddressTypeCode AddressFormatCode Postbox Floor Room StreetName AdditionalStreetName BlockName BuildingName BuildingNumber InhouseMail Department MarkAttention MarkCare PlotIdentification CitySubdivisionName CityName PostalZone CountrySubentity CountrySubentityCode Region District TimezoneOffset AddressLine Country LocationCoordinate'.split(' '),
  AllowanceCharge: 'ID ChargeIndicator AllowanceChargeReasonCode AllowanceChargeReason MultiplierFactorNumeric PrepaidIndicator SequenceNumeric Amount BaseAmount AccountingCostCode AccountingCost PerUnitAmount TaxCategory TaxTotal PaymentMeans'.split(' '),
  LegalMonetaryTotal: 'LineExtensionAmount TaxExclusiveAmount TaxInclusiveAmount AllowanceTotalAmount ChargeTotalAmount PrepaidAmount PayableRoundingAmount PayableAmount PayableAlternativeAmount'.split(' '),
};

function assertOrder(element: ReturnType<typeof parse>): void {
  const sequence = SEQUENCES[element.localName ?? ''];
  if (sequence) {
    const positions = localNames(element).map((name) => {
      const index = sequence.indexOf(name);
      expect(index, `${name} is not allowed in ${element.localName}`).toBeGreaterThanOrEqual(0);
      return index;
    });
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i], `order inside ${element.localName}: ${localNames(element).join(', ')}`).toBeGreaterThanOrEqual(positions[i - 1] as number);
    }
  }
  for (const child of children(element)) assertOrder(child);
}

function assertNoEmptyElements(element: ReturnType<typeof parse>): void {
  const kids = children(element);
  if (kids.length === 0) expect((element.textContent ?? '').trim(), `${element.localName} is empty`).not.toBe('');
  kids.forEach(assertNoEmptyElements);
}

describe('document structure', () => {
  it.each(scenarios.map((s) => [s.name, s] as const))('%s follows the UBL 2.1 element order and has no empty elements', (_name, scenario) => {
    const root = parse(scenario.build().xml);
    assertOrder(root);
    assertNoEmptyElements(root);
  });

  it('writes the PINT AE identifiers and header fields', () => {
    const root = parse(buildInvoice(standardInvoiceInput()).xml);
    expect(root.localName).toBe('Invoice');
    expect(root.namespaceURI).toBe('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
    expect(text(at(root, 'CustomizationID'))).toBe(PINT_AE.customizationId);
    expect(text(at(root, 'ProfileID'))).toBe(PINT_AE.profileId);
    expect(text(at(root, 'ProfileExecutionID'))).toBe('00000000');
    expect(text(at(root, 'UUID'))).toBe('00000000-0000-4000-8000-000000000001');
    expect(text(at(root, 'InvoiceTypeCode'))).toBe('380');
    expect(text(at(root, 'Note'))).toBe('DEMO - not a tax invoice');
  });

  it('encodes the transaction type flags in position order', () => {
    expect(transactionTypeCode(undefined)).toBe('00000000');
    expect(transactionTypeCode({ freeTradeZone: true })).toBe('10000000');
    expect(transactionTypeCode({ summaryInvoice: true, exports: true })).toBe('00010001');
    expect(transactionTypeCode({ eCommerce: true, deemedSupply: false })).toBe('00000010');
  });

  it('writes the party identifiers the UAE rules need', () => {
    const root = parse(buildInvoice(standardInvoiceInput()).xml);
    const seller = at(root, 'AccountingSupplierParty', 'Party')!;
    expect(at(seller, 'EndpointID')?.getAttribute('schemeID')).toBe('0235');
    expect(text(at(seller, 'PartyTaxScheme', 'CompanyID'))).toBe('100000000100003');
    const registration = at(seller, 'PartyLegalEntity', 'CompanyID')!;
    expect(registration.getAttribute('schemeAgencyID')).toBe('TL');
    expect(registration.getAttribute('schemeAgencyName')).toBe('Demo Licensing Authority');
    expect(text(at(seller, 'PostalAddress', 'CountrySubentity'))).toBe('DXB');
  });

  it('always writes the gross price, the price discount and the AED line amounts', () => {
    const root = parse(buildInvoice(standardInvoiceInput()).xml);
    for (const line of all(root, 'InvoiceLine')) {
      expect(at(line, 'Price', 'BaseQuantity')).toBeDefined();
      expect(at(line, 'Price', 'AllowanceCharge', 'BaseAmount')).toBeDefined();
      expect(at(line, 'ItemPriceExtension', 'Amount')?.getAttribute('currencyID')).toBe('AED');
      expect(at(line, 'ItemPriceExtension', 'TaxTotal', 'TaxAmount')).toBeDefined();
    }
  });

  it('writes no rate and no VAT line amount for exempt lines', () => {
    const root = parse(buildInvoice(exemptInvoiceInput()).xml);
    const line = all(root, 'InvoiceLine')[0]!;
    expect(at(line, 'Item', 'ClassifiedTaxCategory', 'Percent')).toBeUndefined();
    expect(text(at(line, 'Item', 'ClassifiedTaxCategory', 'TaxExemptionReasonCode'))).toBe('DL8.46.2');
    expect(at(line, 'ItemPriceExtension', 'TaxTotal')).toBeUndefined();
    expect(text(at(line, 'ItemPriceExtension', 'Amount'))).toBe('13500.00');
    expect(text(at(root, 'InvoiceTypeCode'))).toBe('480');
  });

  it('adds the AED tax total, exchange rate and BTAE-20 for foreign-currency invoices', () => {
    const root = parse(buildInvoice({ ...standardInvoiceInput(), currency: 'USD', exchangeRate: '3.6725' }).xml);
    expect(text(at(root, 'TaxCurrencyCode'))).toBe('AED');
    const totals = children(root).filter((c) => c.localName === 'TaxTotal');
    expect(totals.map((t) => at(t, 'TaxAmount')?.getAttribute('currencyID'))).toEqual(['USD', 'AED']);
    expect(text(at(totals[1]!, 'TaxAmount'))).toBe('527.00'); // 143.50 x 3.6725 = 527.00375
    expect(text(at(root, 'TaxExchangeRate', 'CalculationRate'))).toBe('3.6725');
    const reference = children(root).find((c) => c.localName === 'AdditionalDocumentReference')!;
    expect(text(at(reference, 'DocumentTypeCode'))).toBe('aedtotal-incl-vat');
    expect(text(at(reference, 'DocumentDescription'))).toBe('AED 11067.08'); // 3013.50 x 3.6725 = 11067.07875
  });

  it('escapes special characters in text', () => {
    const input = standardInvoiceInput();
    const built = buildInvoice({ ...input, buyerReference: 'R&D <urgent> "A"' });
    expect(built.xml).toContain('<cbc:BuyerReference>R&amp;D &lt;urgent&gt; "A"</cbc:BuyerReference>');
    expect(text(at(parse(built.xml), 'BuyerReference'))).toBe('R&D <urgent> "A"');
  });

  it('is deterministic and generates a UUID only when none is given', () => {
    const input = standardInvoiceInput();
    expect(buildInvoice(input).xml).toBe(buildInvoice(input).xml);
    const { uuid: _unused, ...withoutUuid } = input;
    const built = buildInvoice(withoutUuid, { generateUuid: () => 'generated-uuid' });
    expect(built.uuid).toBe('generated-uuid');
    expect(built.xml).toContain('<cbc:UUID>generated-uuid</cbc:UUID>');
    expect(buildInvoice(withoutUuid).uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('builds credit notes with the reason, the preceding invoice and credited quantities', () => {
    const base = standardInvoiceInput();
    const built = buildCreditNote({
      id: 'CN-9',
      issueDate: '2026-09-20',
      reason: 'DL8.61.1.E',
      precedingInvoices: [{ id: base.id, issueDate: base.issueDate }],
      currency: 'AED',
      projectReference: 'P-1',
      seller: base.seller,
      buyer: base.buyer,
      lines: [base.lines[0]!],
    });
    const root = parse(built.xml);
    expect(root.localName).toBe('CreditNote');
    expect(text(at(root, 'CreditNoteTypeCode'))).toBe('381');
    expect(text(at(root, 'DiscrepancyResponse', 'ResponseCode'))).toBe('DL8.61.1.E');
    expect(text(at(root, 'BillingReference', 'InvoiceDocumentReference', 'ID'))).toBe(base.id);
    expect(text(at(root, 'BillingReference', 'InvoiceDocumentReference', 'IssueDate'))).toBe(base.issueDate);
    expect(at(root, 'DueDate')).toBeUndefined();
    expect(at(root, 'CreditNoteLine', 'CreditedQuantity')).toBeDefined();
    // A credit note carries the project reference as a document reference with type code 50.
    const reference = children(root).find((c) => c.localName === 'AdditionalDocumentReference')!;
    expect(text(at(reference, 'DocumentTypeCode'))).toBe('50');
  });
});
