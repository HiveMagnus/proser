import type { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { zBody, zParams, zQuery } from "@/api/middleware/zodValidation";
import { ownedBookBudget } from "@/api/middleware/ownedBookBudget";
import { expensiveRouteLimit } from "@/api/middleware/expensiveRouteLimit";
import { respondSuccess } from "@/api/utils/response";
import { documentAuthorityEnabled } from "@/documents/capabilities";
import { DocumentError } from "@/documents/errors";
import {
  createStoryDiscussion,
  readStoryDiscussion,
  requestStoryProposal,
  readStoryProposal,
  cancelStoryProposal,
  revalidateStoryProposal,
  applyStoryProposal,
  commitStoryDraft,
} from "@/documents/storyProposals";
import {
  ownedStorySource,
  assertStoryBookOwner,
} from "@/documents/storyProposalSources";
import { documentProposalRequestSchema } from "@/documents/proposalValidation";
import {
  documentStoryDiscussionSchema,
  documentStoryProposalRevalidateSchema,
  documentStoryProposalApplySchema,
  documentStoryDraftCommitSchema,
} from "@/documents/storyProposalValidation";
import { databaseService } from "@/lib/database";
const book = z.object({ bookId: z.coerce.number().int().positive() });
const story = book.extend({
  storyId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.:-]+$/),
});
const discussion = book.extend({ discussionId: z.string().uuid() }),
  proposal = book.extend({ proposalId: z.string().uuid() });
function preconditions(req: Request, _res: Response, next: NextFunction) {
  if (
    !req.body?.operationId ||
    !req.body?.expectedRevisionId ||
    !req.body?.expectedLayoutRevisionId
  )
    throw new DocumentError(
      "DOCUMENT_PRECONDITION_REQUIRED",
      "Book/layout source revisions and operation ID are required.",
      428,
    );
  next();
}
export function registerDocumentStoryProposalRoutes(router: Router) {
  router.use(
    [
      "/:bookId/document-story-discussions",
      "/:bookId/document-story-proposals/:proposalId",
      "/:bookId/layout-stories/:storyId/document",
      "/:bookId/layout-stories/:storyId/document-draft-commits",
    ],
    (_req, _res, next) => {
      if (!documentAuthorityEnabled())
        return next(
          new DocumentError(
            "DOCUMENT_AUTHORITY_INACTIVE",
            "Structured document authority is inactive.",
            503,
          ),
        );
      next();
    },
  );
  router.get(
    "/:bookId/layout-stories/:storyId/document",
    zParams(story),
    zQuery(z.object({ bookRevisionId: z.string().uuid().optional() }).strict()),
    ownedBookBudget({ source: "params", required: true }),
    async (req, res) => {
      const source = await ownedStorySource(
        databaseService.client,
        req.user!.id,
        Number(req.params.bookId),
        String(req.params.storyId),
        req.query.bookRevisionId as string | undefined,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader(
        "ETag",
        `"${source.layoutRevisionId}:${source.contentHash}"`,
      );
      respondSuccess(res, {
        sourceKind: "layout-story",
        bookId: source.bookId,
        storyId: source.storyId,
        bookRevisionId: source.bookRevisionId,
        layoutRevisionId: source.layoutRevisionId,
        layoutContentHash: source.layoutContentHash,
        contentHash: source.contentHash,
        ownerContextHash: source.ownerContextHash,
        document: source.document,
        styles: source.layout.styles,
      });
    },
  );
  router.post(
    "/:bookId/layout-stories/:storyId/document-draft-commits",
    zParams(story),
    ownedBookBudget({ source: "params", required: true }),
    preconditions,
    zBody(documentStoryDraftCommitSchema),
    async (req, res) =>
      respondSuccess(
        res,
        await commitStoryDraft(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.storyId),
          req.body,
        ),
      ),
  );
  const query = z
    .object({
      storyId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z0-9_.:-]+$/),
    })
    .strict();
  router.get(
    "/:bookId/document-story-discussions",
    zParams(book),
    zQuery(query),
    ownedBookBudget({ source: "params", required: true }),
    async (req, res) => {
      await assertStoryBookOwner(
        databaseService.client,
        req.user!.id,
        Number(req.params.bookId),
      );
      const rows =
        await databaseService.client.documentStoryDiscussion.findMany({
          where: {
            bookId: Number(req.params.bookId),
            userId: req.user!.id,
            storyId: String(req.query.storyId),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 10,
          select: {
            id: true,
            bookId: true,
            storyId: true,
            sessionId: true,
            snapshot: true,
            createdAt: true,
          },
        });
      res.setHeader("Cache-Control", "private, no-store");
      respondSuccess(res, rows);
    },
  );
  router.post(
    "/:bookId/document-story-discussions",
    zParams(book),
    ownedBookBudget({ source: "params", required: true }),
    preconditions,
    zBody(documentStoryDiscussionSchema),
    async (req, res) =>
      respondSuccess(
        res,
        await createStoryDiscussion(
          req.user!.id,
          Number(req.params.bookId),
          req.body,
        ),
      ),
  );
  router.get(
    "/:bookId/document-story-discussions/:discussionId",
    zParams(discussion),
    async (req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      respondSuccess(
        res,
        await readStoryDiscussion(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.discussionId),
        ),
      );
    },
  );
  router.get(
    "/:bookId/document-story-discussions/:discussionId/proposals",
    zParams(discussion),
    async (req, res) => {
      await readStoryDiscussion(
        req.user!.id,
        Number(req.params.bookId),
        String(req.params.discussionId),
      );
      const rows = await databaseService.client.documentStoryProposal.findMany({
        where: {
          discussionId: String(req.params.discussionId),
          userId: req.user!.id,
          bookId: Number(req.params.bookId),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
        select: { id: true, status: true, createdAt: true },
      });
      res.setHeader("Cache-Control", "private, no-store");
      respondSuccess(res, rows);
    },
  );
  router.post(
    "/:bookId/document-story-discussions/:discussionId/proposals",
    zParams(discussion),
    ownedBookBudget({ source: "params", required: true }),
    zBody(documentProposalRequestSchema),
    expensiveRouteLimit("documentProposal"),
    async (req, res) =>
      respondSuccess(
        res,
        await requestStoryProposal(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.discussionId),
          req.body,
        ),
      ),
  );
  router.get(
    "/:bookId/document-story-proposals/:proposalId",
    zParams(proposal),
    async (req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      respondSuccess(
        res,
        await readStoryProposal(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.proposalId),
        ),
      );
    },
  );
  router.post(
    "/:bookId/document-story-proposals/:proposalId/cancel",
    zParams(proposal),
    zBody(z.object({}).strict()),
    async (req, res) =>
      respondSuccess(
        res,
        await cancelStoryProposal(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.proposalId),
        ),
      ),
  );
  router.post(
    "/:bookId/document-story-proposals/:proposalId/revalidate",
    zParams(proposal),
    preconditions,
    zBody(documentStoryProposalRevalidateSchema),
    async (req, res) =>
      respondSuccess(
        res,
        await revalidateStoryProposal(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.proposalId),
          req.body,
        ),
      ),
  );
  router.post(
    "/:bookId/document-story-proposals/:proposalId/apply",
    zParams(proposal),
    preconditions,
    zBody(documentStoryProposalApplySchema),
    async (req, res) =>
      respondSuccess(
        res,
        await applyStoryProposal(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.proposalId),
          req.body,
        ),
      ),
  );
}
