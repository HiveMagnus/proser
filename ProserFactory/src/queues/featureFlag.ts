import { CONFIG } from '../core/config';

export function isBullmqEnabled(): boolean {
  // Default off unless explicitly enabled; support alias FACTORY_RUNNER_ENABLED
  const alias = String(process.env.FACTORY_RUNNER_ENABLED || '').toLowerCase() === 'true';
  return Boolean(CONFIG.USE_BULLMQ) || alias;
}
