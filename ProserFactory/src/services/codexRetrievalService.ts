import { documentAuthorityEnabled } from '@/documents/capabilities';
import { databaseService } from '../lib/database';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { getJson, setJson } from '../lib/redis/contentCache';
import { getRagCodexCacheKey } from '../lib/redis/contentCache';
import logger from '../lib/logger';
import { time } from '../lib/metrics';
import { recordRetrieveTime, recordCandidatesCount, recordSelectedCount, incCache, recordPromptTokens } from '../metrics/codex';
import { logRag } from '../lib/ragLogger';

export interface RetrievedCodex {
  id: number;
  entry_type: string;
  entry_name: string;
  excerpt: string;
  score?: number;
}

export interface GetRelevantCodexArgs {
  bookId: number;
  sceneId?: number;
  outline?: string;
  summary?: string;
  types?: Array<'character' | 'location' | 'item' | string>;
  tokenBudget?: number; // rough cap; we'll map to max entries x chars
  k?: number; // preferred count
}

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_'’]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 200);
}

function compressDescription(desc: string | null | undefined, max = 240): string {
  if (!desc) return '';
  const s = desc.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function scoreEntry(entry: { entryName: string; entryType: string; entryDescription: string | null }, keywords: Set<string>): number {
  let score = 0;
  const name = entry.entryName.toLowerCase();
  const type = entry.entryType.toLowerCase();
  for (const kw of keywords) {
    if (!kw) continue;
    if (name.includes(kw)) score += 5;
    else if (entry.entryDescription && entry.entryDescription.toLowerCase().includes(kw)) score += 1;
  }
  // Type boost to prefer common entity types first
  if (type === 'character') score += 2; else if (type === 'location') score += 1;
  return score;
}

export class CodexRetrievalService {
  async getRelevantCodex(args: GetRelevantCodexArgs): Promise<RetrievedCodex[]> {
  const { bookId, sceneId, outline = '', summary = '', types, tokenBudget = 120000, k } = args;
    const tokens = tokenize([outline, summary].filter(Boolean).join(' '));
    // Derive keywords: prefer distinct tokens with length >=3 plus capitalized words in outline
    const keywordSet = new Set<string>(tokens.filter((t) => t.length >= 3).slice(0, 30));
  logRag({ type: 'retrieval.start', bookId, sceneId, types: (types as string[]|undefined), k, tokenBudget, keywordCount: keywordSet.size, keywords: Array.from(keywordSet) });

    const where: Prisma.CodexEntryWhereInput = {
      bookId,
      ...(types && types.length > 0 ? { entryType: { in: types as string[] } } : {}),
      OR: Array.from(keywordSet).map((kw) => ({
        OR: [
          { entryName: { contains: kw } },
          { entryDescription: { contains: kw } }
        ]
      }))
    };

    // If no keywords, fall back to recent entries to avoid empty
    const hasKeywords = Array.isArray(where.OR) && where.OR.length > 0;

    // Cache lookup by hashed query
  const hash = crypto.createHash('sha1').update(JSON.stringify({ outline, summary, types, tokenBudget, k })).digest('hex');
  let cacheHit: 'hit' | 'miss' | undefined = undefined;
  const t0 = performance.now();
  try {
      const { key } = await getRagCodexCacheKey(bookId, sceneId ? 'scene' : 'book', sceneId, hash);
      const cached = await getJson<RetrievedCodex[]>(key);
      if (cached && cached.length) {
    cacheHit = 'hit';
    const ms = performance.now() - t0;
    recordRetrieveTime(ms, { book_id: bookId, scene_id: sceneId, cache: 'hit' });
    recordSelectedCount(cached.length, { book_id: bookId, scene_id: sceneId });
    incCache('hit', { book_id: bookId, scene_id: sceneId });
    logRag({ type: 'retrieval.result', bookId, sceneId, candidates: cached.length, selected: cached.map(c => ({ id: c.id, entry_type: c.entry_type, entry_name: c.entry_name, score: c.score })), cache: 'hit' });
        return cached;
      }
  } catch {/* ignore cache errors */}

  const candidates = await time('kb.codex.candidates.time', () => databaseService.client.codexEntry.findMany({
      where: hasKeywords ? where : { bookId, ...(types && types.length > 0 ? { entryType: { in: types as string[] } } : {}) },
      take: hasKeywords ? 100 : 50,
      orderBy: hasKeywords ? undefined : { updatedAt: 'desc' }
  }));
  recordCandidatesCount(candidates.length, { book_id: bookId, scene_id: sceneId });

    const scored = candidates.map((c) => ({ c, s: scoreEntry(c, keywordSet) }))
      .sort((a, b) => b.s - a.s);

    // Budgeting: assume ~80 tokens per item average; pick k within tokenBudget
    const perItemTokens = 80;
    const maxByBudget = Math.max(1, Math.floor(tokenBudget / perItemTokens));
    const limit = Math.min(scored.length, k ?? maxByBudget, 7);

  const top = scored.slice(0, limit).map(({ c, s }) => ({
      id: c.id,
      entry_type: c.entryType,
      entry_name: c.entryName,
      excerpt: compressDescription(c.entryDescription, 240),
      score: s
    }));

  // Store in cache (short TTL via setJson default)
    try {
      const { key } = await getRagCodexCacheKey(bookId, sceneId ? 'scene' : 'book', sceneId, hash);
      await setJson(key, top);
    } catch {/* ignore cache errors */}

  cacheHit = cacheHit ?? 'miss';
  const ms = performance.now() - t0;
  recordRetrieveTime(ms, { book_id: bookId, scene_id: sceneId, cache: cacheHit });
  incCache(cacheHit, { book_id: bookId, scene_id: sceneId });
  recordSelectedCount(top.length, { book_id: bookId, scene_id: sceneId });
  logRag({ type: 'retrieval.result', bookId, sceneId, candidates: candidates.length, selected: top.map(c => ({ id: c.id, entry_type: c.entry_type, entry_name: c.entry_name, score: c.score })), cache: cacheHit });

    return top;
  }
}

export const codexRetrievalService = new CodexRetrievalService();

// Compose prompt segment and optionally record provenance
export function buildCodexContextSection(entries: RetrievedCodex[]): string {
  if (!entries.length) return '';
  const lines = ['[Codex Context]'];
  for (const e of entries) {
    const typeTitle = e.entry_type.charAt(0).toUpperCase() + e.entry_type.slice(1);
    const desc = e.excerpt ? ` — ${e.excerpt}` : '';
    lines.push(`- ${typeTitle}: ${e.entry_name}${desc}`);
  }
  lines.push('---');
  // Rough token estimation: 1 token ~ 4 chars
  try { recordPromptTokens(Math.ceil(lines.join('\n').length / 4)); } catch {}
  return lines.join('\n');
}

export async function recordSceneCodexUsage(sceneId: number, entries: RetrievedCodex[], rationale?: string, source?: { bookRevisionId: string; sceneRevisionId: string; contentHash: string }): Promise<void> {
  if (!entries.length) return;
  try {
  if (documentAuthorityEnabled()) {
    // Retrieval is evidence about an inference context, not an editorial change
    // to canonical scene/codex relationships.
    const scene = await databaseService.client.scene.findFirst({ where: { id: sceneId }, select: { chapter: { select: { act: { select: { bookId: true } } } } } });
    if (!scene) return;
    const head = await databaseService.client.bookDocumentHead.findUnique({ where: { bookId: scene.chapter.act.bookId }, select: { revisionId: true } });
    await databaseService.client.sceneMemoryEvent.create({ data: { bookId: scene.chapter.act.bookId, sceneId, eventType: 'codex_retrieval', actors: [], summary: rationale ?? 'Codex retrieved for inference', payload: { sourceBookRevisionId: source?.bookRevisionId ?? head?.revisionId, sourceSceneRevisionId: source?.sceneRevisionId, sourceContentHash: source?.contentHash, codexIds: entries.map((entry) => entry.id) } } });
    return;
  }
  await databaseService.client.$transaction(async (tx) => {
      for (const e of entries) {
    await tx.sceneCodexUsage.upsert({
          where: { sceneId_codexId: { sceneId, codexId: e.id } },
          create: { sceneId, codexId: e.id, rationale: rationale ?? null },
          update: { rationale: rationale ?? null, usedAt: new Date() }
        });
      }
    });
  } catch (err) {
  logger.warn({ err: (err as Error).message, sceneId }, 'Failed to record SceneCodexUsage');
  // Also surface in RAG log
  try { logRag({ type: 'retrieval.error', bookId: NaN, sceneId, message: (err as Error).message }); } catch {}
  }
}
