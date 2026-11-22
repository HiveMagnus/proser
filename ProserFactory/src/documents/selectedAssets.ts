import type { Prisma, PrismaClient } from '@prisma/client';
import type { SelectedImageReference, StructureSnapshot } from './scope-model';
import { DocumentError } from './errors';
import { canonicalDocument } from './model';
import { inspectImageMetadata } from '@/lib/imageMetadata';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

type Selection = { selectedImageId: number; selectedImageAsset?: SelectedImageReference };
export const structureSelections = (structure: StructureSnapshot): Selection[] => [structure.book, ...structure.acts, ...structure.chapters, ...structure.scenes];

/** Capture registered immutable bytes, never a guessed public URL or mutable
 * asset ID alone. Legacy unverified artwork must be reconciled before activation. */
export async function captureSelectedAssets(tx: Prisma.TransactionClient, bookId: number, structure: StructureSnapshot) {
  const selections = structureSelections(structure);
  const ids = [...new Set(selections.map((item) => item.selectedImageId).filter((id) => id !== 0))];
  if (!ids.length) return;
  const book = await tx.book.findUniqueOrThrow({ where: { id: bookId, deletedAt: {} }, select: { userId: true } });
  const assets = await tx.imageAsset.findMany({ where: { id: { in: ids }, bookId, userId: book.userId } });
  const references = new Map<number, SelectedImageReference>();
  for (const asset of assets) {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(asset.configJson ?? '{}') as Record<string, unknown>; } catch { /* Unverified is explicit. */ }
    if (typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !['image/png', 'image/jpeg', 'image/webp'].includes(String(metadata.mediaType)) || !Number.isSafeInteger(metadata.byteLength) || Number(metadata.byteLength) < 1 || Number(metadata.byteLength) > 32 * 1024 * 1024) continue;
    references.set(asset.id, { assetId: asset.id, sha256: metadata.sha256, mediaType: String(metadata.mediaType), byteLength: Number(metadata.byteLength), alt: asset.name, ...(Number.isSafeInteger(metadata.width) && Number(metadata.width) > 0 ? { width: Number(metadata.width) } : {}), ...(Number.isSafeInteger(metadata.height) && Number(metadata.height) > 0 ? { height: Number(metadata.height) } : {}) });
  }
  for (const selection of selections) {
    if (!selection.selectedImageId) { delete selection.selectedImageAsset; continue; }
    const reference = references.get(selection.selectedImageId);
    if (!reference) throw new DocumentError('DOCUMENT_SELECTED_ASSET_UNVERIFIED', 'Selected artwork requires an owned immutable image registration before structured authority can preserve it.', 409, { assetId: selection.selectedImageId });
    selection.selectedImageAsset = { ...reference };
  }
}

/** Compare historical byte references to current registrations. Missing legacy
 * references cannot authorize restoration of selected artwork. */
export async function validateSelectedAssets(tx: Prisma.TransactionClient, bookId: number, structure: StructureSnapshot, previous?: StructureSnapshot) {
  const captured = structuredClone(structure);
  await captureSelectedAssets(tx, bookId, captured);
  const expected = structureSelections(structure); const actual = structureSelections(captured);
  for (let index = 0; index < expected.length; index++) {
    if (!expected[index].selectedImageId && !expected[index].selectedImageAsset) continue;
    const old = expected[index].selectedImageAsset; const current = actual[index].selectedImageAsset;
    if (old && current) { if (old.width === undefined) delete current.width; if (old.height === undefined) delete current.height; }
    if (!old || canonicalDocument(old) !== canonicalDocument(current)) throw new DocumentError('DOCUMENT_SELECTED_ASSET_INVALID', 'Selected artwork differs from its immutable revision or lacks complete historical evidence.', 409, { assetId: expected[index].selectedImageId });
  }
  const verifiedBefore = new Set(previous ? structureSelections(previous).flatMap((selection) => selection.selectedImageAsset ? [canonicalDocument(selection.selectedImageAsset)] : []) : []);
  const verified = new Set<number>();
  for (const selection of expected) {
    const reference = selection.selectedImageAsset;
    if (!reference || verified.has(reference.assetId) || verifiedBefore.has(canonicalDocument(reference))) continue;
    const asset = await tx.imageAsset.findFirst({ where: { id: reference.assetId, bookId } });
    if (!asset || !/^\/images\/[a-zA-Z0-9_.-]+$/.test(asset.url)) throw new DocumentError('DOCUMENT_SELECTED_ASSET_INVALID', 'Selected artwork requires bounded local immutable bytes.', 409);
    const filename = path.resolve('public/images', path.basename(asset.url));
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== reference.byteLength || info.size > 32 * 1024 * 1024) throw new Error('Invalid file');
      const bytes = await readFile(filename);
      const inspected = inspectImageMetadata(bytes);
      if (bytes.length !== reference.byteLength || inspected.sha256 !== reference.sha256 || inspected.mediaType !== reference.mediaType || reference.width !== undefined && inspected.width !== reference.width || reference.height !== undefined && inspected.height !== reference.height) throw new Error('Invalid immutable image facts');
    } catch { throw new DocumentError('DOCUMENT_SELECTED_ASSET_INVALID', 'Selected artwork bytes are unavailable or differ from their immutable digest.', 409, { assetId: reference.assetId }); }
    verified.add(reference.assetId);
  }
}

/** Existing immutable catalogs remain unchanged. Adding digest evidence to the
 * next structure revision is an explicit upgrade, rather than historical rewrite. */
export function comparableStructure(current: StructureSnapshot, previous: StructureSnapshot) {
  const comparable = structuredClone(current);
  const omitLegacy = (item: Selection, old: Selection | undefined) => {
    if (!old || old.selectedImageId !== item.selectedImageId) return;
    if (!old.selectedImageAsset) delete item.selectedImageAsset;
    else if (item.selectedImageAsset) { if (old.selectedImageAsset.width === undefined) delete item.selectedImageAsset.width; if (old.selectedImageAsset.height === undefined) delete item.selectedImageAsset.height; }
  };
  omitLegacy(comparable.book, previous.book);
  for (const kind of ['acts', 'chapters', 'scenes'] as const) for (const item of comparable[kind]) omitLegacy(item, previous[kind].find((old) => old.id === item.id));
  return comparable;
}

/** Active heads need complete selected-artwork evidence. Historical unverified
 * selections remain preserved but cannot authorize complete restoration. */
export async function selectedArtworkReadiness(tx: Prisma.TransactionClient | PrismaClient) {
  const rows = await tx.$queryRaw<Array<{ missing: bigint }>>`SELECT count(*) AS missing FROM book_document_heads h JOIN books b ON b.id=h.book_id JOIN book_document_scope_revisions s ON s.id=h.manifest->'scopes'->'structure'->>'revisionId' AND s.book_id=h.book_id AND s.kind='structure' CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(s.content->'book') || coalesce(s.content->'acts','[]'::jsonb) || coalesce(s.content->'chapters','[]'::jsonb) || coalesce(s.content->'scenes','[]'::jsonb)) selection WHERE b.deleted_at IS NULL AND coalesce((selection->>'selectedImageId')::integer,0)<>0 AND NOT EXISTS(SELECT 1 FROM images i WHERE i.id=(selection->>'selectedImageId')::integer AND i.book_id=h.book_id AND i.user_id=b.user_id AND i.id=(selection->'selectedImageAsset'->>'assetId')::integer AND i.config_json::jsonb->>'sha256'=selection->'selectedImageAsset'->>'sha256' AND i.config_json::jsonb->>'mediaType'=selection->'selectedImageAsset'->>'mediaType' AND i.config_json::jsonb->>'byteLength'=selection->'selectedImageAsset'->>'byteLength')`;
  return Number(rows[0]?.missing ?? 1) === 0;
}
