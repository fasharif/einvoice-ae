/**
 * Downloads the third-party validation artefacts listed in validator/artefacts.lock.json,
 * checks every file against its pinned SHA-256 and unpacks the PINT AE resources.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { readZip } from './zip.js';

export interface ArtefactLock {
  pintAe: {
    specificationVersion: string;
    pdkVersion: string;
    url: string;
    sha256: string;
    lastModified: string;
    extract: string[];
  };
  ubl: { version: string; baseUrl: string; files: Record<string, string> };
  jars: { name: string; version: string; licence: string; url: string; sha256: string }[];
}

export type Fetcher = (url: string) => Promise<Buffer>;

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly url: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Checksum mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}\n` +
        'The upstream file changed. Read the release notes, review the new artefacts, then ' +
        'update validator/artefacts.lock.json in a separate commit.',
    );
    this.name = 'ChecksumMismatchError';
  }
}

export function verifyChecksum(url: string, data: Buffer, expected: string): void {
  const actual = sha256(data);
  if (actual !== expected.toLowerCase()) throw new ChecksumMismatchError(url, expected, actual);
}

/** Downloads with a timeout and a few retries for transient network failures. */
export const httpFetcher: Fetcher = async (url) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
      if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`Download failed after 3 attempts: ${url}`, { cause: lastError });
};

/** Returns a cached file when its checksum still matches, otherwise downloads it again. */
async function fetchVerified(fetcher: Fetcher, url: string, expected: string, target: string): Promise<Buffer> {
  if (existsSync(target)) {
    const cached = await readFile(target);
    if (sha256(cached) === expected) return cached;
  }
  const data = await fetcher(url);
  verifyChecksum(url, data, expected);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  return data;
}

/** Guards against entries such as "../../etc/passwd" escaping the output folder. */
export function safeJoin(root: string, relative: string): string {
  const target = normalize(join(root, relative));
  const rootWithSep = normalize(root).endsWith(sep) ? normalize(root) : normalize(root) + sep;
  if (!target.startsWith(rootWithSep)) throw new Error(`Refusing to write outside ${root}: ${relative}`);
  return target;
}

export interface FetchSummary {
  files: { path: string; sha256: string; source: string }[];
}

export async function fetchArtefacts(lock: ArtefactLock, outDir: string, fetcher: Fetcher = httpFetcher): Promise<FetchSummary> {
  const summary: FetchSummary = { files: [] };

  const zipPath = join(outDir, 'downloads', 'pint-ae-resources.zip');
  const zip = await fetchVerified(fetcher, lock.pintAe.url, lock.pintAe.sha256, zipPath);
  summary.files.push({ path: 'downloads/pint-ae-resources.zip', sha256: lock.pintAe.sha256, source: lock.pintAe.url });
  const pintRoot = join(outDir, 'pint-ae');
  for (const entry of readZip(zip)) {
    if (entry.name.endsWith('/')) continue;
    if (!lock.pintAe.extract.some((prefix) => entry.name.startsWith(prefix))) continue;
    const content = entry.read();
    const target = safeJoin(pintRoot, entry.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    summary.files.push({ path: `pint-ae/${entry.name}`, sha256: sha256(content), source: `${lock.pintAe.url}#${entry.name}` });
  }

  for (const [relative, expected] of Object.entries(lock.ubl.files)) {
    const url = new URL(relative, lock.ubl.baseUrl).toString();
    await fetchVerified(fetcher, url, expected, safeJoin(join(outDir, 'ubl'), relative));
    summary.files.push({ path: `ubl/${relative}`, sha256: expected, source: url });
  }

  for (const jar of lock.jars) {
    const fileName = jar.url.slice(jar.url.lastIndexOf('/') + 1);
    await fetchVerified(fetcher, jar.url, jar.sha256, join(outDir, 'lib', fileName));
    summary.files.push({ path: `lib/${fileName}`, sha256: jar.sha256, source: jar.url });
  }

  summary.files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(outDir, 'MANIFEST.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/**
 * Downloads every artefact again into a temporary folder, ignoring the local copies, and
 * checks it against the lock file; nothing is kept. The scheduled workflow uses it to
 * notice when a file at an unversioned URL has been replaced upstream, before a fresh
 * clone or a CI run without the cache fails on it.
 */
export async function checkUpstream(lock: ArtefactLock, fetcher: Fetcher = httpFetcher): Promise<FetchSummary> {
  const dir = await mkdtemp(join(tmpdir(), 'einvoice-ae-upstream-'));
  try {
    return await fetchArtefacts(lock, dir, fetcher);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
