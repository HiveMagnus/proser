import { databaseService } from '../lib/database';
import { NotFoundError } from '../lib/errors';

export interface BookAiPolicy {
  bookId: number;
  aiDisabled: boolean;
  updatedAt: string | null;
}

async function ownedBook(userId: number, bookId: number) {
  const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId, deletedAt: null }, select: { id: true } });
  if (!book) throw new NotFoundError('Book not found');
}

function view(bookId: number, row: { aiDisabled: boolean; updatedAt: Date } | null): BookAiPolicy {
  return { bookId, aiDisabled: row?.aiDisabled ?? false, updatedAt: row?.updatedAt.toISOString() ?? null };
}

export async function getBookAiPolicy(userId: number, bookId: number): Promise<BookAiPolicy> {
  await ownedBook(userId, bookId);
  return view(bookId, await databaseService.client.bookAiPolicy.findUnique({ where: { bookId } }));
}

/** Switch AI on or off for one book and record the change in the audit log. */
export async function setBookAiPolicy(userId: number, bookId: number, input: { aiDisabled: boolean }): Promise<BookAiPolicy> {
  await ownedBook(userId, bookId);
  const row = await databaseService.client.$transaction(async (tx) => {
    const previous = await tx.bookAiPolicy.findUnique({ where: { bookId }, select: { aiDisabled: true } });
    const saved = await tx.bookAiPolicy.upsert({ where: { bookId }, create: { bookId, aiDisabled: input.aiDisabled }, update: { aiDisabled: input.aiDisabled } });
    if ((previous?.aiDisabled ?? false) !== input.aiDisabled) {
      await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: { command: 'book-ai-policy', aiDisabled: input.aiDisabled } } });
    }
    return saved;
  });
  return view(bookId, row);
}

/** IDs of the user's books that have AI switched off. */
export async function listAiDisabledBookIds(userId: number): Promise<number[]> {
  const rows = await databaseService.client.bookAiPolicy.findMany({ where: { aiDisabled: true, book: { userId, deletedAt: null } }, select: { bookId: true }, orderBy: { bookId: 'asc' } });
  return rows.map((row) => row.bookId);
}
