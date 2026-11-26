import type { ActRecord } from './api';
import { orderedSceneReferences } from '@hivemagnus/proser-contracts';
import { getDocumentManifest, getDocumentScope } from './document-api';

/** Metadata-only navigation; prose bodies are fetched by the active session. */
export async function getDocumentNavigation(
  bookId: string,
  signal?: AbortSignal,
): Promise<ActRecord[]> {
  const manifest = await getDocumentManifest(bookId, signal);
  const scope = await getDocumentScope(bookId, 'structure', signal);
  if (
    manifest.revisionId !== scope.bookRevisionId ||
    manifest.scopes?.structure.revisionId !== scope.revisionId ||
    manifest.scopes?.structure.contentHash !== scope.contentHash
  )
    throw new Error('The book changed while reading navigation. Reload its saved structure.');
  const references = new Map(
    orderedSceneReferences(manifest.scenes, scope.content).map((scene) => [scene.sceneId, scene]),
  );
  return scope.content.acts
    .filter((act) => !act.deletedAt)
    .sort((a, b) => a.actNumber - b.actNumber)
    .map((act) => ({
      id: String(act.id),
      bookId,
      actNumber: act.actNumber,
      title: act.title,
      summary: act.summary,
      chapters: scope.content.chapters
        .filter((chapter) => chapter.actId === act.id && !chapter.deletedAt)
        .sort((a, b) => a.chapterNumber - b.chapterNumber)
        .map((chapter) => ({
          id: String(chapter.id),
          actId: String(act.id),
          chapterNumber: chapter.chapterNumber,
          title: chapter.title,
          summary: chapter.summary,
          scenes: scope.content.scenes
            .filter((scene) => scene.chapterId === chapter.id && !scene.deletedAt)
            .sort((a, b) => a.sceneNumber - b.sceneNumber)
            .map((scene) => ({
              id: String(scene.id),
              chapterId: String(chapter.id),
              sceneNumber: scene.sceneNumber,
              summary: scene.summary,
              outline: scene.outline,
              wordCount: references.get(scene.id)?.wordCount ?? 0,
            })),
        })),
    }));
}
