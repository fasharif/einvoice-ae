/**
 * Issued documents are final. This module fingerprints each issued document with SHA-256,
 * keeps a ledger that refuses edits and deletions, and builds credit notes, which are the
 * only way to correct an invoice.
 */
import { createHash } from 'node:crypto';
import type { BuiltDocument } from './build.js';
import type { DocumentTotals } from './calculate.js';
import type { CreditNoteReasonCode } from './codelists/pint-ae.js';
import { EInvoiceError, ImmutableDocumentError } from './errors.js';
import type { CreditNoteInput, DecimalInput, DocumentKind, InvoiceInput, LineInput } from './model.js';

/** A document that has been issued. Every nested object is frozen. */
export interface IssuedDocument {
  readonly kind: DocumentKind;
  readonly id: string;
  readonly uuid: string;
  readonly issueDate: string;
  readonly typeCode: string;
  readonly currency: string;
  /** The exact XML that was issued. */
  readonly xml: string;
  /** SHA-256 of the UTF-8 bytes of `xml`, lower-case hex. */
  readonly sha256: string;
  /** ISO 8601 timestamp of issue. */
  readonly issuedAt: string;
  readonly totals: DocumentTotals;
  /** For credit notes: identifiers of the credited invoices, read from the XML. */
  readonly creditedInvoiceIds: readonly string[];
}

/** SHA-256 of the UTF-8 encoding of the XML, as lower-case hex. */
export function documentHash(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

const BILLING_REFERENCE = /<cac:InvoiceDocumentReference>\s*<cbc:ID>([^<]+)<\/cbc:ID>/g;

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Marks a built document as issued: fingerprints it and freezes it. */
export function issueDocument(built: BuiltDocument, options: { now?: () => Date } = {}): IssuedDocument {
  const creditedInvoiceIds =
    built.kind === 'CreditNote' ? [...built.xml.matchAll(BILLING_REFERENCE)].map((m) => unescapeXml(m[1] ?? '')) : [];
  return deepFreeze({
    kind: built.kind,
    id: built.id,
    uuid: built.uuid,
    issueDate: built.issueDate,
    typeCode: built.typeCode,
    currency: built.currency,
    xml: built.xml,
    sha256: documentHash(built.xml),
    issuedAt: (options.now ?? (() => new Date()))().toISOString(),
    totals: deepCopy(built.totals),
    creditedInvoiceIds,
  });
}

/** True when the XML still matches the fingerprint taken at issue. */
export function verifyDocument(document: Pick<IssuedDocument, 'xml' | 'sha256'>): boolean {
  return documentHash(document.xml) === document.sha256;
}

/** Throws when the XML no longer matches its fingerprint (for example after tampering in storage). */
export function assertUnmodified(document: Pick<IssuedDocument, 'id' | 'xml' | 'sha256'>): void {
  if (!verifyDocument(document)) {
    throw new ImmutableDocumentError(
      document.id,
      `Document ${document.id} does not match its SHA-256 fingerprint ${document.sha256}; it was changed after issue`,
    );
  }
}

/**
 * Persistence for issued documents. Implementations must never overwrite an entry.
 *
 * `DocumentLedger` serialises its own `issue` calls, so the checks it makes (number not yet
 * used, credit within the invoice total) hold for everything issued through one ledger
 * object. When several processes or ledgers share one store, the store itself must make
 * those checks atomic with the insert, for example in one database transaction that locks
 * the invoice row, or with a unique constraint on the number and a credited-total column
 * guarded by a CHECK constraint.
 */
export interface DocumentStore {
  get(id: string): Promise<IssuedDocument | undefined>;
  /** Stores a new document. Must reject when the identifier already exists. */
  insert(document: IssuedDocument): Promise<void>;
  list(): Promise<readonly IssuedDocument[]>;
}

export class InMemoryDocumentStore implements DocumentStore {
  readonly #documents = new Map<string, IssuedDocument>();

  get(id: string): Promise<IssuedDocument | undefined> {
    return Promise.resolve(this.#documents.get(id));
  }

  insert(document: IssuedDocument): Promise<void> {
    if (this.#documents.has(document.id)) {
      return Promise.reject(new ImmutableDocumentError(document.id, `Document ${document.id} already exists`));
    }
    this.#documents.set(document.id, document);
    return Promise.resolve();
  }

  list(): Promise<readonly IssuedDocument[]> {
    return Promise.resolve([...this.#documents.values()]);
  }
}

/** Raised when a credit note would credit more than the invoice it references. */
export class OverCreditError extends EInvoiceError {
  constructor(
    readonly invoiceId: string,
    readonly invoiceTotal: number,
    readonly alreadyCredited: number,
    readonly requested: number,
  ) {
    super(
      `Credit note would credit ${requested} minor units against invoice ${invoiceId}, which totals ` +
        `${invoiceTotal} and already has ${alreadyCredited} credited`,
    );
  }
}

/**
 * Register of issued documents. Issuing is idempotent for identical content; any attempt
 * to change, replace or delete an issued document is refused.
 */
export class DocumentLedger {
  readonly #store: DocumentStore;
  readonly #now: () => Date;
  /** Tail of the queue of `issue` calls; each call starts when the previous one settles. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: DocumentStore = new InMemoryDocumentStore(), options: { now?: () => Date } = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Issues a built document. Re-issuing the same content returns the stored record.
   * A different document with an existing identifier is refused. A credit note must
   * reference exactly one invoice already in the ledger (or none, for a volume discount)
   * and must not take the credited total above the invoice total.
   *
   * Calls on one ledger run one at a time, so concurrent credit notes cannot both pass
   * the credit check before either is stored. See `DocumentStore` for several processes.
   */
  issue(built: BuiltDocument): Promise<IssuedDocument> {
    const run = this.#queue.then(() => this.#issue(built));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #issue(built: BuiltDocument): Promise<IssuedDocument> {
    const hash = documentHash(built.xml);
    const existing = await this.#store.get(built.id);
    if (existing) {
      if (existing.sha256 === hash) return existing;
      throw new ImmutableDocumentError(
        built.id,
        `${existing.kind} ${built.id} was issued on ${existing.issuedAt} and cannot be changed. ` +
          'Issue a credit note to correct it (see creditNoteFor).',
      );
    }
    const issued = issueDocument(built, { now: this.#now });
    if (issued.kind === 'CreditNote') await this.#checkCredit(issued);
    await this.#store.insert(issued);
    return issued;
  }

  async get(id: string): Promise<IssuedDocument | undefined> {
    const document = await this.#store.get(id);
    if (document) assertUnmodified(document);
    return document;
  }

  /** True when the stored document exists and still matches its fingerprint. */
  async verify(id: string, xml?: string): Promise<boolean> {
    const document = await this.#store.get(id);
    if (!document) return false;
    return verifyDocument(document) && (xml === undefined || documentHash(xml) === document.sha256);
  }

  /** Always refuses: issued documents cannot be edited. */
  update(id: string): Promise<never> {
    return Promise.reject(
      new ImmutableDocumentError(id, `Document ${id} has been issued and cannot be edited. Issue a credit note to correct it.`),
    );
  }

  /** Always refuses: issued documents cannot be deleted. */
  delete(id: string): Promise<never> {
    return Promise.reject(
      new ImmutableDocumentError(id, `Document ${id} has been issued and cannot be deleted. Issue a credit note to reverse it.`),
    );
  }

  /** Sum of the totals (with VAT) of every credit note that references the invoice. */
  async creditedAmount(invoiceId: string): Promise<number> {
    const all = await this.#store.list();
    return all
      .filter((d) => d.kind === 'CreditNote' && d.creditedInvoiceIds.length === 1 && d.creditedInvoiceIds[0] === invoiceId)
      .reduce((sum, d) => sum + d.totals.taxInclusiveAmount, 0);
  }

  async #checkCredit(creditNote: IssuedDocument): Promise<void> {
    const ids = creditNote.creditedInvoiceIds;
    // A volume discount (VD) credit note references no invoice (ibr-055-ae), so there is
    // nothing to cap it against.
    if (ids.length === 0) return;
    if (ids.length > 1) {
      // The document does not say how its total is split between the invoices, so the
      // ledger could not keep each invoice within its total.
      throw new EInvoiceError(
        `Credit note ${creditNote.id} references ${ids.length} invoices (${ids.join(', ')}). ` +
          'The ledger can only check a credit note against one invoice; issue one credit note per invoice.',
      );
    }
    const invoiceId = ids[0] as string;
    const invoice = await this.#store.get(invoiceId);
    if (!invoice || invoice.kind !== 'Invoice') {
      throw new EInvoiceError(`Credit note ${creditNote.id} references invoice ${invoiceId}, which is not in the ledger`);
    }
    if (invoice.currency !== creditNote.currency) {
      throw new EInvoiceError(`Credit note ${creditNote.id} is in ${creditNote.currency} but invoice ${invoiceId} is in ${invoice.currency}`);
    }
    if (creditNote.issueDate < invoice.issueDate) {
      throw new EInvoiceError(
        `Credit note ${creditNote.id} is dated ${creditNote.issueDate}, before invoice ${invoiceId} (${invoice.issueDate})`,
      );
    }
    const already = await this.creditedAmount(invoiceId);
    const requested = creditNote.totals.taxInclusiveAmount;
    if (already + requested > invoice.totals.taxInclusiveAmount) {
      throw new OverCreditError(invoiceId, invoice.totals.taxInclusiveAmount, already, requested);
    }
  }
}

export interface CreditNoteDetails {
  /** IBT-001 of the credit note. */
  id: string;
  issueDate: string;
  issueTime?: string;
  uuid?: string;
  /** BTAE-03. VD (volume discount) cannot reference an invoice, so it is not accepted here. */
  reason: Exclude<CreditNoteReasonCode, 'VD'>;
  note?: string;
  /**
   * Which lines to credit. "all" (default) credits the whole invoice, including its
   * document-level allowances and charges. A list credits only the named lines, each
   * optionally with a smaller quantity; document-level allowances and charges are then
   * left out. Line allowances and charges are copied unchanged, so adjust them in the
   * returned input when they depend on the quantity.
   */
  lines?: 'all' | { lineId: string; quantity?: DecimalInput }[];
}

/**
 * Builds the input for a credit note that corrects an issued invoice. Parties, currency,
 * exchange rate and line details are copied from the original input; the credit note
 * references the invoice number and issue date (IBG-03).
 */
export function creditNoteFor(
  originalInput: InvoiceInput,
  issuedInvoice: Pick<IssuedDocument, 'kind' | 'id' | 'issueDate' | 'typeCode'>,
  details: CreditNoteDetails,
): CreditNoteInput {
  if (issuedInvoice.kind !== 'Invoice') throw new EInvoiceError('A credit note can only correct an invoice');
  if (originalInput.id !== issuedInvoice.id) {
    throw new EInvoiceError(`The input is for ${originalInput.id} but the issued invoice is ${issuedInvoice.id}`);
  }
  const lineIdOf = (line: LineInput, index: number): string => line.id ?? String(index + 1);

  let lines: LineInput[];
  let wholeInvoice = true;
  if (details.lines === undefined || details.lines === 'all') {
    lines = originalInput.lines.map((line, index) => ({ ...deepCopy(line), id: lineIdOf(line, index) }));
  } else {
    wholeInvoice = false;
    const byId = new Map(originalInput.lines.map((line, index) => [lineIdOf(line, index), line] as const));
    lines = details.lines.map(({ lineId, quantity }) => {
      const original = byId.get(lineId);
      if (!original) throw new EInvoiceError(`Invoice ${issuedInvoice.id} has no line ${lineId}`);
      return { ...deepCopy(original), id: lineId, ...(quantity !== undefined ? { quantity } : {}) };
    });
  }

  const copy = <K extends keyof InvoiceInput>(key: K): Partial<Pick<InvoiceInput, K>> =>
    originalInput[key] !== undefined ? ({ [key]: deepCopy(originalInput[key]) } as Partial<Pick<InvoiceInput, K>>) : {};

  return {
    id: details.id,
    issueDate: details.issueDate,
    ...(details.issueTime !== undefined ? { issueTime: details.issueTime } : {}),
    ...(details.uuid !== undefined ? { uuid: details.uuid } : {}),
    typeCode: issuedInvoice.typeCode === '480' ? '81' : '381',
    reason: details.reason,
    precedingInvoices: [{ id: issuedInvoice.id, issueDate: issuedInvoice.issueDate }],
    ...(details.note !== undefined ? { note: details.note } : {}),
    currency: originalInput.currency,
    ...copy('exchangeRate'),
    ...copy('buyerReference'),
    ...copy('orderReference'),
    ...copy('contractReference'),
    ...copy('projectReference'),
    ...copy('invoicePeriod'),
    ...copy('transactionType'),
    ...copy('beneficiaryId'),
    ...copy('principalId'),
    ...copy('delivery'),
    ...copy('customsReference'),
    ...copy('vatRounding'),
    seller: deepCopy(originalInput.seller),
    buyer: deepCopy(originalInput.buyer),
    ...(wholeInvoice ? { ...copy('allowances'), ...copy('charges') } : {}),
    lines,
  };
}
