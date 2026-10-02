/**
 * npm run artefacts:fetch [-- --upstream]
 *
 * Downloads the PINT AE Schematron, the UBL 2.1 schemas and the Saxon-HE jars into
 * validator/.artefacts (git-ignored), checking each against validator/artefacts.lock.json.
 * Files already there with the right checksum are not downloaded again.
 *
 * With --upstream it downloads everything again into a temporary folder and only reports
 * whether the files at the official URLs still match the lock file.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type ArtefactLock, checkUpstream, fetchArtefacts } from './lib/artefacts.js';

const validatorDir = fileURLToPath(new URL('../validator/', import.meta.url));

async function main(): Promise<void> {
  const lock = JSON.parse(await readFile(`${validatorDir}artefacts.lock.json`, 'utf8')) as ArtefactLock;
  if (process.argv.includes('--upstream')) {
    const summary = await checkUpstream(lock);
    console.log(`The official sources still serve the pinned files: ${summary.files.length} files match validator/artefacts.lock.json.`);
    return;
  }
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
