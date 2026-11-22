import { ownedBookBudget } from '@/api/middleware/ownedBookBudget';
import { expensiveRouteLimit } from '@/api/middleware/expensiveRouteLimit';
import { createHash } from 'node:crypto';
import type { Router } from 'express';
import { z } from 'zod';
import { respondSuccess } from '@/api/utils/response';
import { zParams, zBody } from '@/api/middleware/zodValidation';
import { documentBookParams } from '@/api/schemas/documents';
import { documentAuthorityEnabled } from '@/documents/capabilities';
import { DocumentError } from '@/documents/errors';
import {
  publicationJobSchema,
  requirePublicationPreconditions,
} from '@/documents/publicationValidation';
import {
  listPublicationJobs,
  publicationCapabilities,
  createPublicationJob,
  readPublicationJob,
  dispatchPublicationJob,
  cancelPublicationJob,
  readPublicationArtifact,
} from '@/documents/publication';
export function registerDocumentPublicationRoutes(router: Router) {
  const jobParams = documentBookParams.extend({ jobId: z.string().uuid() });
  const artifactParams = documentBookParams.extend({ artifactId: z.string().uuid() });
  router.use(
    [
      '/:bookId/document-publication-capabilities',
      '/:bookId/document-publication-jobs',
      '/:bookId/document-publication-artifacts',
    ],
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
  router.get(
    '/:bookId/document-publication-capabilities',
    zParams(documentBookParams),
    async (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      respondSuccess(res, await publicationCapabilities(req.user!.id, Number(req.params.bookId)));
    },
  );
  router.get(
    '/:bookId/document-publication-jobs',
    zParams(documentBookParams),
    async (req, res) => {
      const cursor =
        req.query.cursor === undefined ? undefined : z.string().uuid().parse(req.query.cursor);
      res.setHeader('Cache-Control', 'private, no-store');
      respondSuccess(
        res,
        await listPublicationJobs(req.user!.id, Number(req.params.bookId), cursor),
      );
    },
  );
  router.post(
    '/:bookId/document-publication-jobs',
    zParams(documentBookParams),
    (req, _res, next) => {
      requirePublicationPreconditions(req.body);
      next();
    },
    zBody(publicationJobSchema),
    ownedBookBudget({ source: 'params', required: true }),
    expensiveRouteLimit('exportArtifactCreate'),
    async (req, res) => {
      let job = await createPublicationJob(req.user!.id, Number(req.params.bookId), req.body);
      if (job.status === 'pending')
        job = await await dispatchPublicationJob(req.user!.id, Number(req.params.bookId), job.id);
      respondSuccess(res, job, job.status === 'completed' ? 200 : 202);
    },
  );
  router.get('/:bookId/document-publication-jobs/:jobId', zParams(jobParams), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    respondSuccess(
      res,
      await readPublicationJob(req.user!.id, Number(req.params.bookId), String(req.params.jobId)),
    );
  });
  router.post(
    '/:bookId/document-publication-jobs/:jobId/resume',
    zParams(jobParams),
    zBody(z.object({}).strict()),
    async (req, res) => {
      const job = await readPublicationJob(
        req.user!.id,
        Number(req.params.bookId),
        String(req.params.jobId),
      );
      if (!['completed', 'cancelled'].includes(job.status))
        await dispatchPublicationJob(req.user!.id, Number(req.params.bookId), job.id);
      respondSuccess(res, job, 202);
    },
  );
  router.post(
    '/:bookId/document-publication-jobs/:jobId/cancel',
    zParams(jobParams),
    zBody(z.object({}).strict()),
    async (req, res) => {
      respondSuccess(
        res,
        await cancelPublicationJob(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.jobId),
        ),
      );
    },
  );
  router.get(
    '/:bookId/document-publication-artifacts/:artifactId',
    zParams(artifactParams),
    async (req, res) => {
      const row = await readPublicationArtifact(
        req.user!.id,
        Number(req.params.bookId),
        String(req.params.artifactId),
      );
      res.setHeader('Cache-Control', 'private, no-store');
      respondSuccess(res, {
        id: row.id,
        publicationId: row.publicationId,
        sha256: row.sha256,
        byteLength: row.byteLength,
        mediaType: row.mediaType,
        filename: row.filename,
        provenance: row.provenance,
      });
    },
  );
  router.get(
    '/:bookId/document-publication-artifacts/:artifactId/download',
    zParams(artifactParams),
    async (req, res) => {
      const row = await readPublicationArtifact(
        req.user!.id,
        Number(req.params.bookId),
        String(req.params.artifactId),
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', row.mediaType);
      res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
      res.setHeader('Content-Length', row.byteLength);
      res.setHeader('X-Content-Sha256', row.sha256);
      res.setHeader('ETag', `"${row.sha256}"`);
      res.send(Buffer.from(row.bytes));
    },
  );
  router.get(
    '/:bookId/document-publication-artifacts/:artifactId/review',
    zParams(artifactParams),
    async (req, res) => {
      const row = await readPublicationArtifact(
        req.user!.id,
        Number(req.params.bookId),
        String(req.params.artifactId),
      );
      const provenance = row.provenance as { fidelity?: { reviewSidecar?: unknown } };
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', `attachment; filename="${row.filename}.review.json"`);
      const bytes = Buffer.from(
        JSON.stringify(provenance.fidelity?.reviewSidecar ?? { schemaVersion: 1, sections: [] }),
      );
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', bytes.length);
      res.setHeader('X-Content-Sha256', createHash('sha256').update(bytes).digest('hex'));
      res.send(bytes);
    },
  );
}
