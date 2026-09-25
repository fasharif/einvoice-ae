/**
 * npm run validate -- <file-or-folder>... [--json]
 *
 * Validates UBL documents against the UBL 2.1 XSD and the official PINT AE Schematron in
 * the validation container, and prints one line per document.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fatalRuleIds, runValidator } from './lib/validator-client.js';

function expand(paths: string[]): string[] {
  return paths.flatMap((path) => {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path)
      .filter((name) => name.endsWith('.xml'))
      .sort()
      .map((name) => join(path, name));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = expand(args.filter((a) => a !== '--json'));
  if (files.length === 0) {
    console.error('Usage: npm run validate -- <file-or-folder>... [--json]');
    process.exitCode = 2;
    return;
  }
  const report = await runValidator(files);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Saxon-HE ${report.engine.saxon} on Java ${report.engine.java}`);
    for (const r of report.results) {
      const rules = fatalRuleIds(r);
      const detail = r.error ?? (r.xsd.length > 0 ? `XSD: ${r.xsd[0]?.message ?? ''}` : rules.join(', '));
      console.log(`${r.valid ? 'valid  ' : 'INVALID'}  ${r.file}${detail ? `  ${detail}` : ''}`);
    }
  }
  if (report.results.some((r) => !r.valid)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
