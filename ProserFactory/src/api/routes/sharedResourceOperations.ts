import { Router } from 'express';
import { authenticateRequest } from '@/api/middleware/auth';
import type { AuthenticatedRequest } from '@/api/types';
import { respondError } from '@/api/utils/response';
import { SharedResourceError, sharedResourceOperationView } from '@/services/sharedResourceService';

const router = Router();
router.use(authenticateRequest);
router.get('/:operationId', async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.novaGrant) return respondError(res, 'FORBIDDEN', 'Shared resource recovery requires signed Nova authority.', 403);
    if (!req.user?.id) return respondError(res, 'FORBIDDEN', 'Shared resource recovery requires an owner.', 403);
    const view = await sharedResourceOperationView(req.params.operationId, req.novaGrant, req.user.id);
    if (!view) return respondError(res, 'NOT_FOUND', 'Shared resource operation was not found.', 404);
    return res.json({ success: true, ...view });
  } catch (error) {
    if (error instanceof SharedResourceError) return respondError(res, 'NOT_FOUND', 'The operation is outside this signed recovery authority.', 404, { code: error.code });
    throw error;
  }
});
export default router;
