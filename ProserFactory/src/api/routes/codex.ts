import { Router } from 'express';
import { CodexController } from '../controllers/codex';
import { authenticateRequest } from '../middleware/auth';
import { zBody, zParams } from '../middleware/zodValidation';
import { codexIdParams, updateCodexBody } from '../schemas/codex';

const router = Router();

// All codex routes require authentication
router.use(authenticateRequest);

// GET /api/codex/:id - Get specific codex entry
router.get('/:id',
  zParams(codexIdParams),
  CodexController.getCodexEntry
);

// PUT /api/codex/:id - Update codex entry
router.put('/:id',
  zParams(codexIdParams),
  zBody(updateCodexBody),
  CodexController.updateCodexEntry
);

// DELETE /api/codex/:id - Delete codex entry
router.delete('/:id',
  zParams(codexIdParams),
  CodexController.deleteCodexEntry
);

export default router;
