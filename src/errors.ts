/** One problem found in the input of a document. */
export interface ValidationIssue {
  /** Dotted path to the offending field, for example `lines[2].unitCode`. */
  readonly path: string;
  /** Stable machine-readable code, for example `INVALID_TRN`. */
  readonly code: string;
  /** Plain-language explanation that names the field and the expected value. */
  readonly message: string;
  /**
   * Identifier of the official PINT AE or PINT rule that the check mirrors, when there is
   * one, for example `ibr-132-ae`. Checks without a rule are library limits.
   */
  readonly rule?: string;
}

/** Base class for every error this library throws on purpose. */
export class EInvoiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The input model cannot produce a conforming document. Lists every issue found. */
export class InvoiceInputError extends EInvoiceError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const first = issues[0];
    const summary =
      issues.length === 1 && first
        ? `${first.path}: ${first.message}`
        : `${issues.length} problems in the document input:\n` +
          issues.map((i) => `  - ${i.path}: ${i.message}${i.rule ? ` [${i.rule}]` : ''}`).join('\n');
    super(summary);
    this.issues = Object.freeze([...issues]);
  }
}

/** A calculation could not be completed within the rules (for example a rounding drift). */
export class CalculationError extends EInvoiceError {
  readonly code: string;
  readonly rule: string | undefined;

  constructor(code: string, message: string, rule?: string) {
    super(message);
    this.code = code;
    this.rule = rule;
  }
}

/** Raised when code tries to change a document that has already been issued. */
export class ImmutableDocumentError extends EInvoiceError {
  readonly documentId: string;

  constructor(documentId: string, message: string) {
    super(message);
    this.documentId = documentId;
  }
}
