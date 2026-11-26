import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { authenticateRequest, revokeUserSessions } from '../middleware/auth';
import { zBody } from '../middleware/zodValidation';
import { updateSettingsBody } from '../schemas/settings';
import { ErrorCodes, respondError, respondSuccess } from '../utils/response';
import { userSettingsService, type UserSettingsPatch } from '../../services/userSettingsService';
import logger from '../../lib/logger';
import { CONFIG, PROSER_VERSION } from '../../core/config';

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

// The release this installation runs, for the Settings page.
router.get('/about', (_req: AuthenticatedRequest, res: Response): void => {
  respondSuccess(res, { version: PROSER_VERSION, revision: CONFIG.GIT_COMMIT || CONFIG.COMMIT_SHA || null });
});

router.put('/', zBody(updateSettingsBody), (req: AuthenticatedRequest, res: Response): void => {
  const user = req.user!;
  // Only the known sections are stored; unknown sections are ignored.
  const { profile, writing } = req.body as UserSettingsPatch;
  const settings = userSettingsService.updateForUser({
    id: user.id,
    username: user.username,
  }, { profile, writing });

  logger.info({ userId: user.id }, 'Updated user settings');
  respondSuccess(res, settings);
});

// Sign out everywhere: every browser session of this account signed in before
// now stops working, including the one making this request.
router.post('/sessions/revoke', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (req.authActor) {
    respondError(res, ErrorCodes.FORBIDDEN, 'Only the account owner can revoke sessions', 403);
    return;
  }
  const revokedBefore = await revokeUserSessions(req.user!.id);
  logger.info({ userId: req.user!.id }, 'Revoked user sessions');
  respondSuccess(res, { revokedBefore: revokedBefore.toISOString() });
});

export default router;
