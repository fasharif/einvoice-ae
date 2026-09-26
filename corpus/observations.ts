/**
 * Documents that reproduce the observations about the published rules in
 * docs/validation-artefacts.md. Unlike the broken documents, an observation may expect
 * several rules, or none. The conformance suite asserts the exact set the official
 * validator reports, so a change upstream is noticed.
 */
import { insertAfterLine, replaceOnce } from './mutate.js';

export interface ObservationCase {
  readonly name: string;
  /** Name of the valid scenario the mutation starts from. */
  readonly base: string;
  /** The numbered observation in docs/validation-artefacts.md. */
  readonly observation: number;
  readonly description: string;
  /** Rule IDs the official validator reports, sorted as fatalRuleIds sorts them. */
  readonly expectedRules: readonly string[];
  mutate(xml: string): string;
}

const BILLING_REFERENCE = [
  '  <cac:BillingReference>',
  '    <cac:InvoiceDocumentReference>',
  '      <cbc:ID>DEMO-INV-2026-0001</cbc:ID>',
  '      <cbc:IssueDate>2026-09-01</cbc:IssueDate>',
  '    </cac:InvoiceDocumentReference>',
  '  </cac:BillingReference>',
].join('\n');

const SECOND_REASON = ['  <cac:DiscrepancyResponse>', '    <cbc:ResponseCode>DL8.61.1.E</cbc:ResponseCode>', '  </cac:DiscrepancyResponse>'].join('\n');

export const observationCases: readonly ObservationCase[] = [
  {
    name: 'vd-credit-note-with-billing-reference',
    base: 'credit-note-volume-discount',
    observation: 5,
    description:
      'Volume discount credit note whose only reason code is VD, with a billing reference. The BIS says the reference ' +
      'is optional for VD, but ibr-055-ae as published rejects it.',
    expectedRules: ['ibr-055-ae'],
    mutate: (xml) => insertAfterLine(xml, '</cac:DiscrepancyResponse>', BILLING_REFERENCE),
  },
  {
    name: 'vd-credit-note-with-billing-reference-and-second-reason',
    base: 'credit-note-volume-discount',
    observation: 5,
    description:
      'The same credit note with a second reason code (DL8.61.1.E, as in the official VD example). ibr-055-ae compares ' +
      'the sequence of reason codes with !=, so the document now passes.',
    expectedRules: [],
    mutate: (xml) => insertAfterLine(xml, '</cac:DiscrepancyResponse>', `${SECOND_REASON}\n${BILLING_REFERENCE}`),
  },
  {
    name: 'line-amount-decimal-half-up-tie',
    base: 'allowances-and-charges',
    observation: 7,
    description:
      'Line of 1.05 x 36.90 = 38.745 written as 38.75 (exact decimal rounding half up) instead of 38.74. ibr-147-ae ' +
      'evaluates the product as xs:double, which is just below 38.745, and rejects 38.75; ibr-co-10 follows because ' +
      'the lines no longer add up to the unchanged total.',
    expectedRules: ['ibr-147-ae', 'ibr-co-10'],
    mutate: (xml) =>
      replaceOnce(
        xml,
        '<cbc:LineExtensionAmount currencyID="AED">38.74</cbc:LineExtensionAmount>',
        '<cbc:LineExtensionAmount currencyID="AED">38.75</cbc:LineExtensionAmount>',
      ),
  },
];
