import { z } from 'zod';
import { DocumentError } from '@/documents/errors';
import { parseManuscript } from './legacyManuscript';

export const legacyBundleSchema = z.object({ schemaVersion: z.literal(1), files: z.array(z.object({ name: z.string().min(1).max(1024), bytesBase64: z.string().max(44 * 1024 * 1024) }).strict()).min(1).max(10000) }).strict();
// Bulk originals have the approved 32 MiB bound. Preserve long imported codex
// descriptions rather than applying the interactive form's smaller edit ceiling.
const codexEntrySchema = z.object({ entryType: z.enum(['character','location','lore','item','faction','event','rule','culture','relationship']), entryName: z.string().min(1).max(255), entryDescription: z.string().max(32 * 1024 * 1024), attributes: z.string().max(32 * 1024 * 1024) }).strict();
function frontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const attributes: Record<string, string> = {};
  if (match) for (const line of match[1].split(/\r?\n/)) { const property = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/); if (property) attributes[property[1]] = property[2].trim(); }
  return { attributes, body: match ? match[2].trim() : markdown.trim() };
}
export function decodeLegacyBundle(bytes: Uint8Array, fallbackTitle: string) {
  const bundle = legacyBundleSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const files = new Map<string, string>(); let expanded = 0;
  for (const file of bundle.files) {
    if (file.name.includes('\\') || file.name.startsWith('/') || file.name.split('/').some((part) => !part || part === '.' || part === '..') || files.has(file.name)) throw new DocumentError('DOCUMENT_IMPORT_PATH_INVALID', 'Import paths must be unique safe relative names.', 422);
    const decoded = Buffer.from(file.bytesBase64, 'base64');
    if (decoded.toString('base64') !== file.bytesBase64) throw new DocumentError('DOCUMENT_IMPORT_ENCODING_INVALID', 'Original bytes use canonical base64.', 422);
    expanded += decoded.byteLength;
    if (expanded > 32 * 1024 * 1024) throw new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', 'Expanded source bundle exceeds 32 MiB.', 413);
    files.set(file.name, new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  }
  const markdown = files.get('novel.md');
  if (markdown === undefined) throw new DocumentError('DOCUMENT_IMPORT_MANUSCRIPT_REQUIRED', 'A novel.md original is required.', 422);
  const codex = [];
  const convertedFiles = new Set(['novel.md']);
  for (const [name, content] of files) {
    const path = name.match(/^(characters|locations|lore|objects)\/([^/]+)\/entry\.md$/); if (!path) continue;
    const metadataText = files.get(`${path[1]}/${path[2]}/metadata.json`);
    if (!metadataText) throw new DocumentError('DOCUMENT_IMPORT_METADATA_REQUIRED', 'Each codex original requires its metadata JSON.', 422);
    convertedFiles.add(name); convertedFiles.add(`${path[1]}/${path[2]}/metadata.json`);
    const metadata = z.object({ id: z.string().optional(), attributes: z.object({ name: z.string().optional(), type: z.string().optional() }).passthrough().optional() }).passthrough().parse(JSON.parse(metadataText));
    const parsed = frontmatter(content);
    const type = String(parsed.attributes.type ?? metadata.attributes?.type ?? path[1].slice(0,-1)).toLowerCase();
    codex.push(codexEntrySchema.parse({ entryType: type === 'object' ? 'item' : type, entryName: parsed.attributes.name ?? metadata.attributes?.name ?? path[2], entryDescription: parsed.body, attributes: JSON.stringify({ imported: true, sourcePath: name, sourceId: metadata.id ?? null, metadata, frontmatter: parsed.attributes }) }));
  }
  const unconvertedFiles = [...files.keys()].filter((name) => !convertedFiles.has(name));
  return { manuscript: parseManuscript(markdown, fallbackTitle), codex, sourceFileNames: [...files.keys()], unconvertedFiles, markdown };
}
