// The input checks use the hand-kept PINT AE lists in pint-ae.ts (they carry names for
// error messages). generated.ts is extracted from the official Schematron and kept in step
// by `npm run codelists:sync -- --check`. These tests tie the two together, so an upstream
// change to a list cannot leave the input checks behind.
import { describe, expect, it } from 'vitest';
import {
  BILLING_FREQUENCIES,
  BILLING_FREQUENCY_CODES,
  CREDIT_NOTE_REASONS,
  CREDIT_NOTE_REASON_CODES,
  EMIRATES,
  EMIRATE_CODES,
  REVERSE_CHARGE_GOODS,
  REVERSE_CHARGE_GOODS_CODES,
  SUPPORTED_TAX_CATEGORIES,
  TAX_CATEGORIES,
  TAX_CATEGORY_CODES,
} from '../../src/index.js';

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('hand-kept PINT AE code lists match the official Schematron', () => {
  it.each([
    ['credit note reasons (ibr-001-ae)', CREDIT_NOTE_REASONS, CREDIT_NOTE_REASON_CODES],
    ['billing frequencies (ibr-005-ae)', BILLING_FREQUENCIES, BILLING_FREQUENCY_CODES],
    ['reverse-charge goods (ibr-006-ae)', REVERSE_CHARGE_GOODS, REVERSE_CHARGE_GOODS_CODES],
    ['emirates (ibr-128-ae)', EMIRATES, EMIRATE_CODES],
    ['VAT categories', TAX_CATEGORIES, TAX_CATEGORY_CODES],
  ] as const)('%s', (_name, handKept, generated) => {
    expect(sorted(Object.keys(handKept))).toEqual(sorted(generated));
  });

  it('supports every official VAT category except N', () => {
    expect(sorted(SUPPORTED_TAX_CATEGORIES)).toEqual(sorted([...TAX_CATEGORY_CODES].filter((code) => code !== 'N')));
  });
});
