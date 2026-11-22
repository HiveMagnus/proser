import { databaseService } from '../lib/database';
import { NotFoundError } from '../lib/errors';

class NotesService {
  async listNotes(userId: number, bookId: number, opts: { page?: number; pageSize?: number }) {
    const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
    if (!book) throw new NotFoundError('Book not found');
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, opts.pageSize ?? 20);
    const total = await databaseService.client.note.count({ where: { bookId } });
    const notes = await databaseService.client.note.findMany({
      where: { bookId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize
    });
    return { notes, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  async createNote(userId: number, bookId: number, content?: string) {
    const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
    if (!book) throw new NotFoundError('Book not found');
    const defaultContent = content ?? '';
    const implicitTitle = defaultContent.split(/\n/)[0].slice(0, 64) || 'Untitled Note';
    return databaseService.client.note.create({ data: { bookId, title: implicitTitle, content: defaultContent } });
  }

  async updateNote(userId: number, noteId: number, content?: string) {
    const note = await databaseService.client.note.findFirst({ where: { id: noteId, book: { userId } } });
    if (!note) throw new NotFoundError('Note not found');
    return databaseService.client.note.update({ where: { id: noteId }, data: { content: content ?? '' } });
  }

  async deleteNote(userId: number, noteId: number) {
    const note = await databaseService.client.note.findFirst({ where: { id: noteId, book: { userId } } });
    if (!note) throw new NotFoundError('Note not found');
    await databaseService.client.note.delete({ where: { id: noteId } });
  }
}

export const notesService = new NotesService();
