/**
 * The contract between this library and an Accredited Service Provider (ASP).
 *
 * In the UAE model the seller's ASP (corner 2) validates the document, delivers it to the
 * buyer's ASP (corner 3) and reports it to the tax authority (corner 5). No public ASP API
 * is standardised, so this interface covers the operations every integration needs:
 * submitting a document once, and learning whether it was accepted or rejected.
 */
import type { IssuedDocument } from '../immutability.js';

export type SubmissionStatus = 'received' | 'accepted' | 'rejected';

export interface SubmissionRequest {
  /** Document number (IBT-001). Used as the idempotency key. */
  readonly invoiceId: string;
  readonly documentType: 'Invoice' | 'CreditNote';
  readonly xml: string;
  /** SHA-256 of the XML, sent so that the provider can confirm what it received. */
  readonly sha256: string;
}

export interface SubmissionReceipt {
  readonly submissionId: string;
  readonly invoiceId: string;
  readonly status: SubmissionStatus;
  readonly receivedAt: string;
  /** True when the provider returned the result of an earlier identical submission. */
  readonly replayed: boolean;
  /** Number of HTTP attempts the client made. */
  readonly attempts: number;
}

export interface ProviderError {
  readonly code: string;
  readonly message: string;
}

export interface StatusReport {
  readonly submissionId: string;
  readonly invoiceId: string;
  readonly status: SubmissionStatus;
  readonly updatedAt: string;
  readonly errors: readonly ProviderError[];
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface AccreditedServiceProvider {
  /** Submits a document. Submitting the same document again must not create a second one. */
  submit(request: SubmissionRequest, options?: RequestOptions): Promise<SubmissionReceipt>;
  getStatus(submissionId: string, options?: RequestOptions): Promise<StatusReport>;
}

/** Builds the submission for an issued document. */
export function toSubmission(document: Pick<IssuedDocument, 'id' | 'kind' | 'xml' | 'sha256'>): SubmissionRequest {
  return { invoiceId: document.id, documentType: document.kind, xml: document.xml, sha256: document.sha256 };
}
