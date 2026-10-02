/**
 * Deliberately broken documents. Each starts from a valid corpus document and changes as
 * little as possible so that exactly one official rule fails. The conformance suite
 * asserts that the validator reports that rule ID and no other, and that the document is
 * still valid against the UBL 2.1 schema (so the failure comes from the business rule).
 *
 * Where one rule cannot fail alone because of how the official rules are written, the
 * mutation also adjusts dependent amounts (for example the totals after a VAT change).
 */
import { insertAfterLine, removeBlock, removeLine, replaceEvery, replaceOnce } from './mutate.js';

export interface BrokenCase {
  /** The single rule the document must break. Also the file name. */
  readonly rule: string;
  /** Name of the valid scenario the mutation starts from. */
  readonly base: string;
  readonly description: string;
  mutate(xml: string): string;
}

const AED = 'currencyID="AED"';

export const brokenCases: readonly BrokenCase[] = [
  // ------------------------------------------------------------ identification
  {
    rule: 'aligned-ibrp-001-ae',
    base: 'standard-rated',
    description: 'Specification identifier is not the PINT AE customisation',
    mutate: (xml) => replaceOnce(xml, 'urn:peppol:pint:billing-1@ae-1', 'urn:peppol:pint:billing-1@jp-1'),
  },
  {
    rule: 'aligned-ibrp-002-ae',
    base: 'standard-rated',
    description: 'Business process identifier is not urn:peppol:bis:billing',
    mutate: (xml) => replaceOnce(xml, '<cbc:ProfileID>urn:peppol:bis:billing</cbc:ProfileID>', '<cbc:ProfileID>urn:peppol:bis:invoicing</cbc:ProfileID>'),
  },
  {
    rule: 'ibr-193-ae',
    base: 'standard-rated',
    description: 'Unique identifier (BTAE-07, cbc:UUID) is missing',
    mutate: (xml) => removeLine(xml, '<cbc:UUID>'),
  },
  {
    rule: 'ibr-154-ae',
    base: 'standard-rated',
    description: 'Invoice transaction type code has seven flags instead of eight',
    mutate: (xml) => replaceOnce(xml, '<cbc:ProfileExecutionID>00000000</cbc:ProfileExecutionID>', '<cbc:ProfileExecutionID>0000000</cbc:ProfileExecutionID>'),
  },
  // ------------------------------------------------------------ parties
  {
    rule: 'ibr-132-ae',
    base: 'standard-rated',
    description: 'Seller TRN does not end with 03',
    mutate: (xml) => replaceOnce(xml, '<cbc:CompanyID>100000000100003</cbc:CompanyID>', '<cbc:CompanyID>100000000100004</cbc:CompanyID>'),
  },
  {
    rule: 'ibr-143-ae',
    base: 'standard-rated',
    description: 'Seller postal address has no city',
    mutate: (xml) => removeLine(xml, '<cbc:CityName>Dubai</cbc:CityName>'),
  },
  {
    rule: 'ibr-150-ae',
    base: 'standard-rated',
    description: 'Seller with a 0235 endpoint has no legal registration identifier',
    mutate: (xml) => removeLine(xml, '>DEMO-TL-000001</cbc:CompanyID>'),
  },
  {
    rule: 'ibr-172-ae',
    base: 'standard-rated',
    description: 'Seller trade licence has no issuing authority',
    mutate: (xml) =>
      replaceOnce(
        xml,
        '<cbc:CompanyID schemeAgencyID="TL" schemeAgencyName="Demo Licensing Authority">DEMO-TL-000001</cbc:CompanyID>',
        '<cbc:CompanyID schemeAgencyID="TL">DEMO-TL-000001</cbc:CompanyID>',
      ),
  },
  {
    rule: 'ibr-136-ae',
    base: 'exempt',
    description: 'Out-of-scope invoice (480) without the buyer legal registration identifier',
    mutate: (xml) => removeLine(xml, '>DEMO-TL-000002</cbc:CompanyID>'),
  },
  {
    rule: 'ibr-103-ae',
    base: 'reverse-charge',
    description: 'Reverse-charge line but the buyer has no VAT identifier',
    mutate: (xml) =>
      replaceOnce(
        xml,
        [
          '      <cac:PartyTaxScheme>',
          '        <cbc:CompanyID>100000000200003</cbc:CompanyID>',
          '        <cac:TaxScheme>',
          '          <cbc:ID>VAT</cbc:ID>',
          '        </cac:TaxScheme>',
          '      </cac:PartyTaxScheme>',
          '',
        ].join('\n'),
        '',
      ),
  },
  // ------------------------------------------------------------ VAT
  {
    rule: 'ibr-190-ae',
    base: 'standard-rated',
    description: 'Standard rate stated as 10 % (amounts consistent with 10 %)',
    mutate: (xml) => {
      let out = replaceEvery(xml, '<cbc:Percent>5</cbc:Percent>', '<cbc:Percent>10</cbc:Percent>');
      out = replaceEvery(out, `<cbc:TaxAmount ${AED}>143.50</cbc:TaxAmount>`, `<cbc:TaxAmount ${AED}>287.00</cbc:TaxAmount>`);
      return replaceEvery(out, '>3013.50</', '>3157.00</');
    },
  },
  {
    rule: 'aligned-ibrp-s-09',
    base: 'standard-rated',
    description: 'Standard-rated VAT is 0.10 more than taxable amount x 5 % (totals consistent)',
    mutate: (xml) => {
      const out = replaceEvery(xml, `<cbc:TaxAmount ${AED}>143.50</cbc:TaxAmount>`, `<cbc:TaxAmount ${AED}>143.60</cbc:TaxAmount>`);
      return replaceEvery(out, '>3013.50</', '>3013.60</');
    },
  },
  {
    rule: 'aligned-ibrp-s-08',
    base: 'standard-rated',
    description: 'Standard-rated taxable amount differs from the sum of the S lines',
    mutate: (xml) => {
      let out = replaceOnce(xml, `<cbc:TaxableAmount ${AED}>2870.00</cbc:TaxableAmount>`, `<cbc:TaxableAmount ${AED}>2800.00</cbc:TaxableAmount>`);
      out = replaceEvery(out, `<cbc:TaxAmount ${AED}>143.50</cbc:TaxAmount>`, `<cbc:TaxAmount ${AED}>140.00</cbc:TaxAmount>`);
      return replaceEvery(out, '>3013.50</', '>3010.00</');
    },
  },
  {
    rule: 'ibr-104-ae',
    base: 'standard-rated',
    description: 'Standard-rated line without the VAT line amount in AED (BTAE-08)',
    mutate: (xml) =>
      replaceOnce(
        xml,
        [
          '      <cac:TaxTotal>',
          `        <cbc:TaxAmount ${AED}>92.50</cbc:TaxAmount>`,
          '      </cac:TaxTotal>',
          '',
        ].join('\n'),
        '',
      ),
  },
  {
    rule: 'ibr-165-ae',
    base: 'zero-rated-export',
    description: 'Zero-rated line with a non-zero VAT line amount (BTAE-08)',
    mutate: (xml) =>
      replaceOnce(
        xml,
        [`      <cbc:Amount ${AED}>193.54</cbc:Amount>`, '      <cac:TaxTotal>', `        <cbc:TaxAmount ${AED}>0.00</cbc:TaxAmount>`].join('\n'),
        [`      <cbc:Amount ${AED}>193.54</cbc:Amount>`, '      <cac:TaxTotal>', `        <cbc:TaxAmount ${AED}>9.68</cbc:TaxAmount>`].join('\n'),
      ),
  },
  {
    rule: 'ibr-162-ae',
    base: 'reverse-charge',
    description: 'Reverse-charge line with a non-zero VAT line amount (BTAE-08)',
    mutate: (xml) =>
      replaceOnce(
        xml,
        [`      <cbc:Amount ${AED}>23000.00</cbc:Amount>`, '      <cac:TaxTotal>', `        <cbc:TaxAmount ${AED}>0.00</cbc:TaxAmount>`].join('\n'),
        [`      <cbc:Amount ${AED}>23000.00</cbc:Amount>`, '      <cac:TaxTotal>', `        <cbc:TaxAmount ${AED}>1150.00</cbc:TaxAmount>`].join('\n'),
      ),
  },
  {
    rule: 'ibr-166-ae',
    base: 'reverse-charge',
    description: 'Reverse-charge item without the type of goods (BTAE-09)',
    mutate: (xml) => removeLine(xml, '<cbc:NatureCode>'),
  },
  {
    rule: 'ibr-174-ae',
    base: 'reverse-charge',
    description: 'Reverse-charge item identified with scheme 0060 instead of GTIN (0160)',
    mutate: (xml) => replaceOnce(xml, '<cbc:ID schemeID="0160">00000000000017</cbc:ID>', '<cbc:ID schemeID="0060">00000000000017</cbc:ID>'),
  },
  {
    rule: 'ibr-167-ae',
    base: 'exempt',
    description: 'Exempt line without an exemption reason code',
    mutate: (xml) => removeLine(xml, '<cbc:TaxExemptionReasonCode>'),
  },
  {
    rule: 'aligned-ibrp-e-05',
    base: 'exempt',
    description: 'Exempt line states a VAT rate',
    mutate: (xml) =>
      replaceOnce(
        xml,
        '<cbc:ID>E</cbc:ID>\n        <cbc:TaxExemptionReasonCode>',
        '<cbc:ID>E</cbc:ID>\n        <cbc:Percent>0</cbc:Percent>\n        <cbc:TaxExemptionReasonCode>',
      ),
  },
  {
    rule: 'ibr-151-ae',
    base: 'exempt',
    description: 'Tax invoice (380) whose only line is exempt',
    mutate: (xml) => replaceOnce(xml, '<cbc:InvoiceTypeCode>480</cbc:InvoiceTypeCode>', '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>'),
  },
  {
    rule: 'ibr-194-ae',
    base: 'exempt',
    description: 'Line without the amount payable in AED (BTAE-10)',
    mutate: (xml) => removeBlock(xml, '<cac:ItemPriceExtension>'),
  },
  // ------------------------------------------------------------ totals and lines
  {
    rule: 'ibr-co-10',
    base: 'standard-rated',
    description: 'Sum of line net amounts is 1.00 higher than the lines (other totals consistent)',
    mutate: (xml) => {
      let out = replaceOnce(xml, `<cbc:LineExtensionAmount ${AED}>2870.00</cbc:LineExtensionAmount>`, `<cbc:LineExtensionAmount ${AED}>2871.00</cbc:LineExtensionAmount>`);
      out = replaceOnce(out, `<cbc:TaxExclusiveAmount ${AED}>2870.00</cbc:TaxExclusiveAmount>`, `<cbc:TaxExclusiveAmount ${AED}>2871.00</cbc:TaxExclusiveAmount>`);
      return replaceEvery(out, '>3013.50</', '>3014.50</');
    },
  },
  {
    rule: 'ibr-co-14',
    base: 'standard-rated',
    description: 'Invoice total VAT differs from the sum of the VAT breakdown',
    mutate: (xml) => {
      const out = replaceOnce(
        xml,
        `    <cbc:TaxAmount ${AED}>143.50</cbc:TaxAmount>\n    <cbc:TaxIncludedIndicator>`,
        `    <cbc:TaxAmount ${AED}>143.40</cbc:TaxAmount>\n    <cbc:TaxIncludedIndicator>`,
      );
      return replaceEvery(out, '>3013.50</', '>3013.40</');
    },
  },
  {
    rule: 'ibr-co-15',
    base: 'standard-rated',
    description: 'Total with VAT is not total without VAT plus VAT',
    mutate: (xml) => replaceEvery(xml, '>3013.50</', '>3013.00</'),
  },
  {
    rule: 'ibr-co-11',
    base: 'allowances-and-charges',
    description: 'Sum of document-level allowances differs from the allowances (other totals consistent)',
    mutate: (xml) => {
      let out = replaceOnce(xml, `<cbc:AllowanceTotalAmount ${AED}>79.55</cbc:AllowanceTotalAmount>`, `<cbc:AllowanceTotalAmount ${AED}>80.55</cbc:AllowanceTotalAmount>`);
      out = replaceOnce(out, `<cbc:TaxExclusiveAmount ${AED}>3095.44</cbc:TaxExclusiveAmount>`, `<cbc:TaxExclusiveAmount ${AED}>3094.44</cbc:TaxExclusiveAmount>`);
      return replaceEvery(out, '>3217.21</', '>3216.21</');
    },
  },
  {
    rule: 'ibr-147-ae',
    base: 'standard-rated',
    description: 'Line net amount is not quantity x net price',
    mutate: (xml) => {
      const out = replaceOnce(xml, `<cbc:PriceAmount ${AED}>185.00</cbc:PriceAmount>`, `<cbc:PriceAmount ${AED}>184.00</cbc:PriceAmount>`);
      return replaceOnce(out, `<cbc:BaseAmount ${AED}>185.00</cbc:BaseAmount>`, `<cbc:BaseAmount ${AED}>184.00</cbc:BaseAmount>`);
    },
  },
  {
    rule: 'ibr-126-ae',
    base: 'standard-rated',
    description: 'Price without the gross price and price discount',
    mutate: (xml) =>
      replaceOnce(
        xml,
        [
          '      <cac:AllowanceCharge>',
          '        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>',
          `        <cbc:Amount ${AED}>0.00</cbc:Amount>`,
          `        <cbc:BaseAmount ${AED}>185.00</cbc:BaseAmount>`,
          '      </cac:AllowanceCharge>',
          '',
        ].join('\n'),
        '',
      ),
  },
  {
    rule: 'ibr-125-ae',
    base: 'standard-rated',
    description: 'Item without a description',
    mutate: (xml) => removeLine(xml, '<cbc:Description>Pressure-compensating drip line'),
  },
  {
    rule: 'ibr-131-ae',
    base: 'allowances-and-charges',
    description: 'Document allowance amount is not base amount x percentage',
    mutate: (xml) => replaceOnce(xml, '<cbc:MultiplierFactorNumeric>2.5</cbc:MultiplierFactorNumeric>', '<cbc:MultiplierFactorNumeric>3</cbc:MultiplierFactorNumeric>'),
  },
  {
    rule: 'aligned-ibrp-057',
    base: 'allowances-and-charges',
    description: 'Document allowance with a base amount but no percentage',
    mutate: (xml) => removeLine(xml, '<cbc:MultiplierFactorNumeric>2.5</cbc:MultiplierFactorNumeric>'),
  },
  {
    rule: 'ibr-cl-23',
    base: 'standard-rated',
    description: 'Unit of measure PCS is not a UN/ECE Recommendation 20 or 21 code',
    mutate: (xml) => replaceEvery(xml, 'unitCode="H87"', 'unitCode="PCS"'),
  },
  // ------------------------------------------------------------ dates, payment, currency
  {
    rule: 'ibr-127-ae',
    base: 'standard-rated',
    description: 'Amount due but no payment due date',
    mutate: (xml) => removeLine(xml, '<cbc:DueDate>'),
  },
  {
    rule: 'ibr-141-ae',
    base: 'standard-rated',
    description: 'VAT point date after the issue date',
    mutate: (xml) => insertAfterLine(xml, '<cbc:Note>DEMO', '  <cbc:TaxPointDate>2026-09-05</cbc:TaxPointDate>'),
  },
  {
    rule: 'ibr-191-ae',
    base: 'standard-rated',
    description: 'Tax invoice without payment means',
    mutate: (xml) => removeBlock(xml, '<cac:PaymentMeans>'),
  },
  {
    rule: 'ibr-192-ae',
    base: 'standard-rated',
    description: 'Credit transfer without the payee account identifier',
    mutate: (xml) => removeBlock(xml, '<cac:PayeeFinancialAccount>'),
  },
  {
    rule: 'ibr-002-ae',
    base: 'zero-rated-export',
    description: 'Exchange rate with seven decimals',
    mutate: (xml) => replaceOnce(xml, '<cbc:CalculationRate>3.6725</cbc:CalculationRate>', '<cbc:CalculationRate>3.6725001</cbc:CalculationRate>'),
  },
  {
    rule: 'ibr-175-ae',
    base: 'zero-rated-export',
    description: 'Foreign-currency invoice without the total with VAT in AED (BTAE-20)',
    mutate: (xml) => removeBlock(xml, '<cac:AdditionalDocumentReference>'),
  },
  // ------------------------------------------------------------ special transactions
  {
    rule: 'ibr-152-ae',
    base: 'zero-rated-export',
    description: 'Export delivered abroad without a deliver-to address',
    mutate: (xml) => removeBlock(xml, '<cac:DeliveryLocation>'),
  },
  {
    rule: 'ibr-196-ae',
    base: 'zero-rated-export',
    description: 'Delivery terms without the Incoterms code',
    mutate: (xml) => replaceOnce(xml, '<cbc:ID schemeID="Incoterms">CIF</cbc:ID>', '<cbc:SpecialTerms>CIF</cbc:SpecialTerms>'),
  },
  {
    rule: 'ibr-142-ae',
    base: 'e-commerce',
    description: 'E-commerce supply whose deliver-to address has no city',
    mutate: (xml) =>
      replaceOnce(
        xml,
        '<cbc:StreetName>Plot 5, Demo Park</cbc:StreetName>\n        <cbc:CityName>Abu Dhabi</cbc:CityName>\n',
        '<cbc:StreetName>Plot 5, Demo Park</cbc:StreetName>\n',
      ),
  },
  {
    rule: 'ibr-007-ae',
    base: 'free-trade-zone',
    description: 'Free trade zone supply without the beneficiary identifier',
    mutate: (xml) => removeBlock(xml, '<cac:BuyerCustomerParty>'),
  },
  {
    rule: 'ibr-176-ae',
    base: 'disclosed-agent',
    description: 'Disclosed agent billing where the principal is the seller itself',
    mutate: (xml) => replaceOnce(xml, '<cbc:ID>100000000600003</cbc:ID>', '<cbc:ID>100000000100003</cbc:ID>'),
  },
  {
    rule: 'ibr-005-ae',
    base: 'continuous-supply',
    description: 'Billing frequency code that is not in the PINT AE list',
    mutate: (xml) => replaceOnce(xml, '<cbc:DescriptionCode>MTH</cbc:DescriptionCode>', '<cbc:DescriptionCode>MONTHLY</cbc:DescriptionCode>'),
  },
  // ------------------------------------------------------------ credit notes
  {
    rule: 'ibr-055-ae',
    base: 'credit-note',
    description: 'Tax credit note without the preceding invoice reference',
    mutate: (xml) => removeBlock(xml, '<cac:BillingReference>'),
  },
  {
    rule: 'ibr-001-ae',
    base: 'credit-note',
    description: 'Credit note reason code that is not in the PINT AE list',
    mutate: (xml) => replaceOnce(xml, '<cbc:ResponseCode>DL8.61.1.D</cbc:ResponseCode>', '<cbc:ResponseCode>DL8.61.1.Z</cbc:ResponseCode>'),
  },
  {
    rule: 'ibr-124-ae',
    base: 'credit-note',
    description: 'Tax credit note that carries a VAT point date',
    mutate: (xml) => insertAfterLine(xml, '<cbc:IssueDate>2026-09-15</cbc:IssueDate>', '  <cbc:TaxPointDate>2026-09-10</cbc:TaxPointDate>'),
  },
];
