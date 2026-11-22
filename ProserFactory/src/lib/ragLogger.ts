import pino from 'pino';
import { registerLoggerDestination } from './logger';
import path from 'node:path';
import fs from 'node:fs';

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function todayStamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`; // e.g., 20250829
}

// Write RAG logs to the standard tmp directory requested by ops
const logsDir = '/tmp/proser';
ensureDir(logsDir);
const filename = `rag-${todayStamp()}.log`;
const destPath = path.join(logsDir, filename);

// Write asynchronously; let pino create the file (mkdir ensured above)
const ragLogDestination = pino.destination({ dest: destPath, sync: false });
registerLoggerDestination(ragLogDestination);
export const ragLogger = pino({
  level: process.env.RAG_LOG_LEVEL || 'info',
  base: undefined
}, ragLogDestination);

export type RagEvent =
  | { type: 'retrieval.start'; bookId: number; sceneId?: number; types?: string[]; k?: number; tokenBudget?: number; keywordCount: number; keywords?: string[] }
  | { type: 'retrieval.result'; bookId: number; sceneId?: number; candidates: number; selected: Array<{ id: number; entry_type: string; entry_name: string; score?: number }>; cache?: 'hit' | 'miss' }
  | { type: 'retrieval.error'; bookId: number; sceneId?: number; message: string }
  | { type: 'prose.rag.apply'; bookId: number; sceneId?: number; count: number }
  | { type: 'prose.rag.skip'; bookId: number; sceneId?: number; reason: string }
  | { type: 'prose.generate.fail'; bookId: number; sceneId?: number; withRag: boolean; message: string }
  | { type: 'prose.generate.fallback.success'; bookId: number; sceneId?: number }
  | { type: 'prompt.codex.tokens'; bookId: number; sceneId?: number; tokens: number }
  // Unified RAG orchestrator events (Priority A - Phase 1)
  | { type: 'orchestrator.compose'; bookId: number; sceneId?: number; candidates: number; selected: number; tokenBudget: number; tokenBudgetUsed: number; semanticAvailable: boolean; latencyMs: number }
  | { type: 'orchestrator.fallback'; bookId: number; sceneId?: number; reason: string }
  | { type: 'indexer.indexed'; bookId: number; sourceId: string; hasEmbedding: boolean }
  | { type: 'indexer.removed'; bookId: number; sourceId: string }
  | { type: 'eval.result'; scenario: string; recallAtK: number; mrr: number; ndcg: number; tokenEfficiency: number }
  // Narrative Memory events (Priority B - Phase 2)
  | { type: 'memory.extract.start'; bookId: number; sceneId?: number }
  | { type: 'memory.extract.result'; bookId: number; sceneId?: number; events: number; stateChanges: number; threadUpdates: number; latencyMs: number }
  | { type: 'memory.extract.error'; bookId: number; sceneId?: number; message: string }
  | { type: 'memory.retrieve'; bookId: number; sceneId?: number; events: number; characters: number; threads: number; tokens: number }
  // Skills Runtime events (Priority B - Phase 3)
  | { type: 'skill.run.start'; bookId: number; sceneId?: number; skillName: string }
  | { type: 'skill.run.result'; bookId: number; sceneId?: number; skillName: string; findings: number; latencyMs: number }
  | { type: 'skill.run.error'; bookId: number; sceneId?: number; skillName: string; message: string };

export function logRag(event: RagEvent): void {
  // Keep a consistent top-level key for easier grep
  ragLogger.info({ rag: event });
}
