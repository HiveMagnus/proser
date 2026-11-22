import { databaseService } from '@/lib/database';

import type { EditorialScopeType } from './contracts';

export interface EditorialSceneScope {
  id: number;
  chapterId: number;
  sceneNumber: number;
  outline: string | null;
  summary: string | null;
  prose: string;
}

export async function loadEditorialScope(input: {
  userId: number;
  bookId: number;
  scope: { type: EditorialScopeType; id?: number };
}): Promise<{ scenes: EditorialSceneScope[]; scopeMap: Record<string, unknown> }> {
  const book = await databaseService.client.book.findFirst({
    where: { id: input.bookId, userId: input.userId, deletedAt: null },
    include: {
      acts: {
        orderBy: { actNumber: 'asc' },
        include: {
          chapters: {
            orderBy: { chapterNumber: 'asc' },
            include: { scenes: { where: { deletedAt: null }, orderBy: { sceneNumber: 'asc' } } },
          },
        },
      },
    },
  });
  if (!book) throw new Error(`Book ${input.bookId} not found`);
  const all = book.acts.flatMap((act) => act.chapters.flatMap((chapter) =>
    chapter.scenes.map((scene) => ({
      id: scene.id,
      chapterId: scene.chapterId,
      sceneNumber: scene.sceneNumber,
      outline: scene.outline,
      summary: scene.summary,
      prose: scene.prose ?? '',
      actId: act.id,
      chapterNumber: chapter.chapterNumber,
      actNumber: act.actNumber,
    }))));
  const selected = input.scope.type === 'book' ? all
    : input.scope.type === 'act' ? all.filter((scene) => scene.actId === input.scope.id)
      : input.scope.type === 'chapter' ? all.filter((scene) => scene.chapterId === input.scope.id)
        : all.filter((scene) => scene.id === input.scope.id);
  if (!selected.length) throw new Error('EDITORIAL_SCOPE_INVALID');
  return {
    scenes: selected.map(({ actId: _actId, chapterNumber: _chapterNumber, actNumber: _actNumber, ...scene }) => scene),
    scopeMap: {
      scope: input.scope,
      sceneCount: selected.length,
      sceneIds: selected.map((scene) => scene.id),
      chapterIds: [...new Set(selected.map((scene) => scene.chapterId))],
      actIds: [...new Set(selected.map((scene) => scene.actId))],
    },
  };
}
