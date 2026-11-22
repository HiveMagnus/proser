import { databaseService } from '../database';

function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export async function getTopKCodex(bookId: number, k = 3, keywords: string[] = []): Promise<Array<{ entryType: string; entryName: string; entryDescription: string }>> {
  const prisma = databaseService.client;
  const rows = await prisma.codexEntry.findMany({ where: { bookId }, select: { entryType: true, entryName: true, entryDescription: true }, take: 200 });
  const keySet = new Set(keywords.map((w) => w.toLowerCase()));
  const scored = rows.map((r) => {
    const tokens = new Set([...tokenize(r.entryName), ...tokenize(r.entryDescription || '')]);
    let score = 0;
    for (const t of keySet) { if (tokens.has(t)) score++; }
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => ({ entryType: s.row.entryType, entryName: s.row.entryName, entryDescription: s.row.entryDescription || '' }));
}
