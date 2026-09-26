/**
 * End to end against the mock provider: build, issue, submit with injected failures,
 * receive the signed status callback, show that resubmission is idempotent and that an
 * issued invoice can only be corrected by a credit note.
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
import { MockAspServer } from '../src/testing/index.js';

const API_KEY = process.env['MOCK_ASP_API_KEY'] ?? 'local-demo-key';
const SECRET = process.env['MOCK_ASP_CALLBACK_SECRET'] ?? 'local-demo-secret';
const aspPort = Number(process.env['MOCK_ASP_PORT'] ?? 58800);
const callbackPort = Number(process.env['EXAMPLE_CALLBACK_PORT'] ?? 58801);

async function main(): Promise<void> {
  const reports: StatusReport[] = [];
  const receiver = createServer(createCallbackHandler({ secret: SECRET, onReport: (r) => void reports.push(r) }));
  await new Promise<void>((resolve) => receiver.listen(callbackPort, '127.0.0.1', resolve));
  const asp = new MockAspServer({ apiKey: API_KEY, callbackSecret: SECRET, processingDelayMs: 100 });
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

    for (let i = 0; i < 100 && reports.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    console.log(`Signed callback received: ${reports[0]?.invoiceId} is ${reports[0]?.status}`);

    const again = await client.submit(toSubmission(invoice));
    console.log(`Submitting the same invoice again returns the same submission: ${again.submissionId === receipt.submissionId} (replayed ${again.replayed})`);

    await ledger.update(invoice.id).catch((error: Error) => console.log(`Editing the issued invoice is refused: ${error.message}`));

    const creditNote = await ledger.issue(
      buildCreditNote(creditNoteFor(input, invoice, { id: 'DEMO-CN-2026-0099', issueDate: '2026-09-15', reason: 'DL8.61.1.D', note: 'DEMO - not a tax invoice', lines: [{ lineId: '1', quantity: '2' }] })),
    );
    const cnReceipt = await client.submit(toSubmission(creditNote));
    const cnFinal = await client.waitForFinalStatus(cnReceipt.submissionId, { intervalMs: 50 });
    console.log(`Credit note ${creditNote.id} for AED ${formatAmount(creditNote.totals.taxInclusiveAmount)} referencing ${creditNote.creditedInvoiceIds.join(', ')}: ${cnFinal.status}`);
  } finally {
    await asp.close();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
