/**
 * Seeded property test against the official validation. Random invoices are built with the
 * library, each is split into partial credit notes with creditNoteFor (continuing from the
 * ledger), and every document goes through the UBL 2.1 XSD and both PINT AE Schematron
 * layers. The same seed always gives the same documents. They are written to
 * out/property/ (git-ignored), so a failing document can be inspected and validated again
 * with `npm run validate -- out/property/<file>`.
 *
 * The inputs are those of test/support/random-documents.ts: categories S, Z, E, O and AE,
 * decimal quantities, price base quantities, gross prices, fixed and percentage line and
 * document-level allowances and charges, per-line VAT rounding and USD with an exchange
 * rate. The partial credit notes carry pro-rated amounts, a stated VAT of category S and,
 * where a credited quantity rounds on its own, a rounding allowance or charge (ADR-019).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_NOTE } from '../../corpus/demo-parties.js';
import { type ValidationResult, fatalRuleIds, runValidator } from '../../scripts/lib/validator-client.js';
import {
  type CreditNoteInput,
  DocumentLedger,
  InvoiceInputError,
  type IssuedDocument,
  ROUNDING_ADJUSTMENT_REASON,
  buildCreditNote,
  buildInvoice,
  creditNoteFor,
} from '../../src/index.js';
import { Picker, randomCreditSplit, randomInvoiceInput, seededRandom } from '../support/random-documents.js';

const SEED = 20260927;
const INVOICES = 80;

const root = fileURLToPath(new URL('../../', import.meta.url));
const outDir = `${root}out/property/`;

interface Generated {
  readonly file: string;
  readonly document: IssuedDocument;
  readonly roundingAdjustment: boolean;
  readonly statedVat: boolean;
}

const hasRoundingAdjustment = (input: CreditNoteInput): boolean =>
  [...(input.allowances ?? []), ...(input.charges ?? [])].some((ac) => ac.reason === ROUNDING_ADJUSTMENT_REASON);

async function generate(): Promise<{ documents: Generated[]; refused: number }> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const documents: Generated[] = [];
  let refused = 0;
  const save = (document: IssuedDocument, creditNote?: CreditNoteInput): void => {
    const file = `out/property/${document.id}.xml`;
    writeFileSync(`${root}${file}`, document.xml);
    documents.push({
      file,
      document,
      roundingAdjustment: creditNote !== undefined && hasRoundingAdjustment(creditNote),
      statedVat: creditNote?.standardRatedVat !== undefined,
    });
  };

  const p = new Picker(seededRandom(SEED));
  for (let n = 0; n < INVOICES; n += 1) {
    const input = randomInvoiceInput(p, n);
    const steps = randomCreditSplit(p, input);
    let built;
    try {
      built = buildInvoice(input);
    } catch (error) {
      // Some random inputs cannot conform (for example an allowance above the line amount).
      if (error instanceof InvoiceInputError) {
        refused += 1;
        continue;
      }
      throw error;
    }
    const ledger = new DocumentLedger();
    const invoice = await ledger.issue(built);
    save(invoice);
    for (const [k, lines] of steps.entries()) {
      const creditNote = creditNoteFor(input, invoice, {
        id: `${input.id}-CN${k + 1}`,
        issueDate: '2026-09-20',
        reason: 'DL8.61.1.D',
        note: DEMO_NOTE,
        alreadyCredited: await ledger.creditedQuantities(invoice.id),
        lines,
      });
      save(await ledger.issue(buildCreditNote(creditNote)), creditNote);
    }
  }
  return { documents, refused };
}

const { documents, refused } = await generate();
const byFile = new Map<string, ValidationResult>();

beforeAll(async () => {
  // The folder, not each file: the validator reads every XML file in it, and a list of
  // hundreds of paths could exceed the command-line limit on Windows.
  const report = await runValidator(['out/property'], { root });
  for (const result of report.results) byFile.set(result.file, result);
  expect(byFile.size).toBe(documents.length);
});

describe(`seeded random documents (seed ${SEED}) pass the official validation`, () => {
  it('cover invoices, partial credit notes, stated VAT and rounding adjustments', () => {
    const creditNotes = documents.filter((d) => d.document.kind === 'CreditNote');
    expect(documents.length - creditNotes.length + refused).toBe(INVOICES);
    expect(documents.length - creditNotes.length).toBeGreaterThan(INVOICES / 2);
    expect(creditNotes.length).toBeGreaterThan(documents.length - creditNotes.length);
    expect(creditNotes.filter((d) => d.statedVat).length).toBeGreaterThan(0);
    expect(creditNotes.filter((d) => d.roundingAdjustment).length).toBeGreaterThan(0);
    expect(documents.filter((d) => d.document.currency !== 'AED').length).toBeGreaterThan(0);
  });

  it.each(documents.map((d) => d.file))('%s', (file) => {
    const result = byFile.get(file);
    expect(result, 'validation result').toBeDefined();
    expect(result?.error).toBeNull();
    expect(result?.xsd, 'UBL 2.1 schema errors').toEqual([]);
    expect(result && fatalRuleIds(result)).toEqual([]);
    // Not even a warning.
    expect(result?.schematron).toEqual([]);
    expect(result?.valid).toBe(true);
  });
});
