import { Router } from 'express';
import { authenticateRequest } from '../middleware/auth';
import { respondSuccess } from '../utils/response';
import { STORY_ARCHETYPES } from '../../config/storyArchetypes';

const router = Router();
router.use(authenticateRequest);

// The story archetypes Factory knows; a book's storyArchetypeKey names one of them.
router.get('/archetypes', (_req, res) => {
  respondSuccess(res, { archetypes: STORY_ARCHETYPES });
});

export default router;
