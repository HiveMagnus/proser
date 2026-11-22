/**
 * AuditLog service — records significant user actions for traceability.
 *
 * Usage:
 *   import { auditLog } from '@/services/auditLogService';
 *   await auditLog.record(userId, 'delete', 'book', bookId, { title });
 */
import { databaseService } from '@/lib/database';
import type { Prisma } from '@prisma/client';
import logger from '@/lib/logger';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'generate'
  | 'export'
  | 'workflow_start'
  | 'workflow_complete';

export type AuditEntityType =
  | 'book'
  | 'scene'
  | 'codex_entry'
  | 'act'
  | 'chapter'
  | 'note'
  | 'image'
  | 'workflow_run';

interface AuditEntry {
  userId: number;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: number;
  metadata?: Prisma.InputJsonValue;
}

class AuditLogService {
  /**
   * Record an audit event. Failures are logged but never throw — audit
   * logging must not break the main request flow.
   */
  async record(
    userId: number,
    action: AuditAction,
    entityType: AuditEntityType,
    entityId?: number,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await databaseService.client.auditLog.create({
        data: {
          userId,
          action,
          entityType,
          entityId,
          metadata: metadata ?? undefined,
        },
      });
    } catch (err) {
      logger.warn({ err, userId, action, entityType, entityId }, 'Failed to write audit log');
    }
  }

  /**
   * Convenience: record a batch of entries in a single roundtrip.
   */
  async recordBatch(entries: AuditEntry[]): Promise<void> {
    try {
      await databaseService.client.auditLog.createMany({
        data: entries.map((e) => ({
          userId: e.userId,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          metadata: e.metadata ?? undefined,
        })),
      });
    } catch (err) {
      logger.warn({ err, count: entries.length }, 'Failed to write audit log batch');
    }
  }

  /**
   * Query recent audit entries for a user (admin/debug use).
   */
  async listForUser(userId: number, limit = 50) {
    return databaseService.client.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

export const auditLog = new AuditLogService();
