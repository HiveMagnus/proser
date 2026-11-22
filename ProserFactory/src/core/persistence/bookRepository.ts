import { PrismaClient, Book, type Prisma } from '@prisma/client';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import { catalogResult, catalogCommand } from '@/documents/catalogCommands';
import type { DocumentMutationPreconditions } from '@/documents/scope-model';

export type CreateBookInput = {
  userId: number;
  title?: string | null;
  genre?: string | null;
  targetAudience?: string | null;
  summary?: string | null;
};

export type UpdateBookPatch = Partial<{
  title: string | null;
  genre: string | null;
  targetAudience: string | null;
  summary: string | null;
  tagline: string | null;
  storyOutline: string | null;
  draftStatus: 'draft' | 'final';
}>;

export class BookRepository {
  constructor(private prisma: PrismaClient) {}

  async findById(userId: number, bookId: number): Promise<Book | null> {
    return this.prisma.book.findFirst({ where: { id: bookId, userId } });
  }

  async listByUser(userId: number, opts?: { page?: number; pageSize?: number }): Promise<Book[]> {
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));
    return this.prisma.book.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }

  async create(input: CreateBookInput, operationId?: string): Promise<Book> {
    if (documentAuthorityEnabled()) {
      const { userId, ...data } = input;
      return catalogResult(await documentService.createBook(userId, data, operationId ?? ''));
    }
    return this.prisma.book.create({
      data: {
        userId: input.userId,
        title: input.title ?? null,
        genre: input.genre ?? null,
        targetAudience: input.targetAudience ?? null,
        summary: input.summary ?? null,
        draftStatus: 'draft',
      },
    });
  }

  async updatePatch(userId: number, bookId: number, patch: UpdateBookPatch, expected?: DocumentMutationPreconditions): Promise<Book | null> {
    const existing = await this.findById(userId, bookId);
    if (!existing) return null;
    const data: Prisma.BookUpdateInput = {};
    const keys: Array<keyof UpdateBookPatch> = [
      'title',
      'genre',
      'targetAudience',
      'summary',
      'tagline',
      'storyOutline',
      'draftStatus',
    ];
    for (const k of keys) {
      if (k in patch) (data as Record<string, unknown>)[k] = patch[k];
    }
    if (documentAuthorityEnabled()) return catalogResult(await documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'repository-update-book', patch }), async (tx) => ({ result: await tx.book.update({ where: { id: bookId }, data }) })));
    return this.prisma.book.update({ where: { id: bookId }, data });
  }
}
