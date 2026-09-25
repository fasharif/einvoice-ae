import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exemptInvoiceInput, standardInvoiceInput } from '../../corpus/scenarios.js';
import {
  DocumentLedger,
  ImmutableDocumentError,
  InMemoryDocumentStore,
  type IssuedDocument,
  OverCreditError,
  assertUnmodified,
  buildCreditNote,
  buildInvoice,
  creditNoteFor,
  documentHash,
  issueDocument,
  verifyDocument,
} from '../../src/index.js';

const fixedClock = () => new Date('2026-09-01T06:00:00.000Z');

describe('issuing', () => {
  it('fingerprints the exact UTF-8 bytes with SHA-256', () => {
    const built = buildInvoice(standardInvoiceInput());
    const issued = issueDocument(built, { now: fixedClock });
    const expected = createHash('sha256').update(Buffer.from(built.xml, 'utf8')).digest('hex');
    expect(issued.sha256).toBe(expected);
    expect(documentHash(built.xml)).toBe(expected);
    expect(issued.issuedAt).toBe('2026-09-01T06:00:00.000Z');
    expect(verifyDocument(issued)).toBe(true);
  });

  it('freezes every level of the issued record', () => {
    const issued = issueDocument(buildInvoice(standardInvoiceInput()));
    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.isFrozen(issued.totals)).toBe(true);
    expect(Object.isFrozen(issued.totals.lines[0])).toBe(true);
    expect(() => {
      (issued as { xml: string }).xml = '<changed/>';
    }).toThrow(TypeError);
    expect(() => {
      (issued.totals as { payableAmount: number }).payableAmount = 0;
    }).toThrow(TypeError);
  });

  it('detects a change to stored XML', () => {
    const issued = issueDocument(buildInvoice(standardInvoiceInput()));
    const tampered = { ...issued, xml: issued.xml.replace('3013.50', '3.50') };
    expect(verifyDocument(tampered)).toBe(false);
    expect(() => assertUnmodified(tampered)).toThrow(ImmutableDocumentError);
    expect(() => assertUnmodified(issued)).not.toThrow();
  });

  it('records which invoices a credit note credits', () => {
    const original = standardInvoiceInput();
    const invoice = issueDocument(buildInvoice(original));
    const creditNote = issueDocument(buildCreditNote(creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' })));
    expect(creditNote.creditedInvoiceIds).toEqual([original.id]);
    expect(invoice.creditedInvoiceIds).toEqual([]);
  });
});

describe('the ledger', () => {
  it('issues once and returns the same record for identical content', async () => {
    const ledger = new DocumentLedger(new InMemoryDocumentStore(), { now: fixedClock });
    const built = buildInvoice(standardInvoiceInput());
    const first = await ledger.issue(built);
    const again = await ledger.issue(buildInvoice(standardInvoiceInput()));
    expect(again).toBe(first);
    expect(await ledger.get(built.id)).toBe(first);
    expect(await ledger.verify(built.id, built.xml)).toBe(true);
    expect(await ledger.verify('unknown')).toBe(false);
  });

  it('refuses a different document with an issued number', async () => {
    const ledger = new DocumentLedger();
    await ledger.issue(buildInvoice(standardInvoiceInput()));
    const changed = buildInvoice({ ...standardInvoiceInput(), buyerReference: 'CHANGED' });
    await expect(ledger.issue(changed)).rejects.toThrow(/cannot be changed. Issue a credit note/);
  });

  it('refuses edits and deletions', async () => {
    const ledger = new DocumentLedger();
    const issued = await ledger.issue(buildInvoice(standardInvoiceInput()));
    await expect(ledger.update(issued.id)).rejects.toBeInstanceOf(ImmutableDocumentError);
    await expect(ledger.delete(issued.id)).rejects.toThrow(/cannot be deleted/);
  });

  it('refuses to return a stored document whose XML was altered', async () => {
    const store = new InMemoryDocumentStore();
    const ledger = new DocumentLedger(store);
    const issued = await ledger.issue(buildInvoice(standardInvoiceInput()));
    // Simulate tampering in a storage layer that does not freeze objects.
    const tamperedStore = {
      get: async (id: string): Promise<IssuedDocument | undefined> => {
        const doc = await store.get(id);
        return doc ? { ...doc, xml: doc.xml.replace('Net 30 days', 'Net 90 days') } : undefined;
      },
      insert: (doc: IssuedDocument) => store.insert(doc),
      list: () => store.list(),
    };
    await expect(new DocumentLedger(tamperedStore).get(issued.id)).rejects.toThrow(/SHA-256 fingerprint/);
  });

  it('accepts credit notes for issued invoices and caps the credited total', async () => {
    const ledger = new DocumentLedger();
    const original = standardInvoiceInput();
    const invoice = await ledger.issue(buildInvoice(original));

    const partial = await ledger.issue(
      buildCreditNote(creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.D', lines: [{ lineId: '1', quantity: '2' }] })),
    );
    expect(partial.totals.taxInclusiveAmount).toBe(388_50);
    expect(await ledger.creditedAmount(invoice.id)).toBe(388_50);

    // Crediting the whole invoice again would exceed what was invoiced.
    await expect(
      ledger.issue(buildCreditNote(creditNoteFor(original, invoice, { id: 'CN-2', issueDate: '2026-09-11', reason: 'DL8.61.1.A' }))),
    ).rejects.toBeInstanceOf(OverCreditError);
  });

  it('keeps the cap when credit notes are issued concurrently', async () => {
    const ledger = new DocumentLedger();
    const original = standardInvoiceInput();
    const invoice = await ledger.issue(buildInvoice(original));
    const full = (id: string) => buildCreditNote(creditNoteFor(original, invoice, { id, issueDate: '2026-09-10', reason: 'DL8.61.1.A' }));

    const results = await Promise.allSettled([ledger.issue(full('CN-A')), ledger.issue(full('CN-B')), ledger.issue(full('CN-C'))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(OverCreditError);
    expect(await ledger.creditedAmount(invoice.id)).toBe(invoice.totals.taxInclusiveAmount);
  });

  it('returns the stored record when identical content is issued concurrently', async () => {
    const ledger = new DocumentLedger();
    const [a, b] = await Promise.all([ledger.issue(buildInvoice(standardInvoiceInput())), ledger.issue(buildInvoice(standardInvoiceInput()))]);
    expect(b).toBe(a);
  });

  it('keeps issuing after a refused document', async () => {
    const ledger = new DocumentLedger();
    const original = standardInvoiceInput();
    const invoice = issueDocument(buildInvoice(original));
    const orphan = buildCreditNote(creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' }));
    await expect(ledger.issue(orphan)).rejects.toThrow(/not in the ledger/);
    await expect(ledger.issue(buildInvoice(original))).resolves.toMatchObject({ id: original.id });
  });

  it('refuses a credit note that references more than one invoice', async () => {
    const ledger = new DocumentLedger();
    const original = standardInvoiceInput();
    const invoice = await ledger.issue(buildInvoice(original));
    const second = await ledger.issue(buildInvoice({ ...original, id: 'DEMO-INV-2026-0002' }));
    const input = creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' });
    const both = buildCreditNote({ ...input, precedingInvoices: [...(input.precedingInvoices ?? []), { id: second.id, issueDate: second.issueDate }] });
    await expect(ledger.issue(both)).rejects.toThrow(/references 2 invoices .* issue one credit note per invoice/);
    expect(await ledger.creditedAmount(invoice.id)).toBe(0);
  });

  it('refuses a credit note dated before the invoice', async () => {
    const ledger = new DocumentLedger();
    const original = standardInvoiceInput();
    const invoice = await ledger.issue(buildInvoice(original));
    const input = creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' });
    await expect(ledger.issue(buildCreditNote({ ...input, issueDate: '2020-01-01' }))).rejects.toThrow(/dated 2020-01-01, before invoice/);
  });

  it('refuses a credit note for an invoice it does not know', async () => {
    const ledger = new DocumentLedger();
    const original = standardInvoiceInput();
    const invoice = issueDocument(buildInvoice(original));
    await expect(
      ledger.issue(buildCreditNote(creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' }))),
    ).rejects.toThrow(/not in the ledger/);
  });

  it('refuses a duplicate insert at the store level', async () => {
    const store = new InMemoryDocumentStore();
    const issued = issueDocument(buildInvoice(standardInvoiceInput()));
    await store.insert(issued);
    await expect(store.insert(issued)).rejects.toBeInstanceOf(ImmutableDocumentError);
  });
});

describe('creditNoteFor', () => {
  it('copies the parties and lines and references the invoice number and date', () => {
    const original = standardInvoiceInput();
    const invoice = issueDocument(buildInvoice(original));
    const input = creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' });
    expect(input.typeCode).toBe('381');
    expect(input.precedingInvoices).toEqual([{ id: original.id, issueDate: original.issueDate }]);
    expect(input.seller).toEqual(original.seller);
    expect(input.seller).not.toBe(original.seller);
    expect(input.lines.map((l) => l.id)).toEqual(['1', '2']);
    expect(buildCreditNote(input).totals.taxInclusiveAmount).toBe(invoice.totals.taxInclusiveAmount);
  });

  it('uses type 81 for invoices out of scope of tax', () => {
    const original = exemptInvoiceInput();
    const invoice = issueDocument(buildInvoice(original));
    expect(creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' }).typeCode).toBe('81');
  });

  it('refuses unknown lines, a non-invoice and a mismatched input', () => {
    const original = standardInvoiceInput();
    const invoice = issueDocument(buildInvoice(original));
    expect(() => creditNoteFor(original, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A', lines: [{ lineId: '9' }] })).toThrow(/no line 9/);
    expect(() => creditNoteFor(original, { ...invoice, kind: 'CreditNote' }, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' })).toThrow(/only correct an invoice/);
    expect(() => creditNoteFor({ ...original, id: 'OTHER' }, invoice, { id: 'CN-1', issueDate: '2026-09-10', reason: 'DL8.61.1.A' })).toThrow(/but the issued invoice/);
  });
});
