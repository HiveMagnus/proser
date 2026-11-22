import { claimNovaResource } from "@/api/middleware/novaGrant";
import type { AuthenticatedRequest } from "@/api/types";
import type { Router } from "express";
import { z } from "zod";
import { zBody, zParams } from "@/api/middleware/zodValidation";
import { respondSuccess } from "@/api/utils/response";
import { ownedBookBudget } from "@/api/middleware/ownedBookBudget";
import { expensiveRouteLimit } from "@/api/middleware/expensiveRouteLimit";
import { documentAuthorityEnabled } from "@/documents/capabilities";
import { DocumentError } from "@/documents/errors";
import {
  listCampaigns,
  readCampaign,
  saveCampaign,
  launchCampaignAnalysis,
  campaignDecision,
  campaignReceipt,
} from "@/documents/campaigns";
import {
  campaignMutationSchema,
  campaignAnalysisSchema,
  campaignDecisionSchema,
} from "@/documents/campaignValidation";
export function registerRevisionCampaignRoutes(router: Router) {
  const base = "/:bookId/revision-campaigns";
  const book = z.object({ bookId: z.coerce.number().int().positive() });
  const campaign = book.extend({ campaignId: z.string().uuid() });
  router.use(base, (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next(
      documentAuthorityEnabled()
        ? undefined
        : new DocumentError(
            "DOCUMENT_AUTHORITY_INACTIVE",
            "Saved document authority is required for revision campaigns.",
            503,
          ),
    );
  });
  router.get(base, zParams(book), async (req, res) =>
    respondSuccess(
      res,
      await listCampaigns(req.user!.id, Number(req.params.bookId)),
    ),
  );
  router.get(
    base + "/operations/:operationId",
    zParams(book.extend({ operationId: z.string().uuid() })),
    async (req, res) =>
      respondSuccess(
        res,
        await campaignReceipt(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.operationId),
        ),
      ),
  );
  router.post(
    base,
    zParams(book),
    zBody(campaignMutationSchema),
    async (req, res) =>
      respondSuccess(
        res,
        await saveCampaign(
          req.user!.id,
          Number(req.params.bookId),
          undefined,
          req.body,
        ),
        201,
      ),
  );
  router.get(
    base + "/:campaignId/plans/:planId",
    zParams(campaign.extend({ planId: z.string().uuid() })),
    async (req, res) =>
      respondSuccess(
        res,
        await readCampaign(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.campaignId),
          String(req.params.planId),
        ),
      ),
  );
  router.get(base + "/:campaignId", zParams(campaign), async (req, res) =>
    respondSuccess(
      res,
      await readCampaign(
        req.user!.id,
        Number(req.params.bookId),
        String(req.params.campaignId),
      ),
    ),
  );
  router.patch(
    base + "/:campaignId",
    zParams(campaign),
    zBody(campaignMutationSchema),
    async (req, res) =>
      respondSuccess(
        res,
        await saveCampaign(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.campaignId),
          req.body,
        ),
      ),
  );
  router.post(
    base + "/:campaignId/analyses",
    zParams(campaign),
    zBody(campaignAnalysisSchema),
    ownedBookBudget({ source: "params", required: true }),
    expensiveRouteLimit("revisionCampaignAnalysis"),
    async (req, res) => {
      const receipt = await launchCampaignAnalysis(
        req.user!.id,
        Number(req.params.bookId),
        String(req.params.campaignId),
        req.body,
      );
      await claimNovaResource(
        req as AuthenticatedRequest,
        "workflow",
        String((receipt as Record<string, unknown>).runId),
      );
      respondSuccess(res, receipt, 202);
    },
  );
  router.post(
    base + "/:campaignId/plans/:planId/decisions",
    zParams(campaign.extend({ planId: z.string().uuid() })),
    zBody(campaignDecisionSchema),
    async (req, res) =>
      respondSuccess(
        res,
        await campaignDecision(
          req.user!.id,
          Number(req.params.bookId),
          String(req.params.campaignId),
          String(req.params.planId),
          req.body,
        ),
      ),
  );
}
