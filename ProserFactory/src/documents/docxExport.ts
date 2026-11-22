import { exportDocx, WordCodecError, type DocxAsset, type ExportMode } from '@hivemagnus/canvas-word-codec';
import { type ProserDocument } from './model';
import { wordExchangeDocument } from './wordExchange';
import { DocumentError } from './errors';
export type { DocxAsset, ExportMode } from '@hivemagnus/canvas-word-codec';
/** Proser validates canonical authority; the maintained MIT codec handles bytes only. */
export async function exportStructuredDocx(raw: ProserDocument, mode: ExportMode, assets: Map<number, DocxAsset> = new Map()): Promise<Buffer> {
  const document = wordExchangeDocument(raw);
  try { return await exportDocx(document, mode, assets); }
  catch (error) { if (error instanceof WordCodecError) throw new DocumentError(error.code, error.message, error.status, error.details); throw error; }
}
