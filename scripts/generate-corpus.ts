/**
 * npm run corpus:generate [-- --check]
 *
 * Writes the valid and broken corpus documents and corpus/manifest.json. With --check
 * nothing is written; the script fails when a committed file differs from what the
 * library produces now.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCorpus } from '../corpus/generate.js';

const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));

async function existingXml(): Promise<string[]> {
  const found: string[] = [];
  for (const folder of ['valid', 'invalid', 'gaps']) {
    const entries = await readdir(join(corpusDir, folder)).catch(() => [] as string[]);
    for (const entry of entries) if (entry.endsWith('.xml')) found.push(`${folder}/${entry}`);
  }
  return found;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const corpus = generateCorpus();
  const expected = new Set(corpus.files.map((f) => f.path));

  if (check) {
    const problems: string[] = [];
    for (const file of corpus.files) {
      const current = await readFile(join(corpusDir, file.path), 'utf8').catch(() => undefined);
      if (current !== file.content) problems.push(`${file.path} is ${current === undefined ? 'missing' : 'out of date'}`);
    }
    for (const path of await existingXml()) if (!expected.has(path)) problems.push(`${path} is not generated any more`);
    if (problems.length > 0) {
      console.error(`${problems.join('\n')}\nRun \`npm run corpus:generate\` and commit the result.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Corpus is up to date (${corpus.manifest.length} documents).`);
    return;
  }

  for (const path of await existingXml()) if (!expected.has(path)) await rm(join(corpusDir, path));
  for (const file of corpus.files) {
    const target = join(corpusDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  const count = (kind: string): number => corpus.manifest.filter((m) => m.kind === kind).length;
  console.log(`Wrote ${count('valid')} valid, ${count('invalid')} broken and ${count('gap')} gap documents to corpus/.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
