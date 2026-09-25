import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEMO_NOTE } from '../../corpus/demo-parties.js';
import { generateCorpus } from '../../corpus/generate.js';
import { standardInvoiceInput } from '../../corpus/scenarios.js';
import { InvoiceInputError, buildInvoice } from '../../src/index.js';

const corpusDir = fileURLToPath(new URL('../../corpus/', import.meta.url));
const corpus = generateCorpus();

describe('the committed corpus', () => {
  it.each(corpus.files.map((f) => [f.path, f.content] as const))('%s matches what the library generates now', (path, content) => {
    expect(readFileSync(`${corpusDir}${path}`, 'utf8')).toBe(content);
  });

  it('covers the required scenarios', () => {
    const valid = corpus.manifest.filter((m) => m.kind === 'valid').map((m) => m.file);
    for (const name of ['standard-rated', 'zero-rated-export', 'exempt', 'mixed-categories', 'allowances-and-charges', 'credit-note']) {
      expect(valid).toContain(`valid/${name}.xml`);
    }
  });

  it('breaks at least 15 distinct rules, one rule per document', () => {
    const broken = corpus.manifest.filter((m) => m.kind === 'invalid');
    expect(broken.every((m) => m.expectedRules.length === 1)).toBe(true);
    const rules = new Set(broken.map((m) => m.expectedRules[0]));
    expect(rules.size).toBe(broken.length);
    expect(rules.size).toBeGreaterThanOrEqual(15);
  });

  it('marks every document as a demo', () => {
    for (const file of corpus.files.filter((f) => f.path.endsWith('.xml'))) {
      expect(file.content, file.path).toContain(`<cbc:Note>${DEMO_NOTE}</cbc:Note>`);
    }
  });
});

describe('documented gaps in the published rules', () => {
  it('the library rejects a non-emirate subdivision that ibr-128-ae fails to catch', () => {
    const input = standardInvoiceInput();
    const bad = { ...input, seller: { ...input.seller, address: { ...input.seller.address, subdivision: 'Dubai' } } };
    try {
      buildInvoice(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvoiceInputError);
      expect((error as InvoiceInputError).issues.map((i) => i.rule)).toContain('ibr-128-ae');
    }
  });

  it('the library always writes a total VAT equal to its breakdown (what ibr-co-14 intends for credit notes)', () => {
    for (const file of corpus.files.filter((f) => f.path.startsWith('valid/'))) {
      const total = /<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="[A-Z]{3}">([\d.]+)</.exec(file.content)?.[1];
      const parts = [...file.content.matchAll(/<cac:TaxSubtotal>\s*<cbc:TaxableAmount[^>]*>[\d.]+<\/cbc:TaxableAmount>\s*<cbc:TaxAmount[^>]*>([\d.]+)</g)].map((m) =>
        Math.round(Number(m[1]) * 100),
      );
      expect(Math.round(Number(total) * 100), file.path).toBe(parts.reduce((a, b) => a + b, 0));
    }
  });
});
