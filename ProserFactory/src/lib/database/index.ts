import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import logger from '../logger';
import { DatabaseError } from '../errors';
import { withSoftDelete } from './softDelete';

export function resolveDatabasePoolSize(value = process.env.DATABASE_POOL_SIZE): number {
  const parsed = Number(value ?? 20);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 2), 100) : 20;
}

export class DatabaseService {
  private prisma: PrismaClient;
  private isConnected = false;

  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
      throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
    }

    const adapter = new PrismaPg({
      connectionString: url,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: resolveDatabasePoolSize(),
    });
    this.prisma = withSoftDelete(new PrismaClient({
      adapter,
      log: []
    }));
  }

  async connect(): Promise<void> {
    try {
      await this.prisma.$connect();
      this.isConnected = true;
      logger.info('Database connected successfully');
    } catch (error) {
      this.isConnected = false;
      throw new DatabaseError(error as Error, 'Failed to connect to database');
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.prisma.$disconnect();
      this.isConnected = false;
      logger.info('Database disconnected successfully');
    } catch (error) {
      logger.error({ error }, 'Error disconnecting from database');
      throw new DatabaseError(error as Error, 'Failed to disconnect from database');
    }
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; details?: { message: string } }> {
    try {
      // Simple query to check if database is responsive
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'healthy' };
    } catch (error) {
      logger.error({ error }, 'Database health check failed');
      return { 
        status: 'unhealthy', 
        details: { message: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  get client(): PrismaClient {
    if (!this.isConnected) {
      throw new DatabaseError(new Error('Database not connected'), 'Call connect() first');
    }
  return this.prisma;
  }

  get isReady(): boolean {
    return this.isConnected;
  }
}

// Export singleton instance
export const databaseService = new DatabaseService();

export async function withDatabaseBusyRetry<T>(operation: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      const message = String(error);
      const retryable = [
        'P2034',
        '40001',
        '40P01',
        '55P03',
        'Operation has timed out',
        'Transaction already closed',
        'Connection terminated unexpectedly',
      ].some((part) => message.includes(part));
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1) ** 2));
    }
  }
  throw lastError;
}

// Export Prisma types for use in other modules
export type {
  User,
  Book,
  Act,
  Chapter,
  Scene,
  CodexEntry,
  Note,
  GenerationHistory,
} from '@prisma/client';

// Export Prisma utility types
export type { Prisma } from '@prisma/client';
