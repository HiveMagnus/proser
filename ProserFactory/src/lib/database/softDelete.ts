/**
 * Prisma Client extension for transparent soft-delete support.
 *
 * Models opted in: Book, Scene, CodexEntry  (all have a `deletedAt` column).
 *
 * Behaviour:
 *  - `findMany`, `findFirst`, `findUnique`, `findFirstOrThrow`, `count`
 *    automatically add `deletedAt: null` unless the caller explicitly provides
 *    a `deletedAt` filter (e.g., for admin recovery queries).
 *  - `delete` → converted to `update({ data: { deletedAt: new Date() } })`
 *  - `deleteMany` → converted to `updateMany({ data: { deletedAt: new Date() } })`
 *
 * Usage:
 *   import { withSoftDelete } from '@/lib/database/softDelete';
 *   const prisma = withSoftDelete(new PrismaClient());
 */
import { PrismaClient } from '@prisma/client';

/** Models that support soft-delete (must have a `deletedAt` column). */
const SOFT_DELETE_MODELS = new Set(['Book', 'Scene', 'CodexEntry']);

/** Bind soft-delete writes to the delegate of the actual transaction client.
 * Query extensions receive no transaction client; reaching back to the root
 * Prisma client here would commit deletions outside the caller's transaction. */
function transactionBoundDeletes<T extends object>(client: T): T {
  const delegates = new Map<string, object>();
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === '$transaction' && typeof value === 'function') {
        return (...args: unknown[]) => {
          const [action, ...options] = args;
          return typeof action === 'function'
            ? Reflect.apply(value, target, [(tx: object) => action(transactionBoundDeletes(tx)), ...options])
            : Reflect.apply(value, target, args);
        };
      }
      if (typeof property === 'string' && ['book', 'scene', 'codexEntry'].includes(property) && value && typeof value === 'object') {
        const cached = delegates.get(property); if (cached) return cached;
        const delegate = new Proxy(value, {
          get(model, operation) {
            if (operation === 'delete' || operation === 'deleteMany') {
              return (args: Record<string, unknown> = {}) => {
                const method: unknown = Reflect.get(model, operation === 'delete' ? 'update' : 'updateMany', model);
                if (typeof method !== 'function') throw new Error('Missing soft-delete update delegate');
                return Reflect.apply(method, model, [{ ...args, data: { deletedAt: new Date() } }]);
              };
            }
            const member: unknown = Reflect.get(model, operation, model);
            return typeof member === 'function' ? member.bind(model) : member;
          },
        });
        delegates.set(property, delegate); return delegate;
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Inject `deletedAt: null` into a `where` clause unless already specified. */
function injectNotDeleted(where: Record<string, unknown> | undefined): Record<string, unknown> {
  const w = where ?? {};
  if (!('deletedAt' in w)) {
    return { ...w, deletedAt: null };
  }
  return w;
}

/**
 * Wraps a PrismaClient with transparent soft-delete behaviour for
 * opted-in models.
 */
export function withSoftDelete<T extends PrismaClient>(prisma: T): T {
  const extended = prisma.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          if (SOFT_DELETE_MODELS.has(model)) {
            args.where = injectNotDeleted(args.where as Record<string, unknown> | undefined) as typeof args.where;
          }
          return query(args);
        },
        async findFirst({ model, args, query }) {
          if (SOFT_DELETE_MODELS.has(model)) {
            args.where = injectNotDeleted(args.where as Record<string, unknown> | undefined) as typeof args.where;
          }
          return query(args);
        },
        async findFirstOrThrow({ model, args, query }) {
          if (SOFT_DELETE_MODELS.has(model)) {
            args.where = injectNotDeleted(args.where as Record<string, unknown> | undefined) as typeof args.where;
          }
          return query(args);
        },
        async findUnique({ model, args, query }) {
          if (SOFT_DELETE_MODELS.has(model)) {
            // Prisma 7 permits additional predicates beside a unique ID.
            // Include tombstones only through an explicit deletedAt filter.
            args.where = injectNotDeleted(args.where as Record<string, unknown> | undefined) as typeof args.where;
          }
          return query(args);
        },
        async count({ model, args, query }) {
          if (SOFT_DELETE_MODELS.has(model)) {
            args.where = injectNotDeleted(args.where as Record<string, unknown> | undefined);
          }
          return query(args);
        },
      },
    },
  });
  return transactionBoundDeletes(extended) as unknown as T;
}
