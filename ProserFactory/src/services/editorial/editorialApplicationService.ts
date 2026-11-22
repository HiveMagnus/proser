import { databaseService } from '@/lib/database';
import { documentAuthorityEnabled } from '@/documents/service';
import { manuscriptRevisionService } from '@/services/manuscriptRevisionService';

import { resolveAnchor, textHash } from './textAnchors';
import { applyPatch } from './textDiff';
import { verifyCandidate, type VerificationResult } from './editorialVerificationService';

export interface EditorialPatch {
  sceneId: number;
  originalText: string;
  candidateText: string;
  sourceHash: string;
  startOffset: number;
  endOffset: number;
  beforeAnchor?: string | null;
  afterAnchor?: string | null;
  protectedElements?: string[];
  references?: string[];
  maxChangedPercent: number;
  allowNewNames?: boolean;
}

export type AppliedPatchVerification = {
  patchIndex: number;
  sceneId: number;
  result: VerificationResult;
};

export class EditorialPatchVerificationError extends Error {
  constructor(readonly verification: AppliedPatchVerification[]) {
    super('EDITORIAL_PROPOSAL_NOT_APPLICABLE');
    this.name = 'EditorialPatchVerificationError';
  }
}

export async function applyEditorialPatches(input: {
  userId: number;
  bookId: number;
  expectedRevisionId: string;
  workflowRunId?: string;
  patches: EditorialPatch[];
}): Promise<{ revisionId: string; verification: AppliedPatchVerification[] }> {
  const book = await databaseService.client.book.findFirst({ where: { id: input.bookId, userId: input.userId, deletedAt: null }, select: { id: true } });
  if (!book) throw new Error(`Book ${input.bookId} not found`);
  const sceneIds = [...new Set(input.patches.map((patch) => patch.sceneId))];
  const scenes = await databaseService.client.scene.findMany({
    where: { id: { in: sceneIds }, chapter: { act: { bookId: input.bookId } }, deletedAt: null },
    select: { id: true, prose: true },
  });
  if (scenes.length !== sceneIds.length) throw new Error('EDITORIAL_SCOPE_INVALID');
  const sourceScenes = documentAuthorityEnabled() ? (await manuscriptRevisionService.snapshotRevision(input.bookId, input.expectedRevisionId)).scenes : scenes;
  const byScene = new Map(sourceScenes.map((scene) => [scene.id, scene.prose ?? '']));
  const verification: Array<{ patchIndex: number; sceneId: number; result: VerificationResult }> = [];
  const grouped = new Map<number, Array<{ patch: EditorialPatch; patchIndex: number }>>();
  for (const [patchIndex, patch] of input.patches.entries()) {
    grouped.set(patch.sceneId, [...(grouped.get(patch.sceneId) ?? []), { patch, patchIndex }]);
  }
  const revisions: Array<{ sceneId: number; expectedProse: string; revisedProse: string }> = [];
  for (const [sceneId, patches] of grouped) {
    const originalScene = byScene.get(sceneId)!;
    let revisedScene = originalScene;
    for (const { patch, patchIndex } of [...patches].sort((left, right) => right.patch.startOffset - left.patch.startOffset)) {
      const resolved = documentAuthorityEnabled() ? (originalScene.slice(patch.startOffset, patch.endOffset) === patch.originalText ? { start: patch.startOffset, end: patch.endOffset } : null) : resolveAnchor(originalScene, patch);
      if (!resolved || textHash(patch.originalText) !== patch.sourceHash) throw new Error('EDITORIAL_PROPOSAL_STALE');
      const result = verifyCandidate({
        original: patch.originalText,
        candidate: patch.candidateText,
        expectedSourceHash: patch.sourceHash,
        protectedElements: patch.protectedElements,
        references: patch.references,
        maxChangedPercent: patch.maxChangedPercent,
        allowNewNames: patch.allowNewNames,
      });
      verification.push({ patchIndex, sceneId, result });
      if (!result.passed) continue;
      revisedScene = applyPatch(revisedScene, resolved.start, resolved.end, patch.candidateText);
    }
    revisions.push({ sceneId, expectedProse: originalScene, revisedProse: revisedScene });
  }
  if (verification.some((item) => !item.result.passed)) {
    throw new EditorialPatchVerificationError(verification);
  }
  const revisionId = await manuscriptRevisionService.applyScenePatches({
    bookId: input.bookId,
    userId: input.userId,
    expectedRevisionId: input.expectedRevisionId,
    workflowRunId: input.workflowRunId,
    patches: revisions,
  });
  return { revisionId, verification };
}

export async function applySinglePassage(input: {
  userId: number;
  bookId: number;
  sceneId: number;
  expectedRevisionId: string;
  originalPassage: string;
  replacement: string;
  startOffset: number;
  endOffset: number;
  beforeAnchor?: string | null;
  afterAnchor?: string | null;
  maxChangedPercent?: number;
}): Promise<string> {
  const result = await applyEditorialPatches({
    userId: input.userId,
    bookId: input.bookId,
    expectedRevisionId: input.expectedRevisionId,
    patches: [{
      sceneId: input.sceneId,
      originalText: input.originalPassage,
      candidateText: input.replacement,
      sourceHash: textHash(input.originalPassage),
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      beforeAnchor: input.beforeAnchor,
      afterAnchor: input.afterAnchor,
      maxChangedPercent: input.maxChangedPercent ?? 25,
    }],
  });
  return result.revisionId;
}
