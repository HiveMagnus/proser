import { commitPassageOperations, passageOperationCommitSchema, passageReviewQuery, readPassageReviewHistory, commitPassageOperationScopes, passageBookCommitSchema } from "@/documents/passageOperationCommits";
import { commitPassageComment, passageCommentCommitSchema, passageCommentPageQuery, readPassageComment } from "@/documents/passageComments";
import type { Router } from "express";
import { z } from "zod";
import { zBody, zParams, zQuery } from "@/api/middleware/zodValidation";
import { respondSuccess } from "@/api/utils/response";
import { ownedBookBudget } from "@/api/middleware/ownedBookBudget";
import { documentAuthorityEnabled } from "@/documents/capabilities";
import { DocumentError } from "@/documents/errors";
import {
  readDocumentPassage,
  commitDocumentPassage,
  restoreDocumentPassage,
} from "@/documents/passage";
import {
  documentPassageQuery,
  documentPassageCommitSchema,
  documentPassageRestoreSchema,
} from "@/documents/passageValidation";
export function registerDocumentPassageRoutes(router: Router) {
  const params = z.object({
    bookId: z.coerce.number().int().positive(),
    sceneId: z.coerce.number().int().positive(),
  });
  router.use(
    "/:bookId/scenes/:sceneId/document-passages",
    (_req, _res, next) => {
      if (!documentAuthorityEnabled())
        return next(
          new DocumentError(
            "DOCUMENT_AUTHORITY_INACTIVE",
            "Structured document migration is not active.",
            503,
          ),
        );
      next();
    },
  );
  router.post("/:bookId/scenes/:sceneId/document-passages/comments",zParams(params),ownedBookBudget({source:"params",required:true}),(req,_res,next)=>{if(!req.body?.operationId||!req.body?.expectedRevisionId||!req.body?.expectedSceneRevisionId||!req.body?.windowHash)throw new DocumentError("DOCUMENT_PRECONDITION_REQUIRED","Comment preconditions are required.",428);next();},zBody(passageCommentCommitSchema),async(req,res)=>respondSuccess(res,await commitPassageComment(req.user!.id,Number(req.params.bookId),Number(req.params.sceneId),req.body)));
  router.get("/:bookId/scenes/:sceneId/document-passages/comments/:commentId",zParams(params.extend({commentId:z.string().min(1).max(128)})),zQuery(passageCommentPageQuery),ownedBookBudget({source:"params",required:true}),async(req,res)=>{res.setHeader("Cache-Control","private, no-store");respondSuccess(res,await readPassageComment(req.user!.id,Number(req.params.bookId),Number(req.params.sceneId),String(req.params.commentId),passageCommentPageQuery.parse(req.query)));});
  router.post("/:bookId/document-passage-commits",(_req,_res,next)=>{if(!documentAuthorityEnabled())throw new DocumentError("DOCUMENT_AUTHORITY_INACTIVE","Structured authority is inactive.",503);next();},zParams(z.object({bookId:z.coerce.number().int().positive()})),ownedBookBudget({source:"params",required:true}),(req,_res,next)=>{if(!req.body?.operationId||!req.body?.expectedRevisionId)throw new DocumentError("DOCUMENT_PRECONDITION_REQUIRED","Book and operation preconditions are required.",428);next();},zBody(passageBookCommitSchema),async(req,res)=>respondSuccess(res,await commitPassageOperationScopes(req.user!.id,Number(req.params.bookId),req.body)));
  router.get(
    "/:bookId/scenes/:sceneId/document-passages",
    zParams(params),
    zQuery(documentPassageQuery),
    ownedBookBudget({ source: "params", required: true }),
    async (req, res) => {
      const query = documentPassageQuery.parse(req.query);
      res.setHeader("Cache-Control", "private, no-store");
      const window = await readDocumentPassage(
        req.user!.id,
        Number(req.params.bookId),
        Number(req.params.sceneId),
        {
          ...query,
          cursor: { paragraph: query.paragraph, offset: query.offset, ...(query.item!==undefined?{item:query.item}:{}), ...(query.run!==undefined?{run:query.run}:{}) },
        },
      );
      res.setHeader("ETag", `"${window.windowHash}"`);
      respondSuccess(res, window);
    },
  );
  router.post(
    "/:bookId/scenes/:sceneId/document-passages",
    zParams(params),
    ownedBookBudget({ source: "params", required: true }),
    (req, _res, next) => {
      if (
        !req.body?.expectedRevisionId ||
        !req.body?.expectedSceneRevisionId ||
        !req.body?.operationId ||
        !req.body?.windowHash
      )
        throw new DocumentError(
          "DOCUMENT_PRECONDITION_REQUIRED",
          "Book, scene, passage and operation preconditions are required.",
          428,
        );
      next();
    },
    zBody(documentPassageCommitSchema),
    async (req, res) => {
      respondSuccess(
        res,
        await commitDocumentPassage(
          req.user!.id,
          Number(req.params.bookId),
          Number(req.params.sceneId),
          req.body,
        ),
      );
    },
  );
  router.post("/:bookId/scenes/:sceneId/document-passages/operations",zParams(params),ownedBookBudget({source:"params",required:true}),(req,_res,next)=>{if(!req.body?.operationId||!req.body?.expectedRevisionId||!req.body?.expectedSceneRevisionId||!req.body?.windowHash||!req.body?.sourceFrame)throw new DocumentError("DOCUMENT_PRECONDITION_REQUIRED","Operation and exact source preconditions are required.",428);next();},zBody(passageOperationCommitSchema),async(req,res)=>respondSuccess(res,await commitPassageOperations(req.user!.id,Number(req.params.bookId),Number(req.params.sceneId),req.body)));
  router.get("/:bookId/scenes/:sceneId/document-passages/review-history",zParams(params),zQuery(passageReviewQuery),ownedBookBudget({source:"params",required:true}),async(req,res)=>{res.setHeader("Cache-Control","private, no-store");respondSuccess(res,await readPassageReviewHistory(req.user!.id,Number(req.params.bookId),Number(req.params.sceneId),passageReviewQuery.parse(req.query)));});
  router.post(
    "/:bookId/scenes/:sceneId/document-passages/restore",
    zParams(params),
    ownedBookBudget({ source: "params", required: true }),
    (req, _res, next) => {
      if (
        !req.body?.expectedRevisionId ||
        !req.body?.expectedSceneRevisionId ||
        !req.body?.operationId ||
        !req.body?.windowHash
      )
        throw new DocumentError(
          "DOCUMENT_PRECONDITION_REQUIRED",
          "Book, scene, passage and operation preconditions are required.",
          428,
        );
      next();
    },
    zBody(documentPassageRestoreSchema),
    async (req, res) => {
      respondSuccess(
        res,
        await restoreDocumentPassage(
          req.user!.id,
          Number(req.params.bookId),
          Number(req.params.sceneId),
          req.body,
        ),
      );
    },
  );
}
