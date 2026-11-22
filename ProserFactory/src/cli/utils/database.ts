import { databaseService } from '@/lib/database';
import { output } from './output';

/**
 * Initialize database connection for CLI
 */
export async function initDatabase(): Promise<void> {
  try {
    await databaseService.connect();
  } catch (error) {
    output.error('Failed to connect to database');
    throw error;
  }
}

/**
 * Close database connection
 */
export async function closeDatabase(): Promise<void> {
  if (!databaseService.isReady) {
    return;
  }
  await databaseService.disconnect();
}

/**
 * Get Prisma client instance
 */
export function getDb() {
  return databaseService.client;
}
