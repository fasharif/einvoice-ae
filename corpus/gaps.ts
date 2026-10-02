/**
 * Documents that break a published rule but pass the published validator, because of how
 * the rule is written in PINT AE 1.0.4. The conformance suite asserts that the official
 * validator accepts them (so a fix upstream is noticed), and the unit tests assert that
 * the library refuses the equivalent input.
 */
import { replaceEvery, replaceOnce } from './mutate.js';

export interface GapCase {
  readonly name: string;
  /** The rule whose intent the document breaks. */
  readonly rule: string;
  readonly base: string;
  readonly description: string;
  mutate(xml: string): string;
}

export const gapCases: readonly GapCase[] = [
  {
    name: 'seller-subdivision-not-an-emirate',
    rule: 'ibr-128-ae',
    base: 'standard-rated',
    description:
      'Seller subdivision "Dubai" instead of DXB. In the compiled rules, ibr-143-ae and ibr-144-ae match the seller and ' +
      'buyer postal addresses with a higher priority in the same pattern, so ibr-128-ae never runs on them.',
    mutate: (xml) => replaceOnce(xml, '<cbc:CountrySubentity>DXB</cbc:CountrySubentity>', '<cbc:CountrySubentity>Dubai</cbc:CountrySubentity>'),
  },
  {
    name: 'credit-note-total-vat-not-sum-of-breakdown',
    rule: 'ibr-co-14',
    base: 'credit-note',
    description:
      'Credit note whose total VAT (18.40) differs from its VAT breakdown (18.50). The rule context is written ' +
      '/cn:CreditNote/cac:Taxtotal (lower-case t), which matches no element, so the rule never runs on credit notes.',
    mutate: (xml) => {
      const out = replaceOnce(
        xml,
        '    <cbc:TaxAmount currencyID="AED">18.50</cbc:TaxAmount>\n    <cbc:TaxIncludedIndicator>',
        '    <cbc:TaxAmount currencyID="AED">18.40</cbc:TaxAmount>\n    <cbc:TaxIncludedIndicator>',
      );
      return replaceEvery(out, '>388.50</', '>388.40</');
    },
  },
];
