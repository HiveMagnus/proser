import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { authenticateRequest } from '../middleware/auth';
import { zBody } from '../middleware/zodValidation';
import { updateSettingsBody } from '../schemas/settings';
import { respondSuccess } from '../utils/response';
import { userSettingsService } from '../../services/userSettingsService';
import logger from '../../lib/logger';

const router = Router();

router.use(authenticateRequest);

router.get('/', (req: AuthenticatedRequest, res: Response): void => {
  const user = req.user!;
  const settings = userSettingsService.getForUser({
    id: user.id,
    username: user.username,
  });

  logger.info({ userId: user.id }, 'Retrieved user settings');
  respondSuccess(res, settings);
});

router.put('/', zBody(updateSettingsBody), (req: AuthenticatedRequest, res: Response): void => {
  const user = req.user!;
  const body = req.body as Parameters<typeof userSettingsService.updateForUser>[1];
  const settings = userSettingsService.updateForUser({
    id: user.id,
    username: user.username,
  }, body);

  logger.info({ userId: user.id }, 'Updated user settings');
  respondSuccess(res, settings);
});

export default router;
