/**
 * End to end against the mock provider: build, issue, submit with injected failures,
 * receive the signed status callback, show that resubmission is idempotent, that an issued
 * invoice can only be corrected by a credit note, and that a document the provider
 * rejects is replaced under a new number (ADR-020). Every outcome is checked: the script
 * exits with code 1 when one differs, so CI can run it.
 *
 * Run: npm run example:submit
 * Configuration comes from the environment (see .env.example): MOCK_ASP_PORT (default
 * 58800), EXAMPLE_CALLBACK_PORT (58801), MOCK_ASP_API_KEY and MOCK_ASP_CALLBACK_SECRET
 * (local demo values). The example starts both the mock provider and the receiver, so
 * the key and secret only have to agree with each other.
 */
import { createServer } from 'node:http';
import { standardInvoiceInput } from '../corpus/scenarios.js';
import { DocumentLedger, buildCreditNote, buildInvoice, creditNoteFor, formatAmount } from '../src/index.js';
import { HttpAspClient, type StatusReport, createCallbackHandler, toSubmission } from '../src/provider/index.js';
import { type Decision, MockAspServer, defaultDecision } from '../src/testing/index.js';

const API_KEY = process.env['MOCK_ASP_API_KEY'] ?? 'local-demo-key';
const SECRET = process.env['MOCK_ASP_CALLBACK_SECRET'] ?? 'local-demo-secret';
const aspPort = Number(process.env['MOCK_ASP_PORT'] ?? 58800);
const callbackPort = Number(process.env['EXAMPLE_CALLBACK_PORT'] ?? 58801);

/** The invoice the mock provider is told to reject, as a provider would for a buyer it cannot reach. */
const REJECTED_NUMBER = 'DEMO-INV-2026-0100';
const UNREACHABLE_BUYER: Decision = {
  status: 'rejected',
  errors: [{ code: 'DEMO-BUYER-NOT-FOUND', message: 'The buyer endpoint is not registered (a rule of this demo, not of PINT AE)' }],
};

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`Check failed: ${what}`);
}

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Check failed: ${what} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main(): Promise<void> {
  const reports: StatusReport[] = [];
  const receiver = createServer(createCallbackHandler({ secret: SECRET, onReport: (r) => void reports.push(r) }));
  await new Promise<void>((resolve) => receiver.listen(callbackPort, '127.0.0.1', resolve));
  const asp = new MockAspServer({
    apiKey: API_KEY,
    callbackSecret: SECRET,
    processingDelayMs: 100,
    decide: (xml) => (xml.includes(`<cbc:ID>${REJECTED_NUMBER}</cbc:ID>`) ? UNREACHABLE_BUYER : defaultDecision(xml)),
  });
  await asp.listen(aspPort);

  try {
    const client = new HttpAspClient({
      baseUrl: asp.url,
      apiKey: API_KEY,
      timeoutMs: 2_000,
      retry: { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 2_000 },
      callbackUrl: `http://127.0.0.1:${callbackPort}/callbacks`,
      onRetry: (e) => console.log(`  retry ${e.attempt} after ${e.reason}, waiting ${e.delayMs} ms`),
    });

    const ledger = new DocumentLedger();
    const input = standardInvoiceInput();
    const invoice = await ledger.issue(buildInvoice(input));
    console.log(`Issued ${invoice.id}: AED ${formatAmount(invoice.totals.payableAmount)} due, SHA-256 ${invoice.sha256.slice(0, 16)}...`);

    console.log('Submitting with two injected failures (HTTP 503, then a lost response):');
    asp.injectFaults({ kind: 'status', status: 503 }, { kind: 'error-after-processing', status: 500 });
    const receipt = await client.submit(toSubmission(invoice));
    console.log(`  receipt after ${receipt.attempts} attempts: status ${receipt.status}, replayed ${receipt.replayed}`);
    console.log(`  submissions stored by the provider: ${asp.submissions.length}`);
    check(receipt.attempts === 3 && receipt.replayed, 'the third attempt returns the submission stored by the second');
    check(asp.submissions.length === 1, 'the provider stored the invoice once');

    const report = await waitFor(() => reports.find((r) => r.submissionId === receipt.submissionId), 'a signed callback for the invoice');
    console.log(`Signed callback received: ${report.invoiceId} is ${report.status}`);
    check(report.status === 'accepted', 'the invoice is accepted');

    const again = await client.submit(toSubmission(invoice));
    console.log(`Submitting the same invoice again returns the same submission: ${again.submissionId === receipt.submissionId} (replayed ${again.replayed})`);
    check(again.submissionId === receipt.submissionId && again.replayed, 'resubmission is a replay');
    check(asp.submissions.length === 1, 'resubmission stores nothing new');

    const refused = await ledger.update(invoice.id).then(
      () => undefined,
      (error: Error) => error.message,
    );
    console.log(`Editing the issued invoice is refused: ${refused}`);
    check(refused !== undefined, 'the ledger refuses an edit');

    const creditNote = await ledger.issue(
      buildCreditNote(
        creditNoteFor(input, invoice, {
          id: 'DEMO-CN-2026-0099',
          issueDate: '2026-09-15',
          reason: 'DL8.61.1.D',
          note: 'DEMO - not a tax invoice',
          alreadyCredited: await ledger.creditedQuantities(invoice.id),
          lines: [{ lineId: '1', quantity: '2' }],
        }),
      ),
    );
    const cnReceipt = await client.submit(toSubmission(creditNote));
    const cnFinal = await client.waitForFinalStatus(cnReceipt.submissionId, { intervalMs: 50 });
    console.log(`Credit note ${creditNote.id} for AED ${formatAmount(creditNote.totals.taxInclusiveAmount)} referencing ${creditNote.creditedInvoiceIds.join(', ')}: ${cnFinal.status}`);
    check(cnFinal.status === 'accepted', 'the credit note is accepted');

    const rejectedInput = { ...input, id: REJECTED_NUMBER, uuid: '00000000-0000-4000-8000-000000000100' };
    const rejected = await ledger.issue(buildInvoice(rejectedInput));
    const rejectedFinal = await client.waitForFinalStatus((await client.submit(toSubmission(rejected))).submissionId, { intervalMs: 50 });
    console.log(`Invoice ${rejected.id}: ${rejectedFinal.status} (${rejectedFinal.errors.map((e) => e.code).join(', ')})`);
    check(rejectedFinal.status === 'rejected', 'the provider rejects the demo invoice');

    // A rejected document was never delivered, so it is not credited. Its number stays used
    // in the ledger; the corrected invoice gets a new number.
    const replacement = await ledger.issue(buildInvoice({ ...rejectedInput, id: 'DEMO-INV-2026-0101', uuid: '00000000-0000-4000-8000-000000000101' }));
    const replacementFinal = await client.waitForFinalStatus((await client.submit(toSubmission(replacement))).submissionId, { intervalMs: 50 });
    console.log(`Replacement ${replacement.id} under a new number: ${replacementFinal.status}`);
    check(replacementFinal.status === 'accepted', 'the replacement under a new number is accepted');
    check(asp.submissions.length === 4, 'the provider stored four documents');
  } finally {
    await asp.close();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
