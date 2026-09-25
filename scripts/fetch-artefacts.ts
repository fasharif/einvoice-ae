/**
 * npm run artefacts:fetch
 *
 * Downloads the PINT AE Schematron, the UBL 2.1 schemas and the Saxon-HE jars into
 * validator/.artefacts (git-ignored), checking each against validator/artefacts.lock.json.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type ArtefactLock, fetchArtefacts } from './lib/artefacts.js';

const validatorDir = fileURLToPath(new URL('../validator/', import.meta.url));

async function main(): Promise<void> {
  const lock = JSON.parse(await readFile(`${validatorDir}artefacts.lock.json`, 'utf8')) as ArtefactLock;
  const summary = await fetchArtefacts(lock, `${validatorDir}.artefacts`);
  console.log(
    `Verified ${summary.files.length} files (PINT AE ${lock.pintAe.specificationVersion}, ` +
      `${lock.ubl.version}, ${lock.jars.map((j) => `${j.name} ${j.version}`).join(', ')}).`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
