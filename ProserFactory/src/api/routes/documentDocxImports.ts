import { ownedBookBudget } from '@/api/middleware/ownedBookBudget';
import { expensiveRouteLimit } from '@/api/middleware/expensiveRouteLimit';
import { raw, type Router } from 'express';
import { redisRateLimit } from '@/api/middleware/redisRateLimit';
import { z } from 'zod';
import { zBody, zParams } from '@/api/middleware/zodValidation';
import { respondSuccess } from '@/api/utils/response';
import { documentBookParams, requireDocumentPreconditions } from '@/api/schemas/documents';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import { DocumentError } from '@/documents/errors';
import {
  importPreviewSchema,
  docxImportCommitSchema,
  requireDocxImportCommitPreconditions,
} from '@/documents/importValidation';
import {
  preserveDocxOriginal,
  prepareDocxImport,
  readDocxImportPreview,
  commitDocxImport,
} from '@/documents/docxImports';
export function registerDocumentDocxImportRoutes(router: Router) {
  router.use(
    ['/:bookId/docx-import-originals', '/:bookId/docx-import-previews'],
    (_req, _res, next) => {
      if (!documentAuthorityEnabled())
        return next(
          new DocumentError(
            'DOCUMENT_AUTHORITY_INACTIVE',
            'Structured document migration is inactive.',
            503,
          ),
        );
      next();
    },
  );
  const originalParams = documentBookParams.extend({ originalId: z.string().uuid() });
  const previewParams = documentBookParams.extend({ previewId: z.string().uuid() });
  router.post(
    '/:bookId/docx-import-originals/:originalId',
    zParams(originalParams),
    redisRateLimit({ key: (req) => `import-original:${req.user?.id}`, limit: 30, windowSec: 3600 }),
    (req, _res, next) => {
      if (!req.is('application/octet-stream'))
        throw new DocumentError(
          'DOCUMENT_IMPORT_MEDIA_TYPE_INVALID',
          'Upload original bytes as application/octet-stream.',
          415,
        );
      next();
    },
    (req, res, next) =>
      raw({ type: 'application/octet-stream', limit: '32mb' })(req, res, (error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'type' in error &&
          error.type === 'entity.too.large'
        )
          next(new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', 'Original exceeds 32 MiB.', 413));
        else next(error);
      }),
    async (req, res) => {
      respondSuccess(
        res,
        await preserveDocxOriginal(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.originalId),
          req.body,
        ),
        201,
      );
    },
  );
  router.post(
    '/:bookId/docx-import-previews',
    zParams(documentBookParams),
    (req, _res, next) => {
      requireDocumentPreconditions(req.body, false);
      next();
    },
    zBody(importPreviewSchema),
    ownedBookBudget({ source: 'params', required: true }),
    expensiveRouteLimit('exportArtifactCreate'),
    async (req, res) => {
      respondSuccess(
        res,
        await prepareDocxImport(req.user!.id, Number(req.params.bookId), req.body),
      );
    },
  );
  router.get(
    '/:bookId/docx-import-previews/:previewId',
    zParams(previewParams),
    async (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      respondSuccess(
        res,
        await readDocxImportPreview(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.previewId),
        ),
      );
    },
  );
  router.post(
    '/:bookId/docx-import-previews/:previewId/commit',
    zParams(previewParams),
    (req, _res, next) => {
      requireDocxImportCommitPreconditions(req.body);
      next();
    },
    zBody(docxImportCommitSchema),
    async (req, res) => {
      respondSuccess(
        res,
        await commitDocxImport(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.previewId),
          req.body,
        ),
      );
    },
  );
}
