import { databaseService } from '@/lib/database';
import type { RagChunk, RagQuery, RagSource } from '@/lib/rag/types';

const tokens = (text: string) => Math.ceil(text.length / 4);

/** Accepted scene contracts, voice exemplars, revision directives, ledgers, and exact prior ending. */
export class NarrativeArtifactSource implements RagSource {
  readonly name = 'narrative-artifacts';
  readonly sourceType = 'style' as const;

  async fetch(query: RagQuery): Promise<RagChunk[]> {
    const db = databaseService.client;
    const run = await db.workflowRun.findFirst({ where: { bookId: query.bookId, status: { in: ['running', 'paused', 'completed', 'publishable_candidate', 'release_approved'] } }, orderBy: { createdAt: 'desc' } });
    const chunks: RagChunk[] = [];
    if (run) {
      const artifacts = await db.workflowArtifact.findMany({
        where: { runId: run.id, artifactType: { in: ['scene_contract', 'voice_style_bible', 'architecture', 'character_arc', 'revision_plan', 'chapter_integration'] }, OR: [{ scopeType: 'book' }, ...(query.sceneId ? [{ scopeType: 'scene', scopeId: String(query.sceneId) }] : [])] },
        orderBy: { createdAt: 'desc' }, take: query.k ?? 20,
      });
      for (const artifact of artifacts) {
        const text = `[${artifact.artifactType}] ${JSON.stringify(artifact.payload)}`;
        chunks.push({ id: `artifact:${artifact.id}`, sourceType: 'style', sourceId: artifact.id, text, tokenCount: tokens(text), metadata: { bookId: query.bookId, artifactType: artifact.artifactType, scopeType: artifact.scopeType, scopeId: artifact.scopeId } });
      }
      const ledgers = await db.narrativeLedger.findMany({ where: { workflowRunId: run.id, status: { not: 'superseded' }, ledgerType: { in: ['knowledge', 'promise', 'motif', 'relationship', 'spatial', 'time', 'question', 'secret', 'decision'] } }, orderBy: { updatedAt: 'desc' }, take: query.k ?? 20 });
      for (const ledger of ledgers) {
        const text = `[${ledger.ledgerType}:${ledger.status}] ${JSON.stringify(ledger.payload)}`;
        chunks.push({ id: `ledger:${ledger.id}`, sourceType: ledger.ledgerType === 'relationship' ? 'relationship' : ledger.ledgerType === 'promise' ? 'thread' : 'timeline', sourceId: ledger.id, text, tokenCount: tokens(text), metadata: { bookId: query.bookId, ledgerType: ledger.ledgerType, ledgerKey: ledger.ledgerKey, status: ledger.status } });
      }
    }
    if (query.sceneId) {
      const current = await db.scene.findUnique({ where: { id: query.sceneId }, include: { chapter: { include: { act: true } } } });
      if (current) {
        const previous = await db.scene.findFirst({ where: { chapter: { act: { bookId: query.bookId } }, deletedAt: null, prose: { not: null }, OR: [{ chapter: { act: { actNumber: { lt: current.chapter.act.actNumber } } } }, { chapter: { actId: current.chapter.actId, chapterNumber: { lt: current.chapter.chapterNumber } } }, { chapterId: current.chapterId, sceneNumber: { lt: current.sceneNumber } }] }, orderBy: [{ chapter: { act: { actNumber: 'desc' } } }, { chapter: { chapterNumber: 'desc' } }, { sceneNumber: 'desc' }] });
        if (previous?.prose) {
          const ending = previous.prose.split(/\s+/).slice(-1000).join(' ');
          const text = `[EXACT PRIOR SCENE ENDING; scene ${previous.id}]\n${ending}`;
          chunks.push({ id: `prior-ending:${previous.id}`, sourceType: 'timeline', sourceId: String(previous.id), text, tokenCount: tokens(text), metadata: { bookId: query.bookId, sceneId: previous.id, exactEnding: true } });
        }
      }
    }
    return chunks;
  }

  async invalidate(_bookId: number, _sourceId?: string): Promise<void> {}
}
