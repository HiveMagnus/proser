import { ZipFile } from 'yazl';
import { deflateRawSync } from 'node:zlib';
import { fromBuffer, type Entry, type ZipFile as ZipReader } from 'yauzl';

export interface ZipEntry {
  name: string;
  content: string | Buffer;
  store?: boolean;
}

export function createZipBuffer(entries: ZipEntry[]): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on('error', reject);
    archive.on('error', reject);
  });

  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf8');
    // Keep packages within the secure import expansion bound. Highly repetitive
    // manuscripts legitimately exceed it under DEFLATE; storing those entries
    // preserves their exact bytes without weakening archive preflight.
    const store = entry.store || (content.length >= 1024 &&
      content.length > Math.max(1, deflateRawSync(content, { level: 9 }).length) * 190);
    archive.addBuffer(content, entry.name, {
      compress: !store,
      compressionLevel: store ? 0 : 9,
    });
  }
  archive.end();
  return done;
}

export interface ZipReadLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

/** Read a bounded ZIP into memory. Rejects unsafe or duplicate names,
 * encrypted entries, directory traversal, size/CRC mismatches and expansion
 * beyond the limits before any entry reaches the caller. */
export function readZipBuffer(bytes: Buffer, limits: ZipReadLimits): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    let archive: ZipReader | undefined;
    let settled = false;
    let total = 0;
    let count = 0;
    const files = new Map<string, Buffer>();
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      archive?.close();
      reject(new ZipReadError(error instanceof Error ? error.message : 'Invalid ZIP archive.'));
    };
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return fail(error);
      archive = zip;
      zip.on('error', fail);
      zip.on('end', () => { if (!settled) { settled = true; resolve(files); } });
      zip.on('entry', (entry: Entry) => {
        if (settled) return;
        if (++count > limits.maxEntries) return fail(new Error(`ZIP entry count exceeds ${limits.maxEntries}.`));
        const name = entry.fileName;
        if (!name || /[\\\0]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '..' || part === '.' || part === '') && !name.endsWith('/') || files.has(name)) return fail(new Error('Unsafe or duplicate ZIP entry name.'));
        if (entry.generalPurposeBitFlag & 1) return fail(new Error('Encrypted ZIP entries are unsupported.'));
        if (entry.uncompressedSize > limits.maxEntryBytes || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 200) return fail(new Error('ZIP decompression limit exceeded.'));
        if (name.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError);
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length; total += chunk.length;
            if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) { stream.destroy(); fail(new Error('ZIP decompression limit exceeded.')); return; }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (settled) return;
            const content = Buffer.concat(chunks);
            if (content.length !== entry.uncompressedSize) return fail(new Error('ZIP entry size mismatch.'));
            files.set(name, content);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

export class ZipReadError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipReadError'; }
}
