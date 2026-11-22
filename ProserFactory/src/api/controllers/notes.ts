import { Response } from 'express';
import { AuthenticatedRequest, ApiResponse } from '../types';
import { notesService } from '../../services/notesService';
import { respondSuccess } from '../utils/response';

export class NotesController {
  static async getNotes(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const result = await notesService.listNotes(userId, bookId, {
      page: parseInt(req.query.page as string) || 1,
      pageSize: parseInt(req.query.pageSize as string) || 20,
    });
    respondSuccess(res, result);
  }

  static async createNote(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const { content } = req.body as { content?: string };
    const note = await notesService.createNote(userId, bookId, content);
    respondSuccess(res, { note }, 201);
  }

  static async updateNote(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const noteId = parseInt(req.params.noteId);
    const { content } = req.body as { content?: string };
    const updated = await notesService.updateNote(userId, noteId, content);
    respondSuccess(res, { note: updated });
  }

  static async deleteNote(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const noteId = parseInt(req.params.noteId);
    await notesService.deleteNote(userId, noteId);
    respondSuccess(res, { message: 'Note deleted' });
  }
}
