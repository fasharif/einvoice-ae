/**
 * Minimal ZIP reader for the validation artefacts: stored and deflated entries only,
 * no ZIP64, no encryption. Node's zlib does the decompression, so no dependency is needed.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly size: number;
  read(): Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export function readZip(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt ZIP: bad central directory entry at byte ${offset}`);
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const utf8 = (flags & 0x0800) !== 0;
    const name = archive.toString(utf8 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);
    if ((flags & 0x0001) !== 0) throw new Error(`Encrypted ZIP entries are not supported (${name})`);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`ZIP64 entries are not supported (${name})`);
    }

    entries.push({
      name,
      compressedSize,
      size,
      read(): Buffer {
        if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
          throw new Error(`Corrupt ZIP: bad local header for ${name}`);
        }
        const localNameLength = archive.readUInt16LE(localOffset + 26);
        const localExtraLength = archive.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const data = archive.subarray(start, start + compressedSize);
        let content: Buffer;
        if (method === METHOD_STORED) content = Buffer.from(data);
        else if (method === METHOD_DEFLATE) content = inflateRawSync(data);
        else throw new Error(`Unsupported compression method ${method} for ${name}`);
        if (content.length !== size) {
          throw new Error(`Corrupt ZIP: ${name} inflated to ${content.length} bytes, expected ${size}`);
        }
        return content;
      },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = 22;
  const earliest = Math.max(0, archive.length - minimum - 0xffff);
  for (let i = archive.length - minimum; i >= earliest; i -= 1) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Not a ZIP archive: end of central directory not found');
}
