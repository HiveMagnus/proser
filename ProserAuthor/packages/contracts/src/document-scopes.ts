// Generated from Factory documents/scope-model.ts; edit Factory and run npm run documents:sync.
import type { DocumentStyleDefinitions } from './document-styles.js';
import type {
  DocumentLayout,
  ProserDocument,
  DocumentManifest,
  SceneDocumentReference,
} from './document-model.js';
export type DocumentScopeKind = 'structure' | 'canon' | 'layout';
export interface ScopeReference {
  revisionId: string;
  contentHash: string;
}
export type DocumentScopeReferences = Record<DocumentScopeKind, ScopeReference>;
/** Preconditions captured at the read/inference boundary, never at save time. */
export interface DocumentMutationPreconditions {
  operationId: string;
  expectedRevisionId: string;
  expectedScopes: Partial<Record<DocumentScopeKind, string>>;
  expectedSceneRevisionId?: string;
}
/** Exact owned selected artwork, retained independently of mutable image names. */
export interface SelectedImageReference {
  assetId: number;
  sha256: string;
  mediaType: string;
  byteLength: number;
  alt: string;
  width?: number;
  height?: number;
}
export interface StructureBookMetadata {
  selectedImageAsset?: SelectedImageReference;
  deletedAt?: string | null;
  title: string | null;
  summary: string | null;
  genre: string | null;
  targetAudience: string | null;
  draftStatus: string | null;
  tagline: string | null;
  storyOutline: string | null;
  storyArchetypeKey: string | null;
  selectedImageId: number;
}
export interface StructureAct {
  selectedImageAsset?: SelectedImageReference;
  id: number;
  actNumber: number;
  title: string | null;
  summary: string | null;
  selectedImageId: number;
  deletedAt: string | null;
  createdAt: string | null;
}
export interface StructureChapter {
  selectedImageAsset?: SelectedImageReference;
  id: number;
  actId: number;
  chapterNumber: number;
  title: string | null;
  summary: string | null;
  selectedImageId: number;
  deletedAt: string | null;
  createdAt: string | null;
}
export type DocumentJson =
  null | boolean | number | string | DocumentJson[] | { [key: string]: DocumentJson };
export interface StructureScene {
  selectedImageAsset?: SelectedImageReference;
  id: number;
  chapterId: number;
  sceneNumber: number;
  summary: string | null;
  outline: string | null;
  beatsMeta: DocumentJson;
  beatsMetaIsSqlNull: boolean;
  selectedImageId: number;
  deletedAt: string | null;
  createdAt: string | null;
}
export interface StructureSnapshot {
  schemaVersion: 1;
  book: StructureBookMetadata;
  acts: StructureAct[];
  chapters: StructureChapter[];
  scenes: StructureScene[];
}
export interface CanonEntry {
  id: number;
  entryType: string;
  entryName: string;
  entryDescription: string | null;
  attributes: string | null;
  deletedAt: string | null;
  createdAt: string | null;
}
export interface CanonSnapshot {
  schemaVersion: 1;
  entries: CanonEntry[];
  usages: Array<{
    id: number;
    sceneId: number;
    codexId: number;
    usedAt: string | null;
    rationale: string | null;
    deletedAt: string | null;
  }>;
}
export interface HeaderFooterStory {
  id: string;
  owner: 'book' | 'chapter';
  chapterId?: number;
  kind: 'header' | 'footer';
  document: ProserDocument;
}
export interface BookLayoutSnapshot {
  schemaVersion: 1;
  book: DocumentLayout;
  chapters: Record<string, DocumentLayout>;
  headerFooterStories?: HeaderFooterStory[];
  frontMatter: Array<{ id: string; name: string; document: ProserDocument }>;
  backMatter: Array<{ id: string; name: string; document: ProserDocument }>;
  styles: DocumentStyleDefinitions;
}
export interface BookScopeContents {
  structure: StructureSnapshot;
  canon: CanonSnapshot;
  layout: BookLayoutSnapshot;
}
export interface DocumentLayoutCommitInput {
  /** Exact owned immutable layout restoration for the operation journal. */
  restoreFromRevisionId?: string;
  schemaVersion: 1;
  operationId: string;
  expectedRevisionId: string;
  expectedScopes: { layout: string };
  layout: BookLayoutSnapshot;
}
export interface DocumentLayoutCommitReceipt {
  kind: 'catalog';
  operationId: string;
  revisionId: string;
  contentHash: string;
  status: 'completed';
  manifest: DocumentManifest;
  result: { changedScope: 'layout'; restoredFromLayoutRevisionId?: string };
}
export interface DocumentLayoutRevisionResponse {
  revisionId: string;
  contentHash: string;
  content: BookLayoutSnapshot;
}
export interface DocumentQuickDraftInput {
  schemaVersion: 1;
  operationId: string;
  expectedRevisionId: string;
  expectedScopes: { structure: string };
  summary: string;
  outline: string;
}
export interface DocumentQuickDraftReceipt {
  kind: 'catalog';
  operationId: string;
  revisionId: string;
  contentHash: string;
  status: 'completed';
  manifest: DocumentManifest;
  result: { command: 'quick-draft'; actId: number; chapterId: number; sceneId: number };
}
export interface DocumentCreatedBookReceipt {
  operationId: string;
  bookId: number;
  title: string | null;
  revisionId: string;
  status: 'completed';
}
/** Ordered navigation is derived from immutable structure, never insertion IDs.
 * The returned references retain their content/revision identities unchanged. */
export function orderedSceneReferences(
  references: SceneDocumentReference[],
  structure: StructureSnapshot,
): SceneDocumentReference[] {
  const acts = new Map(structure.acts.map((act) => [act.id, act]));
  const chapters = new Map(structure.chapters.map((chapter) => [chapter.id, chapter]));
  const scenes = new Map(structure.scenes.map((scene) => [scene.id, scene]));
  if (
    new Set(references.map((reference) => reference.sceneId)).size !== references.length ||
    references.length !== scenes.size
  )
    throw new Error('Scene references do not cover the canonical structure exactly once.');
  for (const reference of references) {
    const scene = scenes.get(reference.sceneId);
    const chapter = chapters.get(reference.chapterId);
    if (
      !scene ||
      !chapter ||
      !acts.has(chapter.actId) ||
      scene.chapterId !== reference.chapterId ||
      scene.sceneNumber !== reference.sceneNumber ||
      (reference.deletedAt ?? null) !== scene.deletedAt
    )
      throw new Error('Scene references disagree with the canonical book structure.');
  }
  return [...references].sort((left, right) => {
    const leftChapter = chapters.get(left.chapterId)!;
    const rightChapter = chapters.get(right.chapterId)!;
    const leftAct = acts.get(leftChapter.actId)!;
    const rightAct = acts.get(rightChapter.actId)!;
    return (
      leftAct.actNumber - rightAct.actNumber ||
      leftAct.id - rightAct.id ||
      leftChapter.chapterNumber - rightChapter.chapterNumber ||
      leftChapter.id - rightChapter.id ||
      left.sceneNumber - right.sceneNumber ||
      left.sceneId - right.sceneId
    );
  });
}
