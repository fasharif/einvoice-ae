/**
 * Runs the committed corpus and the official PINT AE examples through the UBL 2.1 XSD and
 * the official PINT AE Schematron (Saxon-HE in Docker). Needs the validator image:
 *   npm run validator:build
 *   npm run test:conformance
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifestEntry } from '../../corpus/generate.js';
import { type ValidationReport, type ValidationResult, fatalRuleIds, runValidator } from '../../scripts/lib/validator-client.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = (JSON.parse(readFileSync(`${root}corpus/manifest.json`, 'utf8')) as { documents: ManifestEntry[] }).documents;

const examplesDirs = ['trn-invoice/example', 'trn-creditnote/example'].map((d) => `validator/.artefacts/pint-ae/${d}`);
if (!examplesDirs.every((d) => existsSync(`${root}${d}`))) {
  throw new Error('Validation artefacts are missing. Run `npm run validator:build` before `npm run test:conformance`.');
}
const officialExamples = examplesDirs.flatMap((dir) =>
  readdirSync(`${root}${dir}`)
    .filter((f) => f.endsWith('.xml'))
    .sort()
    .map((f) => `${dir}/${f}`),
);

/** The one published example that the UBL 2.1 schema rejects (element order in a line). */
const KNOWN_INVALID_EXAMPLE = 'Volume-discount-credit-note.xml';

let report: ValidationReport;
const byFile = new Map<string, ValidationResult>();

beforeAll(async () => {
  report = await runValidator([...manifest.map((m) => `corpus/${m.file}`), ...officialExamples], { root });
  for (const result of report.results) byFile.set(result.file, result);
});

function resultFor(file: string): ValidationResult {
  const result = byFile.get(file);
  if (!result) throw new Error(`No validation result for ${file}`);
  return result;
}

describe('validator engine', () => {
  it('uses Saxon-HE', () => {
    expect(report.engine.saxon).toMatch(/^12\./);
  });
});

describe.each([
  ['valid documents pass the XSD and both Schematron layers', 'valid'],
  ['broken documents fail with exactly their rule', 'invalid'],
  ['gap documents break a rule that the published Schematron does not report', 'gap'],
] as const)('%s', (_title, kind) => {
  const entries = manifest.filter((m) => m.kind === kind);

  it.each(entries.map((m) => [m.file, m] as const))('%s', (file, entry) => {
    const result = resultFor(`corpus/${file}`);
    expect(result.error).toBeNull();
    expect(result.xsd, 'UBL 2.1 schema errors').toEqual([]);
    expect(fatalRuleIds(result)).toEqual([...entry.expectedRules]);
    expect(result.valid).toBe(entry.expectedRules.length === 0);
  });
});

describe('official PINT AE examples (sanity check of the validation set-up)', () => {
  it.each(officialExamples)('%s', (file) => {
    const result = resultFor(file);
    if (file.endsWith(KNOWN_INVALID_EXAMPLE)) {
      // Published with CreditNoteLine children out of schema order; reported upstream behaviour.
      expect(result.xsd.length).toBeGreaterThan(0);
      expect(fatalRuleIds(result)).toEqual([]);
    } else {
      expect(result.xsd).toEqual([]);
      expect(fatalRuleIds(result)).toEqual([]);
    }
  });
});
