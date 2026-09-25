/**
 * Identifiers and fixed values taken from the Peppol PINT AE Billing specification,
 * version 1.0.4 (release notes dated 2026-06-02, published in PDK 1.4.4 on 2026-07-29):
 * https://docs.peppol.eu/poac/ae/pint-ae/
 */
export const PINT_AE = {
  /** Specification version this library was built and tested against. */
  specificationVersion: '1.0.4',
  /** Specification identifier (IBT-024), section 5.1.1 of the BIS. */
  customizationId: 'urn:peppol:pint:billing-1@ae-1',
  /** Business process type (IBT-023), section 5.1.1 of the BIS. */
  profileId: 'urn:peppol:bis:billing',
  /** Participant identifier scheme for UAE endpoints (IBT-034-1, IBT-049-1). */
  endpointScheme: '0235',
  /** The only VAT rate the rules accept for category S (rule ibr-190-ae). */
  standardRatePercent: '5',
  /** Tax accounting currency when the document currency is not AED (rule ibr-140-ae). */
  taxCurrency: 'AED',
  /** Document type code of the AdditionalDocumentReference that carries BTAE-20. */
  aedTotalDocumentTypeCode: 'aedtotal-incl-vat',
  /** Document type code for a project reference inside a credit note (BIS section 2.3.7). */
  projectReferenceDocumentTypeCode: '50',
} as const;

/**
 * Predefined endpoints from BIS section 1.5.3. Documents sent to these endpoints are
 * reported to the tax authority (corner 5) rather than delivered to a buyer.
 */
export const PREDEFINED_ENDPOINTS = {
  /** Invoice transaction type "deemed supply" (X1XXXXXX). */
  deemedSupply: '9900000097',
  /** The buyer is not subject to UAE e-invoicing regulations. */
  buyerNotSubjectToEInvoicing: '9900000098',
  /** Exports where the receiver is not registered in Peppol (XXXXXXX1). */
  exportReceiverNotInPeppol: '9900000099',
} as const;

export type PredefinedEndpoint = (typeof PREDEFINED_ENDPOINTS)[keyof typeof PREDEFINED_ENDPOINTS];

/** UBL 2.1 namespaces. */
export const UBL_NAMESPACES = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
} as const;
