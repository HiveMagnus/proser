import type { Response } from 'express';

import type { AuthenticatedRequest } from '@/api/types';
import { respondSuccess } from '@/api/utils/response';
import { ExportArtifactService } from '@/services/exportArtifactService';
import type { ReadExportArtifactOptions } from '@/services/exportArtifactService';

export class ExportArtifactsController {
  static async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    const artifact = await ExportArtifactService.create(
      req.user!.id,
      Number(req.params.bookId),
      req.body,
      req.operationSignal,
    );
    req.operationSignal?.throwIfAborted();
    respondSuccess(res, artifact, 201);
  }

  static async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    respondSuccess(res, await ExportArtifactService.get(req.user!.id, Number(req.params.bookId), req.params.artifactId));
  }

  static async read(req: AuthenticatedRequest, res: Response): Promise<void> {
    respondSuccess(res, await ExportArtifactService.read(
      req.user!.id,
      Number(req.params.bookId),
      req.params.artifactId,
      req.query as unknown as ReadExportArtifactOptions,
    ));
  }

  static async download(req: AuthenticatedRequest, res: Response): Promise<void> {
    const artifact = await ExportArtifactService.download(req.user!.id, Number(req.params.bookId), req.params.artifactId);
    res.download(artifact.path, artifact.manifest.filename);
  }

  static async delete(req: AuthenticatedRequest, res: Response): Promise<void> {
    respondSuccess(res, await ExportArtifactService.delete(req.user!.id, Number(req.params.bookId), req.params.artifactId));
  }
}
