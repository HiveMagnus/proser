import type { ProserDocument } from './model';
import type { DocumentStyleDefinitions } from './style-model';
import type { DocumentPassageSourceFrame } from './passage-model';
import type { DocumentPassageOperation } from './passage-operations-model';
import { applyPassageOperations } from './passageOperations';
import { operationSourceHash } from './passageOperationSources';
import { DocumentError } from './errors';

/** Unsaved context is reproduced from the owned immutable scene and bounded
 * qualified intentions. Never trust a browser-created complete document here.
 * The same operation UUID produces the same stable descendant IDs when flushed. */
export function deriveDiscussionDraft(
  source: ProserDocument,
  local: { operationId: string; operations: DocumentPassageOperation[] },
  context: { sourceFrame: DocumentPassageSourceFrame; styles: DocumentStyleDefinitions },
  userId: number,
): ProserDocument {
  if (Buffer.byteLength(JSON.stringify(local)) > 256 * 1024) throw new DocumentError('DOCUMENT_DRAFT_TOO_LARGE', 'Unsaved context intents exceed 256 KiB. Save or reduce the draft first.', 413);
  if (local.operations.some((operation) => !['text', 'run-format', 'paragraph-format'].includes(operation.kind))) throw new DocumentError('DOCUMENT_DRAFT_REQUIRES_SAVE', 'Save paragraph structure, protected objects and review changes before preparing context.', 409);
  const runs = local.operations.flatMap((operation) => operation.kind === 'text' || operation.kind === 'run-format' ? [operation.target] : []);
  const paragraphIds = local.operations.flatMap((operation) => operation.kind === 'paragraph-format' ? [operation.target.blockId] : []);
  const result = applyPassageOperations(source, local.operations, {
    operationId: local.operationId, sourceFrame: context.sourceFrame, styles: context.styles,
    actor: { id: userId, name: String(userId), createdAt: '2000-01-01T00:00:00.000Z', origin: 'manual' },
    tracking: false, window: { runs, paragraphIds },
  });
  // Extending even an owned pending insertion changes its durable review record.
  // That requires an acknowledged save rather than an invisible context mutation.
  if (operationSourceHash(result.document.changes) !== operationSourceHash(source.changes) || operationSourceHash(result.document.comments) !== operationSourceHash(source.comments)) throw new DocumentError('DOCUMENT_DRAFT_REQUIRES_SAVE', 'Save review changes before preparing unsaved context.', 409);
  return result.document;
}

/** Compatibility snapshots may change text and supported styles only. Keep
 * every owned paragraph/run/container identity and review/object/layout field;
 * new structures and detached IDs must first receive a durable save. */
export function assertLegacyDiscussionDraft(source: ProserDocument, draft: ProserDocument): void {
  const shape = (document: ProserDocument) => ({
    ...document,
    blocks: document.blocks.map((block) => {
      const paragraph = (item: import('./model').DocumentParagraph) => {
        const { style: _style, runs, ...metadata } = item;
        return { ...metadata, runs: runs.map(({ text: _text, style: _runStyle, ...run }) => run) };
      };
      if (block.type === 'paragraph') return paragraph(block);
      if (block.type === 'table') return { ...block, rows: block.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => ({ ...cell, paragraphs: cell.paragraphs.map(paragraph) })) })) };
      return block;
    }),
  });
  if (operationSourceHash(shape(source)) !== operationSourceHash(shape(draft))) throw new DocumentError('DOCUMENT_DRAFT_REQUIRES_SAVE', 'Save new identities, structures, layout, protected objects and review changes before preparing unsaved context.', 409);
}
