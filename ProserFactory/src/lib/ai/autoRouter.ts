import { vllmService } from './vllm';
import logger from '../logger';

/**
 * Standalone Factory mode: there is no external adapter policy service.
 * If an adapter has already been activated locally, preserve it. Otherwise
 * fall back to the base model.
 */
export async function autoActivateAdapter(_genre?: string | null): Promise<string | null> {
  const activeAdapter = vllmService.getActiveAdapterName();
  if (activeAdapter) {
    logger.info({ adapter: activeAdapter }, 'autoRouter: using locally active adapter');
  }
  return activeAdapter ?? null;
}
