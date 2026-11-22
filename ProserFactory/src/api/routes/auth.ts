/**
 * Auth routes — internal server-to-server endpoints.
 *
 * These are called by the Next.js UI during the NextAuth sign-in flow
 * (before a user JWT exists) using a shared `INTERNAL_API_SECRET`.
 */
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { authenticateInternal } from "../middleware/auth";
import { respondSuccess, respondError, ErrorCodes } from "../utils/response";
import { databaseService, withDatabaseBusyRetry } from "../../lib/database";
import logger from "../../lib/logger";
import { runRateLimitDiagnostic } from "../middleware/redisRateLimit";

const router = Router();

// All auth routes require the internal shared secret
router.use(authenticateInternal);

/** Deterministic, isolated proof that the production Redis limiter enforces its contract. */
router.post(
  "/diagnostics/rate-limit",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      respondSuccess(res, await runRateLimitDiagnostic());
    } catch (error) {
      logger.error({ error }, "Rate-limit diagnostic failed");
      respondError(res, ErrorCodes.CAPACITY_UNAVAILABLE, "Rate-limit diagnostic unavailable", 503);
    }
  },
);

/**
 * POST /api/auth/sync-user
 *
 * Upserts a user record during NextAuth sign-in.
 * Body: { githubId: string, username: string, email?: string, avatarUrl?: string }
 * Returns: { id: number, githubId: string, username: string, email?: string, avatarUrl?: string }
 */
router.post(
  "/sync-user",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { githubId, username, email, avatarUrl } = req.body ?? {};

      if (!githubId || typeof githubId !== "string") {
        respondError(
          res,
          ErrorCodes.VALIDATION_FAILED,
          "githubId is required (string)",
          400,
        );
        return;
      }
      if (!username || typeof username !== "string") {
        respondError(
          res,
          ErrorCodes.VALIDATION_FAILED,
          "username is required (string)",
          400,
        );
        return;
      }

      const prisma = databaseService.client;

      // Try to find existing user by githubId, then upsert
      const user = await prisma.user.upsert({
        where: { githubId: String(githubId) },
        update: {
          username,
          ...(email !== undefined && { email }),
          ...(avatarUrl !== undefined && { avatarUrl }),
        },
        create: {
          githubId: String(githubId),
          username,
          email: email || null,
          avatarUrl: avatarUrl || null,
        },
      });

      logger.info(
        { userId: user.id, githubId: user.githubId },
        "User synced via internal auth",
      );

      respondSuccess(res, {
        id: user.id,
        githubId: user.githubId,
        username: user.username,
        email: user.email ?? undefined,
        avatarUrl: user.avatarUrl ?? undefined,
      });
    } catch (error) {
      logger.error({ error }, "Failed to sync user");
      respondError(res, ErrorCodes.INTERNAL_ERROR, "Failed to sync user", 500);
    }
  },
);

async function hardDeleteTestBooks(
  prisma: Prisma.TransactionClient,
  bookIds: number[],
): Promise<void> {
  if (!bookIds.length) return;
  const ids = Prisma.join(bookIds);

  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM prose_actions WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM prose_compare_cards WHERE prose_trace_id IN (SELECT id FROM prose_traces WHERE book_id IN (${ids}))`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM prose_findings WHERE prose_trace_id IN (SELECT id FROM prose_traces WHERE book_id IN (${ids}))`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM prose_trace_candidates WHERE prose_trace_id IN (SELECT id FROM prose_traces WHERE book_id IN (${ids}))`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM prose_traces WHERE book_id IN (${ids})`,
  );

  // WorkflowRun is the v1 orchestration root. Its task graph, events,
  // checkpoints, quality findings, ledgers, and publication package cascade.
  await prisma.workflowRun.deleteMany({ where: { bookId: { in: bookIds } } });
  await prisma.manuscriptRevision.deleteMany({ where: { bookId: { in: bookIds } } });

  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM scene_memory_events WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM character_states WHERE book_id IN (${ids})`,
  );
  await prisma.plotThreadEvidence.deleteMany({ where: { bookId: { in: bookIds } } });
  await prisma.plotThreadReview.deleteMany({ where: { bookId: { in: bookIds } } });
  await prisma.plotThreadMutation.deleteMany({ where: { bookId: { in: bookIds } } });
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM plot_threads WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM skill_runs WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM rag_chunks WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM rag_eval_results WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM images WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM notes WHERE book_id IN (${ids})`,
  );

  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM scene_codex_usage
    WHERE codex_id IN (SELECT id FROM codex_entries WHERE book_id IN (${ids}))
       OR scene_id IN (
         SELECT scenes.id
         FROM scenes
         JOIN chapters ON chapters.id = scenes.chapter_id
         JOIN acts ON acts.id = chapters.act_id
         WHERE acts.book_id IN (${ids})
       )
  `);
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM codex_entries WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM scenes
    WHERE chapter_id IN (
      SELECT chapters.id
      FROM chapters
      JOIN acts ON acts.id = chapters.act_id
      WHERE acts.book_id IN (${ids})
    )
  `);
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM chapters WHERE act_id IN (SELECT id FROM acts WHERE book_id IN (${ids}))`,
  );
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM acts WHERE book_id IN (${ids})`,
  );
  await prisma.$executeRaw(Prisma.sql`DELETE FROM books WHERE id IN (${ids})`);
}

/**
 * DELETE /api/auth/test-users/:githubId
 *
 * Internal cleanup endpoint for smoke/integration test users. It is deliberately
 * restricted to known test prefixes so the internal secret cannot be used to
 * delete real user accounts through this maintenance path.
 */
router.delete(
  "/test-users/:githubId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const githubId = decodeURIComponent(String(req.params.githubId || ""));
      const allowedTestUser = [
        "smoke-",
        "jest-",
        "iam:proser-e2e-",
        "iam:proser-release-",
      ].some((prefix) => githubId.startsWith(prefix));

      if (!githubId) {
        respondError(
          res,
          ErrorCodes.VALIDATION_FAILED,
          "githubId is required",
          400,
        );
        return;
      }

      if (!allowedTestUser) {
        respondError(
          res,
          ErrorCodes.FORBIDDEN,
          "Only recognized smoke, Jest, and Proser release test users can be deleted",
          403,
        );
        return;
      }

      const prisma = databaseService.client;
      const deleted = await withDatabaseBusyRetry(() => prisma.$transaction(async (tx) => {
        const users = (await tx.$queryRaw(Prisma.sql`
        SELECT id FROM users WHERE github_id = ${githubId}
      `)) as Array<{ id: number }>;
        const userIds = users.map((user) => user.id);
        if (!userIds.length) return 0;

        const userIdList = Prisma.join(userIds);
        const books = (await tx.$queryRaw(Prisma.sql`
        SELECT id FROM books WHERE user_id IN (${userIdList})
      `)) as Array<{ id: number }>;
        await hardDeleteTestBooks(
          tx,
          books.map((book) => book.id),
        );
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM generation_history WHERE user_id IN (${userIdList})`,
        );
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM images WHERE user_id IN (${userIdList})`,
        );
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM audit_log WHERE user_id IN (${userIdList})`,
        );
        return tx.$executeRaw(
          Prisma.sql`DELETE FROM users WHERE id IN (${userIdList})`,
        );
      }));

      logger.info(
        { githubId, deleted },
        "Test user cleanup requested via internal auth",
      );
      respondSuccess(res, { deleted });
    } catch (error) {
      logger.error(
        { error, githubId: req.params.githubId },
        "Failed to clean up test user",
      );
      respondError(
        res,
        ErrorCodes.INTERNAL_ERROR,
        "Failed to clean up test user",
        500,
      );
    }
  },
);

export default router;
