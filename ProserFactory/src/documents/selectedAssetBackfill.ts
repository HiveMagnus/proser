import {withReleaseRecovery} from '@/operations/releaseAdmission';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { documentService } from './service';
import { documentAuthorityEnabled } from './capabilities';
import { DocumentError } from './errors';
import { inspectImageMetadata } from '@/lib/imageMetadata';

/** Pre-activation registration only. Preserve the exact previous metadata in
 * an append-only audit before adding facts verified from already-owned bytes. */
export async function backfillSelectedArtwork(userId: number, bookId: number, apply = false) {
  if (apply && documentAuthorityEnabled()) throw new DocumentError('DOCUMENT_ASSET_BACKFILL_ACTIVATED', 'Legacy artwork registration is only permitted before document authority activation.', 409);
  if(apply)return documentService.registerSelectedArtworkForRelease(userId,bookId);
  return withReleaseRecovery(()=>documentService.sideRecord(userId,bookId,tx=>registerSelectedArtworkEvidence(tx,userId,bookId,false)));
}
/** Fixed local registration behavior; no arbitrary catalog/body callback. */
export async function registerSelectedArtworkEvidence(tx:Prisma.TransactionClient,userId:number,bookId:number,apply:boolean){
    if(apply&&documentAuthorityEnabled())throw new DocumentError('DOCUMENT_ASSET_BACKFILL_ACTIVATED','Legacy artwork registration is only permitted before document authority activation.',409);
    const installed = await tx.$queryRaw<Array<{ installed: boolean }>>`SELECT to_regclass('proser_document_enforcement') IS NOT NULL AS installed`;
    if (apply && installed[0]?.installed) {
      const state = await tx.$queryRaw<Array<{ enabled: boolean }>>`SELECT enabled FROM proser_document_enforcement WHERE singleton`;
      if (state[0]?.enabled) throw new DocumentError('DOCUMENT_ASSET_BACKFILL_ACTIVATED', 'Reviewed database enforcement is already active.', 409);
    }
    const rows = await tx.$queryRaw<Array<{ id: number }>>`SELECT DISTINCT selected_image_id AS id FROM (SELECT selected_image_id FROM books WHERE id=${bookId} UNION ALL SELECT selected_image_id FROM acts WHERE book_id=${bookId} UNION ALL SELECT c.selected_image_id FROM chapters c JOIN acts a ON a.id=c.act_id WHERE a.book_id=${bookId} UNION ALL SELECT s.selected_image_id FROM scenes s JOIN chapters c ON c.id=s.chapter_id JOIN acts a ON a.id=c.act_id WHERE a.book_id=${bookId}) selected WHERE selected_image_id<>0 ORDER BY id`;
    const prepared = [];
    for (const { id } of rows) {
      const asset = await tx.imageAsset.findFirst({ where: { id, bookId, userId } });
      if (!asset || !/^\/images\/[a-zA-Z0-9_.-]+$/.test(asset.url) || Buffer.byteLength(asset.configJson ?? '') > 256 * 1024) throw new DocumentError('DOCUMENT_SELECTED_ASSET_UNVERIFIED', 'Legacy artwork must be owned and stored as a bounded local image.', 409, { assetId: id });
      const filename = path.resolve('public/images', path.basename(asset.url));
      const info = await lstat(filename).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 32 * 1024 * 1024) throw new DocumentError('DOCUMENT_SELECTED_ASSET_UNVERIFIED', 'Legacy artwork bytes are unavailable or unsafe.', 409, { assetId: id });
      const bytes = await readFile(filename);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      let old: Record<string, unknown>;
      try { old = JSON.parse(asset.configJson ?? '{}') as Record<string, unknown>; if (!old || Array.isArray(old) || typeof old !== 'object') throw new Error('Invalid metadata'); } catch { throw new DocumentError('DOCUMENT_SELECTED_ASSET_UNVERIFIED', 'Legacy artwork metadata is malformed and needs explicit reconciliation.', 409, { assetId: id }); }
      if (old.sha256 !== undefined && old.sha256 !== sha256) throw new DocumentError('DOCUMENT_SELECTED_ASSET_INVALID', 'Legacy artwork differs from its previously registered digest.', 409, { assetId: id });
      let verified: ReturnType<typeof inspectImageMetadata>;
      try { verified = inspectImageMetadata(bytes); } catch { throw new DocumentError('DOCUMENT_SELECTED_ASSET_UNVERIFIED', 'Legacy artwork dimensions or bytes are unsupported.', 409, { assetId: id }); }
      const changed = Object.entries(verified).some(([key, value]) => old[key] !== value);
      prepared.push({ assetId: id, changed, sha256, byteLength: bytes.length, oldConfigJson: asset.configJson, newConfigJson: JSON.stringify({ ...old, ...verified }) });
    }
    if (apply) for (const item of prepared.filter((item) => item.changed)) {
      await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: JSON.parse(JSON.stringify({ action: 'backfill-selected-artwork-registration', ...item })) as Prisma.InputJsonValue } });
      await tx.imageAsset.update({ where: { id: item.assetId }, data: { configJson: item.newConfigJson } });
    }
    return { schemaVersion: 1 as const, mode: apply ? 'apply' : 'preview', bookId, examined: prepared.length, changed: prepared.filter((item) => item.changed).length, assets: prepared.map(({ oldConfigJson: _old, newConfigJson: _new, ...item }) => item) };

}
