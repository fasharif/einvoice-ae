/**
 * Every official rule ID that the input checks and calculations cite has a case here: a
 * minimal change to a valid input that must be refused with that rule ID. The list of IDs
 * is read from the source, so a newly cited rule without a case fails this test.
 *
 * For the rules that also have a broken corpus document, the conformance suite shows the
 * official Schematron failing the XML with the same ID, so those rules are checked on both
 * sides: the library refuses the input, and the validator refuses the document.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exemptInvoiceInput, standardInvoiceInput } from '../../corpus/scenarios.js';
import {
  type CreditNoteInput,
  type DocumentAllowanceCharge,
  type InvoiceInput,
  InvoiceInputError,
  type LineInput,
  type ValidationIssue,
  buildInvoice,
  validateCreditNoteInput,
  validateInvoiceInput,
} from '../../src/index.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const source = (file: string): string => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
const citedRules = [
  ...new Set(['validation.ts', 'calculate.ts', 'build.ts'].flatMap((f) => [...source(f).matchAll(/'((?:ibr|aligned-ibrp)-[a-z0-9-]+)'/g)].map((m) => m[1] as string))),
].sort();

function invoice(change: (input: Mutable<InvoiceInput>) => void): ValidationIssue[] {
  const input = structuredClone(standardInvoiceInput());
  change(input);
  return validateInvoiceInput(input);
}

function outOfScope(change: (input: Mutable<InvoiceInput>) => void): ValidationIssue[] {
  const input = structuredClone(exemptInvoiceInput());
  change(input);
  return validateInvoiceInput(input);
}

function creditNote(change: (input: Mutable<CreditNoteInput>) => void): ValidationIssue[] {
  const base = standardInvoiceInput();
  const input: CreditNoteInput = structuredClone({
    id: 'CN-1',
    issueDate: '2026-09-15',
    reason: 'DL8.61.1.A',
    precedingInvoices: [{ id: base.id, issueDate: base.issueDate }],
    currency: 'AED',
    seller: base.seller,
    buyer: base.buyer,
    lines: base.lines,
  });
  change(input);
  return validateCreditNoteInput(input);
}

/** Issues from building, for the checks made while calculating. */
function built(change: (input: Mutable<InvoiceInput>) => void): readonly ValidationIssue[] {
  const input = structuredClone(standardInvoiceInput());
  change(input);
  try {
    buildInvoice(input);
  } catch (error) {
    if (error instanceof InvoiceInputError) return error.issues;
    throw error;
  }
  return [];
}

const line = (i: Mutable<InvoiceInput>, change: Partial<LineInput>): LineInput[] => [{ ...i.lines[0]!, ...change }];
const item = (i: Mutable<InvoiceInput>, change: Partial<LineInput['item']>): LineInput[] => line(i, { item: { ...i.lines[0]!.item, ...change } });
const S = { category: 'S' } as const;
const noTax = (ac: Omit<DocumentAllowanceCharge, 'tax'>): DocumentAllowanceCharge => ac as DocumentAllowanceCharge;
const withN = (ac: Omit<DocumentAllowanceCharge, 'tax'>): DocumentAllowanceCharge => ({ ...ac, tax: { category: 'N' } }) as unknown as DocumentAllowanceCharge;
const passport = (type: 'PAS', passportCountry?: string) => ({ id: 'DEMO-P-1', type, ...(passportCountry ? { passportCountry } : {}) });
const disclosedAgent = { disclosedAgentBilling: true } as const;

const cases: Record<string, () => readonly ValidationIssue[]> = {
  'aligned-ibrp-032': () => invoice((i) => (i.allowances = [noTax({ amount: 1, reason: 'X' })])),
  'aligned-ibrp-037': () => invoice((i) => (i.charges = [noTax({ amount: 1, reason: 'X' })])),
  'aligned-ibrp-057': () => invoice((i) => (i.allowances = [{ reason: 'X', baseAmount: 100, amount: 1, tax: S }])),
  'aligned-ibrp-058': () => invoice((i) => (i.charges = [{ reason: 'X', percent: '5', amount: 1, tax: S }])),
  'aligned-ibrp-s-09': () =>
    built((i) => {
      i.vatRounding = 'line';
      i.lines = Array.from({ length: 6 }, (_, n) => ({ ...i.lines[0]!, id: String(n + 1), quantity: '1', unitPrice: 10 }));
    }),
  'ibr-001-ae': () => creditNote((c) => (c.reason = 'X' as 'VD')),
  'ibr-002-ae': () => invoice((i) => Object.assign(i, { currency: 'USD', exchangeRate: '3.6725001' })),
  'ibr-005-ae': () => invoice((i) => (i.invoicePeriod = { frequency: 'MONTHLY' as 'MTH' })),
  'ibr-006-ae': () => invoice((i) => (i.lines = item(i, { reverseChargeGoods: 'DL0' as 'DL8.48.8.1' }))),
  'ibr-007-ae': () => invoice((i) => (i.transactionType = { freeTradeZone: true })),
  'ibr-010-ae': () => invoice((i) => (i.buyer = { ...i.buyer, legalRegistration: passport('PAS') })),
  'ibr-011-ae': () => invoice((i) => (i.buyer = { ...i.buyer, legalRegistration: passport('PAS', 'XX') })),
  'ibr-012-ae': () => invoice((i) => (i.seller = { ...i.seller, legalRegistration: passport('PAS') })),
  'ibr-013-ae': () => invoice((i) => (i.seller = { ...i.seller, legalRegistration: passport('PAS', 'XX') })),
  'ibr-016': () => invoice((i) => (i.lines = [])),
  'ibr-022': () => invoice((i) => (i.lines = line(i, { quantity: undefined as unknown as string }))),
  'ibr-023': () => invoice((i) => (i.lines = line(i, { unitCode: undefined as unknown as string }))),
  'ibr-025': () => invoice((i) => (i.lines = line(i, { item: undefined as never }))),
  'ibr-029': () => invoice((i) => (i.invoicePeriod = { start: '2026-09-30', end: '2026-09-01' })),
  'ibr-030': () => invoice((i) => (i.lines = line(i, { period: { start: '2026-09-10', end: '2026-09-01' } }))),
  'ibr-031': () => invoice((i) => (i.allowances = [{ reason: 'X', tax: S }])),
  'ibr-033': () => invoice((i) => (i.allowances = [{ amount: 1, tax: S }])),
  'ibr-036': () => invoice((i) => (i.charges = [{ reason: 'X', tax: S }])),
  'ibr-038': () => invoice((i) => (i.charges = [{ amount: 1, tax: S }])),
  'ibr-041': () => invoice((i) => (i.lines = line(i, { allowances: [{ reason: 'X' }] }))),
  'ibr-042': () => invoice((i) => (i.lines = line(i, { allowances: [{ amount: 1 }] }))),
  'ibr-043': () => invoice((i) => (i.lines = line(i, { charges: [{ reason: 'X' }] }))),
  'ibr-044': () => invoice((i) => (i.lines = line(i, { charges: [{ amount: 1 }] }))),
  'ibr-055-ae': () => creditNote((c) => (c.precedingInvoices = [])),
  'ibr-057': () => invoice((i) => (i.delivery = { address: { country: 'XX' } })),
  'ibr-066': () => invoice((i) => (i.paymentMeans = [1, 2].map(() => ({ code: '48', card: { primaryAccountNumberId: '1234', network: 'VISA' } })))),
  'ibr-073': () => invoice((i) => (i.issueDate = '2026-02-30')),
  'ibr-079': () => invoice((i) => (i.buyerReference = '   ')),
  'ibr-080': () => invoice((i) => (i.buyer = { ...i.buyer, endpoint: undefined as never })),
  'ibr-081': () => invoice((i) => (i.seller = { ...i.seller, endpoint: undefined as never })),
  'ibr-083': () => invoice((i) => (i.lines = line(i, { grossUnitPrice: 1 }))),
  'ibr-085': () => invoice((i) => Object.assign(i, { invoicePeriod: { start: '2026-09-01', end: '2026-09-30' }, lines: line(i, { period: { start: '2026-08-01' } }) })),
  'ibr-086': () => invoice((i) => Object.assign(i, { invoicePeriod: { start: '2026-09-01', end: '2026-09-30' }, lines: line(i, { period: { end: '2026-10-01' } }) })),
  'ibr-101-ae': () => invoice((i) => (i.buyer = { ...i.buyer, legalRegistration: { id: 'X', type: 'TL' } })),
  'ibr-103-ae': () => invoice((i) => Object.assign(i, { buyer: { ...i.buyer, trn: undefined }, lines: line(i, { tax: { category: 'AE' } }) })),
  'ibr-114-ae': () => invoice((i) => (i.charges = [withN({ amount: 1, reason: 'X' })])),
  'ibr-115-ae': () => invoice((i) => (i.allowances = [withN({ amount: 1, reason: 'X' })])),
  'ibr-119': () => invoice((i) => (i.issueTime = '9:30')),
  'ibr-122-ae': () => outOfScope((i) => (i.lines = [...i.lines, { ...standardInvoiceInput().lines[0]!, id: '9' }])),
  'ibr-124-ae': () => creditNote((c) => Object.assign(c, { taxPointDate: '2026-09-01' })),
  'ibr-125-ae': () => invoice((i) => (i.lines = item(i, { description: undefined as unknown as string }))),
  'ibr-127-ae': () => built((i) => (i.dueDate = undefined as unknown as string)),
  'ibr-128-ae': () => invoice((i) => (i.seller = { ...i.seller, address: { ...i.seller.address, subdivision: 'Dubai' } })),
  'ibr-131-ae': () => built((i) => (i.lines = line(i, { allowances: [{ percent: '10', baseAmount: 1_000_00, amount: 50_00, reason: 'X' }] }))),
  'ibr-132-ae': () => invoice((i) => (i.seller = { ...i.seller, trn: '100000000100004' })),
  'ibr-134-ae': () => invoice((i) => (i.seller = { ...i.seller, trn: undefined as unknown as string })),
  'ibr-135-ae': () => invoice((i) => (i.buyer = { ...i.buyer, endpoint: { id: '9900000098' }, trn: undefined as unknown as string })),
  'ibr-136-ae': () => outOfScope((i) => (i.buyer = { ...i.buyer, legalRegistration: undefined as never })),
  'ibr-137-ae': () => invoice((i) => (i.transactionType = disclosedAgent)),
  'ibr-138-ae': () => invoice((i) => (i.transactionType = { summaryInvoice: true })),
  'ibr-139-ae': () => invoice((i) => (i.lines = line(i, { tax: { category: 'X' } as never }))),
  'ibr-141-ae': () => invoice((i) => (i.taxPointDate = '2026-09-02')),
  'ibr-142-ae': () => invoice((i) => Object.assign(i, { transactionType: { eCommerce: true }, delivery: { date: '2026-09-01' } })),
  'ibr-143-ae': () => invoice((i) => (i.seller = { ...i.seller, address: { ...i.seller.address, city: undefined as unknown as string } })),
  'ibr-144-ae': () => invoice((i) => (i.buyer = { ...i.buyer, address: { ...i.buyer.address, street: undefined as unknown as string } })),
  'ibr-145-ae': () => invoice((i) => (i.lines = line(i, { tax: undefined as never }))),
  'ibr-146-ae': () => built((i) => (i.lines = line(i, { charges: [{ percent: '10', baseAmount: 1_000_00, amount: 50_00, reason: 'X' }] }))),
  // Reachable only far beyond realistic amounts, where binary floating point runs out of digits.
  'ibr-147-ae': () => built((i) => (i.lines = line(i, { quantity: '8933401920.4', unitPrice: 6_764_498 }))),
  'ibr-148-ae': () => invoice((i) => (i.seller = { ...i.seller, tin: '2000000000' })),
  'ibr-150-ae': () => invoice((i) => (i.seller = { ...i.seller, legalRegistration: undefined as never })),
  'ibr-151-ae': () => invoice((i) => (i.lines = exemptInvoiceInput().lines)),
  'ibr-152-ae': () => invoice((i) => Object.assign(i, { transactionType: { exports: true }, delivery: undefined })),
  'ibr-157-ae': () => outOfScope((i) => (i.transactionType = { summaryInvoice: true })),
  'ibr-158-ae': () => creditNote((c) => (c.reason = undefined as unknown as 'VD')),
  'ibr-159-ae': () => invoice((i) => (i.currency = 'USD')),
  'ibr-160-ae': () => invoice((i) => Object.assign(i, { note: undefined, invoicePeriod: { frequency: 'OTH' } })),
  'ibr-166-ae': () => invoice((i) => (i.lines = line(i, { tax: { category: 'AE' } }))),
  'ibr-167-ae': () => invoice((i) => (i.lines = [...i.lines, { ...i.lines[0]!, id: '9', tax: { category: 'E' } as never }])),
  'ibr-168-ae': () => invoice((i) => (i.allowances = [{ reason: 'X', amount: 1, tax: { category: 'E' } }])),
  'ibr-169-ae': () => invoice((i) => (i.charges = [{ reason: 'X', amount: 1, tax: { category: 'E' } }])),
  'ibr-172-ae': () => invoice((i) => (i.seller = { ...i.seller, legalRegistration: { id: 'X', type: 'TL' } })),
  'ibr-173-ae': () => invoice((i) => (i.seller = { ...i.seller, legalRegistration: { id: 'X', type: 'XX' as 'TL' } })),
  'ibr-174-ae': () => invoice((i) => (i.lines = line(i, { tax: { category: 'AE' } }))),
  'ibr-176-ae': () => invoice((i) => Object.assign(i, { transactionType: disclosedAgent, principalId: i.seller.trn })),
  'ibr-177-ae': () =>
    invoice((i) => Object.assign(i, { transactionType: disclosedAgent, principalId: '100000000900003', seller: { ...i.seller, trn: undefined, tin: undefined } })),
  'ibr-183-ae': () => invoice((i) => (i.buyer = { ...i.buyer, legalRegistration: { id: 'X', type: 'XX' as 'TL' } })),
  'ibr-184-ae': () => invoice((i) => (i.lines = line(i, { item: { name: 'X', description: 'X', type: 'G' } }))),
  'ibr-185-ae': () => invoice((i) => (i.lines = line(i, { item: { name: 'X', description: 'X', type: 'S' } }))),
  'ibr-186-ae': () => invoice((i) => (i.lines = line(i, { item: { name: 'X', description: 'X', type: 'B', hsCode: '1' } }))),
  'ibr-191-ae': () => invoice((i) => (i.paymentMeans = [])),
  'ibr-192-ae': () => invoice((i) => (i.paymentMeans = [{ code: '30' }])),
  'ibr-cl-01': () => invoice((i) => (i.typeCode = '389' as '380')),
  'ibr-cl-04': () => invoice((i) => (i.currency = 'DIRHAM')),
  'ibr-cl-10': () => invoice((i) => (i.buyer = { ...i.buyer, identifier: { id: 'X', scheme: 'ABC' } })),
  'ibr-cl-14': () => invoice((i) => (i.buyer = { ...i.buyer, address: { ...i.buyer.address, country: 'UAE' } })),
  'ibr-cl-15': () => invoice((i) => (i.lines = item(i, { originCountry: 'XX' }))),
  'ibr-cl-16': () => invoice((i) => (i.paymentMeans = [{ code: 'XX', account: { id: '1' } }])),
  'ibr-cl-19': () => invoice((i) => (i.allowances = [{ reasonCode: 'FC', amount: 1, tax: S }])),
  'ibr-cl-20': () => invoice((i) => (i.charges = [{ reasonCode: '95', amount: 1, tax: S }])),
  'ibr-cl-21': () => invoice((i) => (i.lines = item(i, { standardItemId: { id: '1', scheme: 'GTIN' } }))),
  'ibr-cl-23': () => invoice((i) => (i.lines = line(i, { unitCode: 'PCS' }))),
  'ibr-cl-25': () => invoice((i) => (i.buyer = { ...i.buyer, endpoint: { scheme: '9999', id: 'X' } })),
  'ibr-cl-26': () => invoice((i) => (i.delivery = { locationId: { id: 'X', scheme: 'ABC' } })),
  'ibr-co-19': () => invoice((i) => (i.invoicePeriod = {})),
  'ibr-co-20': () => invoice((i) => (i.lines = line(i, { period: {} }))),
  'ibr-co-26': () =>
    invoice((i) => (i.seller = { ...i.seller, endpoint: { scheme: '0088', id: '5790000435968' }, trn: undefined as unknown as string, legalRegistration: undefined as never })),
};

describe('every rule ID cited in the source has a case', () => {
  it('covers exactly the cited rules', () => {
    expect(citedRules.length).toBeGreaterThan(90);
    expect(Object.keys(cases).sort()).toEqual(citedRules);
  });

  it('matches the list and the count in docs/spec-coverage.md', () => {
    const doc = readFileSync(new URL('../../docs/spec-coverage.md', import.meta.url), 'utf8');
    const section = /\*\*Checked on input[^\n]*\n\n([^\n]+)/.exec(doc);
    expect(section, 'the "Checked on input" list').not.toBeNull();
    const listed = [...(section?.[1] ?? '').matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual(citedRules);
    expect(doc).toContain(`mirror these ${citedRules.length} rules`);
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(`Each of the ${citedRules.length} rules the checks mirror has a unit test`);
  });

  it.each(Object.entries(cases))('%s', (rule, run) => {
    const issues = run();
    expect(issues.map((i) => i.rule).filter(Boolean)).toContain(rule);
  });
});

describe('rules checked on both sides', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../corpus/manifest.json', import.meta.url), 'utf8')) as {
    documents: { kind: string; expectedRules: string[] }[];
  };
  const broken = new Set(manifest.documents.filter((d) => d.kind === 'invalid').flatMap((d) => d.expectedRules));
  const both = [...broken].filter((rule) => rule in cases).sort();

  it('includes every broken-corpus rule that the input checks mirror', () => {
    // The other broken-corpus rules cover what the builder always writes correctly
    // (totals, identifiers, AED line amounts), so no input can break them.
    expect(both.length).toBe(29);
    for (const rule of both) expect(cases[rule], rule).toBeDefined();
    const doc = readFileSync(new URL('../../docs/spec-coverage.md', import.meta.url), 'utf8');
    expect(doc).toContain(`For ${both.length} of them the conformance suite`);
  });
});

