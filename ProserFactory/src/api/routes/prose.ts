import { Router } from 'express';

import { authenticateRequest } from '../middleware/auth';
import { zParams } from '../middleware/zodValidation';
import { ProseController } from '../controllers/prose';
import { traceIdParams } from '../schemas/prose';

const router = Router();

router.use(authenticateRequest);

router.get('/traces/:traceId',
  zParams(traceIdParams),
  ProseController.getTrace,
);

router.get('/traces/:traceId/stream',
  zParams(traceIdParams),
  ProseController.streamTrace,
);

export default router;
