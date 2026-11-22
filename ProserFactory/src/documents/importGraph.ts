import type { Prisma } from '@prisma/client';
import { canonicalDocument, paragraphsOf, type ProserDocument } from './model';
import type { BookLayoutSnapshot } from './scope-model';
import { validateDocument } from './validation';
import { extractDocumentLayoutStories } from './layoutStories';
import { DocumentError } from './errors';
import type { DocumentStyleDefinitions } from './style-model';

export interface ImportedStoryMapping { documentIndex: number; sceneId: number; kind: 'header' | 'footer'; storyId: string }
export interface RetainedDocxConversion {
  kind: string;
  documents: Array<{ document: ProserDocument }>;
  headerFooterStories?: Array<{ documentIndex: number; kind: 'header' | 'footer'; document: ProserDocument }>;
  styles?: DocumentStyleDefinitions;
}
/** Placeholder asset IDs become newly owned IDs on import. Their exact digest,
 * object identity and formatting remain part of the retained graph comparison. */
function normalized(document: ProserDocument) {
  const value = structuredClone(document);
  for (const block of value.blocks) if (block.type === 'image') block.assetId = 1;
  for (const paragraph of paragraphsOf(value, true)) for (const run of paragraph.runs) if (run.inlineImage) run.inlineImage.assetId = 1;
  return canonicalDocument(value);
}
/** Attest separated bodies and owned stories against immutable preview bytes.
 * A client cannot grant itself imported attribution by adding source metadata. */
export async function verifyImportedGraph(tx: Prisma.TransactionClient, bookId: number, conversion: RetainedDocxConversion, documents: Array<{ sceneId: number; document: ProserDocument }>, layout: BookLayoutSnapshot | undefined, mappings: ImportedStoryMapping[] = [], previousLayout?: BookLayoutSnapshot): Promise<Set<string>> {
  const invalid = () => new DocumentError('DOCUMENT_IMPORT_PROVENANCE_INVALID', 'Imported body, layout or review graph differs from its complete retained conversion.', 409);
  if (conversion.kind !== 'docx' || !Array.isArray(conversion.documents) || documents.length !== conversion.documents.length) throw invalid();
  const previousStyles = previousLayout?.styles ?? { text: {}, paragraph: {} };
  const retainedStyles = conversion.styles ?? { text: {}, paragraph: {} };
  for (const kind of ['text', 'paragraph', 'labels'] as const) for (const [id, value] of Object.entries(retainedStyles[kind] ?? {})) {
    const previous = previousStyles[kind]?.[id];
    if (previous !== undefined && canonicalDocument(previous) !== canonicalDocument(value)) throw invalid();
  }
  const expectedStyles: DocumentStyleDefinitions = { text: { ...previousStyles.text, ...retainedStyles.text }, paragraph: { ...previousStyles.paragraph, ...retainedStyles.paragraph }, ...(previousStyles.labels || retainedStyles.labels ? { labels: { ...previousStyles.labels, ...retainedStyles.labels } } : {}) };
  if (!layout || canonicalDocument(layout.styles) !== canonicalDocument(expectedStyles)) throw invalid();
  const mappingSlots = new Set<string>(); const storyIds = new Set<string>();
  for (const mapping of mappings) {
    const slot = `${mapping.documentIndex}:${mapping.kind}`;
    if (!Number.isSafeInteger(mapping.documentIndex) || mapping.documentIndex < 0 || mapping.documentIndex >= conversion.documents.length || mappingSlots.has(slot) || storyIds.has(mapping.storyId) || !documents.some((item) => item.sceneId === mapping.sceneId)) throw invalid();
    mappingSlots.add(slot); storyIds.add(mapping.storyId);
  }
  const retainedSlots = new Set<string>();
  for (const story of conversion.headerFooterStories ?? []) {
    const slot = `${story.documentIndex}:${story.kind}`;
    if (!Number.isSafeInteger(story.documentIndex) || story.documentIndex < 0 || story.documentIndex >= conversion.documents.length || retainedSlots.has(slot)) throw invalid();
    retainedSlots.add(slot); validateDocument(story.document);
  }
  const remaining = new Set(conversion.documents.map((_, index) => index)); const verifiedStoryIds = new Set<string>();
  for (const item of documents) {
    const scene = await tx.scene.findFirst({ where: { id: item.sceneId, chapter: { act: { bookId } } }, select: { chapterId: true } }); if (!scene) throw invalid();
    const candidate = normalized(validateDocument(item.document));
    let index: number | undefined;
    for (const available of remaining) {
      const expected = extractDocumentLayoutStories(validateDocument(conversion.documents[available].document), scene.chapterId);
      if (normalized(expected.document) === candidate) { index = available; break; }
    }
    if (index === undefined) throw invalid(); remaining.delete(index);
    const extracted = extractDocumentLayoutStories(validateDocument(conversion.documents[index].document), scene.chapterId);
    const expectedStories = new Map(extracted.stories.map((story) => [story.kind, story.document]));
    for (const story of conversion.headerFooterStories ?? []) if (story.documentIndex === index) expectedStories.set(story.kind, story.document);
    const selectedMappings = mappings.filter((mapping) => mapping.documentIndex === index);
    if (selectedMappings.length !== expectedStories.size || selectedMappings.some((mapping) => mapping.sceneId !== item.sceneId)) throw invalid();
    for (const [kind, document] of expectedStories) {
      const mapping = selectedMappings.find((mapping) => mapping.kind === kind);
      const actual = layout?.headerFooterStories?.find((story) => story.id === mapping?.storyId);
      if (!mapping || !actual || actual.owner !== 'chapter' || actual.chapterId !== scene.chapterId || actual.kind !== kind || normalized(validateDocument(actual.document)) !== normalized(validateDocument(document))) throw invalid();
      verifiedStoryIds.add(actual.id);
    }
    if (!layout || canonicalDocument(layout.chapters[String(scene.chapterId)]) !== canonicalDocument(extracted.document.layout)) throw invalid();
  }
  if (remaining.size || verifiedStoryIds.size !== mappings.length) throw invalid();
  return verifiedStoryIds;
}
