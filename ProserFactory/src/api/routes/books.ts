import { Router, raw } from 'express';
import { registerDocumentRoutes } from './documents';
import { exportCreativePackage } from '../../services/creativeImportService';
import { z } from 'zod';
import { BOOK_ARCHIVE_MAX_BYTES, exportBookArchive, importBookArchive } from '@/documents/bookArchive';
import { DocumentError } from '@/documents/errors';
import { getRecommendations, getWritingStats, setWritingGoal } from '../../services/writingStatsService';
import { getBookAiPolicy, listAiDisabledBookIds, setBookAiPolicy } from '../../services/bookAiPolicyService';
import { respondSuccess } from '../utils/response';
import { BooksController } from '../controllers/books';
import { booksService } from '../../services/booksService';
import { CodexController } from '../controllers/codex';
import { StructureController } from '../controllers/structure';
import { ActsController } from '../controllers/acts';
import { ChaptersController } from '../controllers/chapters';
import { ScenesController } from '../controllers/scenes';
import { NotesController } from '../controllers/notes';
import { ExportController } from '../controllers/export';
import { ExportArtifactsController } from '../controllers/exportArtifacts';
import { authenticateRequest } from '../middleware/auth';
import { expensiveRouteLimit } from '../middleware/expensiveRouteLimit';
import { ownedBookBudget } from '../middleware/ownedBookBudget';
import { generationRateLimit } from '../contracts/routeLimits';
import { ProseController } from '../controllers/prose';
import { zBody, zParams, zQuery } from '../middleware/zodValidation';
import {
  createBookBody, updateBookBody, codexSearchQuery, createCodexBody,
  saveStructureBody, reorderActsBody, reorderChaptersBody, actChapterBody,
  bookIdActIdParams, bookIdChapterIdParams, bookIdSceneIdParams,
  sceneBody, sceneGenerationBody, batchScenesBody, reorderScenesBody,
  bookIdNoteIdParams, noteBody, exportQuery, createExportArtifactBody,
  exportArtifactParams, readExportArtifactQuery, writingStatsQuery, writingGoalBody, recommendationsQuery, bookAiPolicyBody,
  bookIdParams, idParams, paginationQuery, compatibilityProjectionQuery,
} from '../schemas/books';
import { prosePreferenceBody } from '../schemas/prose';
import { codexRetrievalService } from '../../services/codexRetrievalService';

const router = Router();
const defaultRagTokenBudget = (): number =>
  Number.parseInt(process.env.RAG_TOKEN_BUDGET || '120000', 10) || 120000;

// All book routes require authentication
router.use(authenticateRequest);
registerDocumentRoutes(router);

// GET /api/books - List user's books
router.get('/', BooksController.getBooks);

// GET /api/books/trash - Deleted books that can be restored
router.get('/trash', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  respondSuccess(res, { books: await booksService.listDeletedBooks(req.user!.id) });
});

// GET /api/books/ai-policies - The user's books with AI switched off
router.get('/ai-policies', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  respondSuccess(res, { aiDisabledBookIds: await listAiDisabledBookIds(req.user!.id) });
});

// POST /api/books - Create new book
router.post('/',
  zBody(createBookBody),
  BooksController.createBook
);

// GET /api/books/:id - Get specific book
router.get('/:id',
  zParams(idParams),
  zQuery(compatibilityProjectionQuery),
  BooksController.getBook
);

// PUT /api/books/:id - Update book
router.put('/:id',
  zParams(idParams),
  zBody(updateBookBody),
  BooksController.updateBook
);

// DELETE /api/books/:id - Delete book
router.delete('/:id',
  zParams(idParams),
  BooksController.deleteBook
);

// GET /api/books/:bookId/codex - List codex entries for a book
router.get('/:bookId/codex',
  zParams(bookIdParams),
  CodexController.getCodexEntries
);

// GET /api/books/:bookId/codex/search - Debug retrieval for RAG
router.get('/:bookId/codex/search',
  zParams(bookIdParams),
  zQuery(codexSearchQuery),
  async (req, res): Promise<void> => {
    const userId = req.user?.id as number;
    const bookId = parseInt(req.params.bookId as string);
    // Ownership check
    const book = await (await import('../../lib/database')).databaseService.client.book.findFirst({ where: { id: bookId, userId } });
    if (!book) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Book not found' } }); return; }

    const types = (req.query.types as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean);
    const results = await codexRetrievalService.getRelevantCodex({
      bookId,
      outline: (req.query.outline as string) || '',
      summary: (req.query.summary as string) || '',
      types: types,
      tokenBudget: req.query.tokenBudget ? parseInt(req.query.tokenBudget as string) : defaultRagTokenBudget(),
      k: req.query.k ? parseInt(req.query.k as string) : undefined
    });
    res.json({ success: true, data: results });
    return;
  }
);

// POST /api/books/:bookId/codex - Create codex entry for a book
router.post('/:bookId/codex',
  zParams(bookIdParams),
  zBody(createCodexBody),
  CodexController.createCodexEntry
);

export default router;

// Structure endpoints
router.get('/:bookId/structure',
  zParams(bookIdParams),
  StructureController.getStructure
);

router.post('/:bookId/structure',
  zParams(bookIdParams),
  zBody(saveStructureBody),
  StructureController.saveStructure
);

router.post('/:bookId/reorder-acts',
  zParams(bookIdParams),
  zBody(reorderActsBody),
  StructureController.reorderActs
);

router.post('/:bookId/acts/:actId/reorder-chapters',
  zParams(bookIdActIdParams),
  zBody(reorderChaptersBody),
  StructureController.reorderChapters
);

// Acts
router.post('/:bookId/acts',
  zParams(bookIdParams),
  zBody(actChapterBody),
  ActsController.createAct
);

router.put('/:bookId/acts/:actId',
  zParams(bookIdActIdParams),
  zBody(actChapterBody),
  ActsController.updateAct
);

router.delete('/:bookId/acts/:actId',
  zParams(bookIdActIdParams),
  ActsController.deleteAct
);

// Chapters
router.post('/:bookId/acts/:actId/chapters',
  zParams(bookIdActIdParams),
  zBody(actChapterBody),
  ChaptersController.createChapter
);
router.put('/:bookId/chapters/:chapterId',
  zParams(bookIdChapterIdParams),
  zBody(actChapterBody),
  ChaptersController.updateChapter
);

router.delete('/:bookId/chapters/:chapterId',
  zParams(bookIdChapterIdParams),
  ChaptersController.deleteChapter
);

// Scenes — book-level (flat list)
router.get('/:bookId/scenes',
  zParams(bookIdParams),
  zQuery(compatibilityProjectionQuery),
  ScenesController.getAllScenes
);

// Scenes — chapter-level
router.get('/:bookId/chapters/:chapterId/scenes',
  zParams(bookIdChapterIdParams),
  zQuery(compatibilityProjectionQuery),
  ScenesController.getScenes
);

router.post('/:bookId/chapters/:chapterId/scenes',
  zParams(bookIdChapterIdParams),
  zBody(sceneBody),
  ScenesController.createScene
);

router.post('/:bookId/chapters/:chapterId/scenes/batch',
  zParams(bookIdChapterIdParams),
  zBody(batchScenesBody),
  ScenesController.batchCreateScenes
);

router.post('/:bookId/chapters/:chapterId/scenes/generate',
  zParams(bookIdChapterIdParams),
  zBody(sceneBody),
  generationRateLimit('prose'),
  ScenesController.createAndGenerateScene
);

router.get('/:bookId/scenes/:sceneId',
  zParams(bookIdSceneIdParams),
  zQuery(compatibilityProjectionQuery),
  ScenesController.getScene
);

router.put('/:bookId/scenes/:sceneId',
  zParams(bookIdSceneIdParams),
  zBody(sceneBody),
  ScenesController.updateScene
);

router.delete('/:bookId/scenes/:sceneId',
  zParams(bookIdSceneIdParams),
  ScenesController.deleteScene
);

router.post('/:bookId/scenes/:sceneId/regenerate',
  zParams(bookIdSceneIdParams),
  zBody(sceneGenerationBody),
  generationRateLimit('prose'),
  ScenesController.regenerateScene
);

router.get('/:bookId/scenes/:sceneId/prose/traces/latest',
  zParams(bookIdSceneIdParams),
  ProseController.getLatestTraceForScene
);

router.post('/:bookId/scenes/:sceneId/prose/preferences',
  zParams(bookIdSceneIdParams),
  zBody(prosePreferenceBody),
  ProseController.submitPreference
);

router.post('/:bookId/chapters/:chapterId/reorder-scenes',
  zParams(bookIdChapterIdParams),
  zBody(reorderScenesBody),
  ScenesController.reorderScenes
);

// Notes
router.get('/:bookId/notes',
  zParams(bookIdParams),
  zQuery(paginationQuery),
  NotesController.getNotes
);

router.post('/:bookId/notes',
  zParams(bookIdParams),
  zBody(noteBody),
  NotesController.createNote
);

router.put('/:bookId/notes/:noteId',
  zParams(bookIdNoteIdParams),
  zBody(noteBody),
  NotesController.updateNote
);

router.delete('/:bookId/notes/:noteId',
  zParams(bookIdNoteIdParams),
  NotesController.deleteNote
);

// Writing statistics, goals and next steps
router.get('/:bookId/writing-stats',
  zParams(bookIdParams),
  zQuery(writingStatsQuery),
  async (req, res) => {
    const query = req.query as { days?: number; tz?: string };
    respondSuccess(res, await getWritingStats(req.user!.id, Number(req.params.bookId), { days: query.days, timeZone: query.tz }));
  });

router.put('/:bookId/writing-goal',
  zParams(bookIdParams),
  zBody(writingGoalBody),
  async (req, res) => {
    respondSuccess(res, { goal: await setWritingGoal(req.user!.id, Number(req.params.bookId), req.body) });
  });

// Per-book AI switch: with aiDisabled, Factory refuses every model-provider request for the book.
router.get('/:bookId/ai-policy',
  zParams(bookIdParams),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(res, await getBookAiPolicy(req.user!.id, Number(req.params.bookId)));
  });

router.put('/:bookId/ai-policy',
  zParams(bookIdParams),
  zBody(bookAiPolicyBody),
  async (req, res) => {
    respondSuccess(res, await setBookAiPolicy(req.user!.id, Number(req.params.bookId), req.body));
  });

router.get('/:bookId/recommendations',
  zParams(bookIdParams),
  zQuery(recommendationsQuery),
  async (req, res) => {
    const query = req.query as { tz?: string };
    respondSuccess(res, { recommendations: await getRecommendations(req.user!.id, Number(req.params.bookId), { timeZone: query.tz }) });
  });

// Export
router.get('/:bookId/export',
  zParams(bookIdParams),
  zQuery(exportQuery),
  ownedBookBudget({ source: 'params', required: true }),
  expensiveRouteLimit('bookExport'),
  ExportController.exportBook
);

router.get('/:bookId/creative-package',
  zParams(bookIdParams),
  ownedBookBudget({ source: 'params', required: true }),
  expensiveRouteLimit('bookCreativePackage'),
  async (req, res) => {
  const bookId = Number(req.params.bookId);
  const archive = await exportCreativePackage(req.user!.id, bookId);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="book-${bookId}-illustrated.zip"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(archive);
});

// GET /api/books/:bookId/archive - Portable archive of the whole book
router.get('/:bookId/archive',
  zParams(bookIdParams),
  ownedBookBudget({ source: 'params', required: true }),
  expensiveRouteLimit('bookArchive'),
  async (req, res) => {
  const { archive, sha256, filename } = await exportBookArchive(req.user!.id, Number(req.params.bookId));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-SHA256', sha256);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(archive);
});

// POST /api/books/archive-imports?operationId= - Import an archive as a new book
const archiveImportQuery = z.object({ operationId: z.string().uuid() }).strict();
router.post('/archive-imports',
  zQuery(archiveImportQuery),
  expensiveRouteLimit('bookArchiveImport'),
  (req, _res, next) => { if (!req.is('application/zip')) throw new DocumentError('DOCUMENT_ARCHIVE_MEDIA_TYPE_INVALID', 'Upload the book archive as application/zip.', 415); next(); },
  (req, res, next) => { raw({ type: 'application/zip', limit: BOOK_ARCHIVE_MAX_BYTES })(req, res, (error: unknown) => { if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') next(new DocumentError('DOCUMENT_ARCHIVE_TOO_LARGE', 'Book archives must be 128 MiB or smaller.', 413)); else next(error); }); },
  async (req, res) => {
  const body: unknown = req.body;
  if (Array.isArray(body) || !(body instanceof Buffer)) throw new DocumentError('DOCUMENT_ARCHIVE_INVALID', 'Upload the book archive bytes.', 422);
  res.setHeader('Cache-Control', 'private, no-store');
  respondSuccess(res, await importBookArchive(req.user!.id, body, String(req.query.operationId)), 201);
});

router.post('/:bookId/export-artifacts',
  zParams(bookIdParams),
  zBody(createExportArtifactBody),
  ownedBookBudget({ source: 'params', required: true }),
  expensiveRouteLimit('exportArtifactCreate'),
  ExportArtifactsController.create
);

router.get('/:bookId/export-artifacts/:artifactId',
  zParams(exportArtifactParams),
  ExportArtifactsController.get
);

router.get('/:bookId/export-artifacts/:artifactId/read',
  zParams(exportArtifactParams),
  zQuery(readExportArtifactQuery),
  ExportArtifactsController.read
);

router.get('/:bookId/export-artifacts/:artifactId/download',
  zParams(exportArtifactParams),
  ExportArtifactsController.download
);

router.delete('/:bookId/export-artifacts/:artifactId',
  zParams(exportArtifactParams),
  ExportArtifactsController.delete
);

router.get('/:bookId/prose/quality',
  zParams(bookIdParams),
  ProseController.getBookQualityOverview
);

// Reset all generated content (workflows, revisions, memory, skills, structure)
router.post('/:bookId/reset',
  zParams(bookIdParams),
  ownedBookBudget({ source: 'params', required: true }),
  expensiveRouteLimit('bookReset'),
  BooksController.resetBook
);
