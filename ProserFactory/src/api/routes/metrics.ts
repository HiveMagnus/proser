import { Router } from 'express';
import { MetricsController } from '../controllers/metricsController';
import { redisRateLimit } from '../middleware/redisRateLimit';

const router = Router();

// Public ingest endpoint: no auth required
router.post('/ingest', redisRateLimit({
  key: (req) => `metrics:${req.ip || 'unknown'}`,
  limit: 60,
  windowSec: 60,
}), MetricsController.ingest);

export default router;
