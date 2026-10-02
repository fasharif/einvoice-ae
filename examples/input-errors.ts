/**
 * Shows how the input checks report mistakes: every problem at once, each with the path of
 * the field, a message and the official rule ID the check mirrors. The input is the
 * standard demo invoice from the corpus with three mistakes a business system could make.
 *
 * Run: npm run example:errors
 */
import { pathToFileURL } from 'node:url';
import { standardInvoiceInput } from '../corpus/scenarios.js';
import { type InvoiceInput, InvoiceInputError, buildInvoice } from '../src/index.js';

/** The standard demo invoice with a mistyped TRN, an emirate name instead of its code and a unit code outside UN/ECE Recommendation 20. */
export function mistakenInput(): InvoiceInput {
  const input = standardInvoiceInput();
  const [first, ...rest] = input.lines;
  if (!first) throw new Error('The standard demo invoice has no lines');
  return {
    ...input,
    seller: { ...input.seller, trn: '100000000100004', address: { ...input.seller.address, subdivision: 'Dubai' } },
    lines: [{ ...first, unitCode: 'PCS' }, ...rest],
  };
}

/** The message of the error that buildInvoice throws for the mistaken input. */
export function inputErrorReport(): string {
  try {
    buildInvoice(mistakenInput());
  } catch (error) {
    if (error instanceof InvoiceInputError) return error.message;
    throw error;
  }
  throw new Error('The mistaken input was accepted');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(inputErrorReport());
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
