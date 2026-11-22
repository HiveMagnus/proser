import { databaseService } from '../database';

const ENABLED = (process.env.AI_CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';
const DEFAULT_TTL_SEC = Number.parseInt(process.env.AI_CACHE_TTL_SEC ?? '604800', 10) || 604800;

export async function getCached(model: string, promptHash: string, recipeVersion: string): Promise<string | null> {
  if (!ENABLED) return null;
  try {
    const prisma = databaseService.client;
  if (!prisma.aICache?.findFirst) return null;
  const row = await prisma.aICache.findFirst({ where: { model, recipeVersion, promptHash } });
    if (!row) return null;
  try { await prisma.aICache.update({ where: { id: row.id }, data: { hitCount: { increment: 1 }, lastHitAt: new Date() } }); } catch {}
    return String(row.value ?? '');
  } catch { return null; }
}

export async function setCached(model: string, promptHash: string, recipeVersion: string, value: string, ttlSec?: number): Promise<void> {
  if (!ENABLED) return;
  try {
    const prisma = databaseService.client;
  if (!prisma.aICache?.upsert) return;
  await prisma.aICache.upsert({
      where: { model_recipeVersion_promptHash: { model, recipeVersion, promptHash } },
      create: { model, recipeVersion, promptHash, value, ttlSec: ttlSec ?? DEFAULT_TTL_SEC, lastHitAt: new Date() },
      update: { value, ttlSec: ttlSec ?? DEFAULT_TTL_SEC, lastHitAt: new Date() }
    });
  } catch { /* ignore */ }
}
