import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { type ArtefactLock, ChecksumMismatchError, fetchArtefacts, safeJoin, sha256, verifyChecksum } from '../../scripts/lib/artefacts.js';
import { extractCodes } from '../../scripts/lib/codelist-extract.js';
import { type ValidationResult, dockerArguments, fatalRuleIds, parseReport } from '../../scripts/lib/validator-client.js';
import { readZip } from '../../scripts/lib/zip.js';

/** Writes a minimal ZIP archive (one stored and one deflated entry) for the reader tests. */
function makeZip(entries: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

const zip = makeZip([
  { name: 'trn-invoice/schematron/rules.xslt', data: Buffer.from('<xsl/>'), deflate: false },
  { name: 'trn-invoice/example/Standard tax invoice.xml', data: Buffer.from('<Invoice/>'.repeat(50)), deflate: true },
  { name: 'common/docs/bis.pdf', data: Buffer.from('%PDF'), deflate: true },
]);

describe('ZIP reader', () => {
  it('reads stored and deflated entries', () => {
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'trn-invoice/schematron/rules.xslt',
      'trn-invoice/example/Standard tax invoice.xml',
      'common/docs/bis.pdf',
    ]);
    expect(entries[0]?.read().toString()).toBe('<xsl/>');
    expect(entries[1]?.read().toString()).toBe('<Invoice/>'.repeat(50));
  });

  it('rejects data that is not a ZIP archive', () => {
    expect(() => readZip(Buffer.from('not a zip at all, just text'))).toThrow(/Not a ZIP archive/);
  });
});

describe('artefact download', () => {
  const dir = mkdtempSync(join(tmpdir(), 'einvoice-ae-artefacts-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const xsd = Buffer.from('<xsd:schema/>');
  const jar = Buffer.from('PK-jar');
  const lock: ArtefactLock = {
    pintAe: { specificationVersion: '1.0.4', pdkVersion: '1.4.4', url: 'https://example.test/resources.zip', sha256: sha256(zip), lastModified: '', extract: ['trn-invoice/'] },
    ubl: { version: '2.1', baseUrl: 'https://example.test/ubl/', files: { 'xsd/maindoc/UBL-Invoice-2.1.xsd': sha256(xsd) } },
    jars: [{ name: 'Saxon-HE', version: '12', licence: 'MPL-2.0', url: 'https://example.test/lib/saxon.jar', sha256: sha256(jar) }],
  };
  const files: Record<string, Buffer> = {
    'https://example.test/resources.zip': zip,
    'https://example.test/ubl/xsd/maindoc/UBL-Invoice-2.1.xsd': xsd,
    'https://example.test/lib/saxon.jar': jar,
  };

  it('verifies checksums, extracts only the listed folders and writes a manifest', async () => {
    const requested: string[] = [];
    const summary = await fetchArtefacts(lock, dir, (url) => {
      requested.push(url);
      const data = files[url];
      return data ? Promise.resolve(data) : Promise.reject(new Error(`404 ${url}`));
    });
    expect(requested).toHaveLength(3);
    expect(summary.files.map((f) => f.path)).toContain('pint-ae/trn-invoice/example/Standard tax invoice.xml');
    expect(summary.files.map((f) => f.path)).not.toContain('pint-ae/common/docs/bis.pdf');
    expect(readFileSync(join(dir, 'pint-ae/trn-invoice/schematron/rules.xslt'), 'utf8')).toBe('<xsl/>');
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as { files: unknown[] };
    expect(manifest.files).toHaveLength(summary.files.length);

    // A second run uses the verified cache and downloads nothing.
    const again: string[] = [];
    await fetchArtefacts(lock, dir, (url) => {
      again.push(url);
      return Promise.resolve(files[url] as Buffer);
    });
    expect(again).toEqual([]);
  });

  it('fails loudly when an upstream file changes', () => {
    expect(() => verifyChecksum('https://example.test/x', Buffer.from('changed'), sha256(Buffer.from('original')))).toThrow(ChecksumMismatchError);
    expect(() => verifyChecksum('https://example.test/x', Buffer.from('changed'), sha256(Buffer.from('original')))).toThrow(/artefacts.lock.json/);
  });

  it('refuses archive entries that would escape the output folder', () => {
    expect(() => safeJoin(dir, '../../evil.txt')).toThrow(/outside/);
    expect(safeJoin(dir, 'a/b.txt')).toBe(join(dir, 'a/b.txt'));
  });
});

describe('code list extraction from Schematron tests', () => {
  it('reads space-separated lists', () => {
    expect(extractCodes("( ( not(contains(normalize-space(.),' ')) and contains( ' DL8.61.1.A VD ',concat(' ',normalize-space(.),' ') ) ) )")).toEqual(['DL8.61.1.A', 'VD']);
  });

  it('reads XPath sequences', () => {
    expect(extractCodes('(cac:Country/cbc:IdentificationCode="AE" and cbc:CountrySubentity = ("AUH", "DXB", "SHJ"))')).toEqual(['AUH', 'DXB', 'SHJ']);
  });

  it('fails when a test holds no list', () => {
    expect(() => extractCodes('exists(cbc:UUID)')).toThrow(/No code list/);
  });
});

describe('validator client', () => {
  const result = (schematron: ValidationResult['schematron']): ValidationResult => ({
    file: 'x.xml',
    documentType: 'Invoice',
    valid: schematron.length === 0,
    error: null,
    xsd: [],
    schematron,
  });

  it('builds an isolated, read-only docker run', () => {
    const root = resolve('repo');
    const args = dockerArguments([join(root, 'corpus', 'valid', 'a.xml'), 'corpus/invalid/b.xml'], { root, image: 'img:tag', memory: '1g' }, 'einvoice-ae-validator-1');
    expect(args).toEqual(expect.arrayContaining(['--rm', '--network', 'none', '--memory', '1g', '--name', 'einvoice-ae-validator-1']));
    expect(args).toContain(`${root}:/work:ro`);
    expect(args.slice(-3)).toEqual(['img:tag', 'corpus/valid/a.xml', 'corpus/invalid/b.xml']);
    expect(() => dockerArguments([resolve('elsewhere.xml')], { root, image: 'i', memory: '1g' }, 'n')).toThrow(/outside the repository/);
  });

  it('reduces findings to distinct fatal rule IDs', () => {
    const r = result([
      { layer: 'pint', id: 'ibr-cl-23', flag: 'fatal', location: '/a', text: '' },
      { layer: 'pint', id: 'ibr-cl-23', flag: 'fatal', location: '/b', text: '' },
      { layer: 'pint-ae', id: 'ibr-x', flag: 'warning', location: '/c', text: '' },
    ]);
    expect(fatalRuleIds(r)).toEqual(['ibr-cl-23']);
  });

  it('parses the report and rejects malformed output', () => {
    expect(parseReport('{"engine":{"saxon":"12.10","java":"25"},"results":[]}').engine.saxon).toBe('12.10');
    expect(() => parseReport('{"engine":{}}')).toThrow(/no results/);
  });
});
