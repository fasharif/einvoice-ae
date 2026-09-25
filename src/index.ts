/**
 * einvoice-ae: builds UAE e-invoices (UBL 2.1 Invoice and CreditNote) conforming to
 * Peppol PINT AE Billing 1.0.4. Not certified and not tax advice; see the README.
 */
export { buildCreditNote, buildInvoice, transactionTypeCode } from './build.js';
export type { BuildOptions, BuiltDocument } from './build.js';
export { calculateTotals } from './calculate.js';
export type {
  CalculationInput,
  DocumentLevelAllowanceCharge,
  DocumentTotals,
  LineTotals,
  ResolvedAllowanceCharge,
  TaxBreakdown,
} from './calculate.js';
export * from './codelists/generated.js';
export * from './codelists/pint-ae.js';
export { PINT_AE, PREDEFINED_ENDPOINTS, UBL_NAMESPACES } from './constants.js';
export type { PredefinedEndpoint } from './constants.js';
export { CalculationError, EInvoiceError, ImmutableDocumentError, InvoiceInputError } from './errors.js';
export type { ValidationIssue } from './errors.js';
export { isPredefinedEndpoint, isValidTin, isValidTrn, isValidUaeEndpoint } from './identifiers.js';
export {
  DocumentLedger,
  InMemoryDocumentStore,
  OverCreditError,
  assertUnmodified,
  creditNoteFor,
  documentHash,
  issueDocument,
  verifyDocument,
} from './immutability.js';
export type { CreditNoteDetails, DocumentStore, IssuedDocument } from './immutability.js';
export type * from './model.js';
export { MAX_AMOUNT_MINOR, MINOR_UNITS_PER_UNIT, convertAmount, formatAmount, parseAmount, percentOf } from './money.js';
export type { MinorUnits } from './money.js';
export { validateCreditNoteInput, validateInvoiceInput } from './validation.js';
