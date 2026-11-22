import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { databaseService } from '@/lib/database';
import { documentAuthorityEnabled } from './capabilities';
import { searchIndexReadiness } from './searchIndex';
import { selectedArtworkReadiness } from './selectedAssets';

export interface DocumentRuntimeReadiness {
  documentSchema: 'ready' | 'disabled' | 'unavailable';
  documentEnforcement: 'ready' | 'disabled' | 'unavailable';
  documentSearchIndex: 'ready' | 'disabled' | 'unavailable';
  documentSelectedAssets: 'ready' | 'disabled' | 'unavailable';
  assetStorage: 'ready' | 'disabled' | 'unavailable';
  artifactStorage: 'ready' | 'disabled' | 'unavailable';
  publicationRenderer: 'ready' | 'disabled' | 'unavailable';
  publicationFonts: 'ready' | 'disabled' | 'unavailable';
}
export async function verifyPublicationFonts(filename = process.env.PUBLICATION_FONT_MANIFEST): Promise<Array<{ name: string; version: string; path: string; sha256: string; licensePath: string }>> {
  if (!filename || !path.isAbsolute(filename) || (await stat(filename)).size > 64 * 1024) throw new Error('A bounded installed font manifest is required.');
  const manifest = JSON.parse(await readFile(filename, 'utf8')) as { schemaVersion: number; fonts: Array<{ name: string; version: string; path: string; sha256: string; licensePath: string }> };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.fonts) || !manifest.fonts.length || manifest.fonts.length > 100) throw new Error('Invalid font manifest.');
  for (const font of manifest.fonts) {
    if (!font.name || !font.version || !path.isAbsolute(font.path) || !path.isAbsolute(font.licensePath) || !/^[a-f0-9]{64}$/.test(font.sha256) || (await stat(font.path)).size > 32 * 1024 * 1024 || (await stat(font.licensePath)).size > 1024 * 1024) throw new Error('Invalid font reference.');
    const bytes = await readFile(font.path);
    if (createHash('sha256').update(bytes).digest('hex') !== font.sha256 || !(await readFile(font.licensePath,'utf8')).trim()) throw new Error('Font digest or license is unavailable.');
  }
  return manifest.fonts;
}
let cached: { until: number; signature: string; value: DocumentRuntimeReadiness } | undefined;
let checking: Promise<DocumentRuntimeReadiness> | undefined;
export async function documentRuntimeReadiness(): Promise<DocumentRuntimeReadiness> {
  const disabled = Object.fromEntries(['documentSchema','documentEnforcement','documentSearchIndex','documentSelectedAssets','assetStorage','artifactStorage','publicationRenderer','publicationFonts'].map((key) => [key,'disabled'])) as unknown as DocumentRuntimeReadiness;
  if (!documentAuthorityEnabled()) return disabled;
  const signature = `${process.env.DATABASE_URL}|${process.env.PUBLICATION_FONT_MANIFEST}|${process.cwd()}`;
  if (cached && cached.until > Date.now() && cached.signature === signature) return cached.value;
  if (checking) return checking;
  checking = (async () => {
    const value = Object.fromEntries(Object.keys(disabled).map((key) => [key,'unavailable'])) as unknown as DocumentRuntimeReadiness;
    await Promise.allSettled([
      (async () => {
        const rows = await databaseService.client.$queryRaw<Array<{ schema: boolean; artifacts: boolean; enforcement: boolean }>>`SELECT
          NOT EXISTS (SELECT 1 FROM unnest(ARRAY['scene_document_revisions','book_document_heads','book_document_revisions','book_document_scope_revisions','document_operations','document_originals','document_discussions','document_proposals','document_proposal_validations','document_story_discussions','document_story_proposals','document_story_proposal_validations','document_trace_analyses','document_trace_targets','document_compare_validations','document_import_originals','document_import_previews','document_workflow_effects','document_operator_effects','document_inference_operations','document_publications','document_publication_artifacts','scene_document_search_indexes','release_admission_fence','release_mutation_admissions','release_admission_bindings']) AS required(name) WHERE to_regclass(required.name) IS NULL) AS schema,
          to_regclass('document_publication_artifacts') IS NOT NULL AND has_table_privilege(current_user, 'document_publication_artifacts', 'SELECT') AND has_table_privilege(current_user, 'document_publication_artifacts', 'INSERT') AS artifacts,
          to_regclass('proser_document_enforcement') IS NOT NULL AS enforcement`;
        if (rows[0]?.schema) {
          const invalid = await databaseService.client.sceneDocumentRevision.count({ where: { schemaVersion: { not: 1 } } });
          const missing = await databaseService.client.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM books b LEFT JOIN book_document_heads h ON b.id = h.book_id WHERE b.deleted_at IS NULL AND h.book_id IS NULL`;
          if (!invalid && Number(missing[0]?.count) === 0) value.documentSchema = 'ready';
        }
        if (rows[0]?.artifacts) value.artifactStorage = 'ready';
        if (rows[0]?.enforcement) {
          const activation = await databaseService.client.$queryRaw<Array<{ enabled: boolean; candidate_sha: string; rehearsal_sha256: string }>>`SELECT enabled, candidate_sha, rehearsal_sha256 FROM proser_document_enforcement WHERE singleton`;
          if (activation[0]?.enabled && /^[a-f0-9]{40}$/.test(activation[0].candidate_sha) && /^[a-f0-9]{64}$/.test(activation[0].rehearsal_sha256)) value.documentEnforcement = 'ready';
        }
      })(),
      (async () => { if (await searchIndexReadiness(databaseService.client)) value.documentSearchIndex = 'ready'; })(),
      (async () => { if (await selectedArtworkReadiness(databaseService.client)) value.documentSelectedAssets = 'ready'; })(),
      (async () => {
        const filename = path.resolve('public/images',`.document-readiness-${randomUUID()}`); const bytes = Buffer.from(randomUUID());
        try { await writeFile(filename,bytes,{ flag: 'wx', mode: 0o600 }); if (!(await readFile(filename)).equals(bytes)) throw new Error('Storage probe mismatch.'); value.assetStorage = 'ready'; }
        finally { await unlink(filename).catch(() => undefined); }
      })(),
      (async () => { await verifyPublicationFonts(); value.publicationFonts = 'ready'; })(),
      (async () => { const browser = await chromium.launch({ headless: true, timeout: 5000 }); try { if (!browser.version()) throw new Error('Renderer version unavailable.'); value.publicationRenderer = 'ready'; } finally { await browser.close(); } })(),
    ]);
    cached = { until: Date.now() + 30000, signature, value }; return value;
  })();
  try { return await checking; } finally { checking = undefined; }
}
