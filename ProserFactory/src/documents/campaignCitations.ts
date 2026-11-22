import { createHash } from "node:crypto";
import { interpolatePromptByKey } from "@/prompts/service";
import { canonicalDocument } from "./model";
import { DocumentError } from "./errors";
import type { CampaignCitation, CampaignConstraints } from "./campaign-model";
export const CAMPAIGN_RECIPE_VERSION = "1.2.1";
/** Protection baselines remain readable during scans, but their historical
 * addresses must not enter the catalog of selectable current-source citations. */
export function campaignScanRules(constraints: CampaignConstraints) {
  const describe = (rules: CampaignConstraints["facts"]) =>
    rules.map((rule) => ({
      text: rule.text,
      historicalPassages: rule.citations.map((source) => source.quote),
    }));
  return { facts: describe(constraints.facts), voice: describe(constraints.voice) };
}
function citation(value: unknown): value is CampaignCitation {
  const item = value as Partial<CampaignCitation> | null;
  return Boolean(
    item &&
    typeof item === "object" &&
    typeof item.quote === "string" &&
    typeof item.blockId === "string" &&
    typeof item.sceneRevisionId === "string" &&
    Number.isSafeInteger(item.sceneId) &&
    Number.isSafeInteger(item.from) &&
    Number.isSafeInteger(item.to),
  );
}
/** The model selects immutable server-issued addresses. It never computes
 * offsets and the server never locates a target by searching for a quotation. */
export function campaignCitationCatalog(context: unknown) {
  const entries = new Map<string, CampaignCitation>();
  const add = (value: CampaignCitation) => {
    const proof = {
      sceneId: value.sceneId,
      sceneRevisionId: value.sceneRevisionId,
      blockId: value.blockId,
      from: value.from,
      to: value.to,
      quote: value.quote,
    };
    const citationId =
      "c-" +
      createHash("sha256")
        .update(canonicalDocument(proof))
        .digest("hex")
        .slice(0, 32);
    const prior = entries.get(citationId);
    if (prior && canonicalDocument(prior) !== canonicalDocument(proof))
      throw new DocumentError(
        "REVISION_CAMPAIGN_CITATION_INVALID",
        "Citation reference collision.",
        409,
      );
    entries.set(citationId, proof);
    return { citationId };
  };
  const visit = (value: unknown): unknown => {
    if (citation(value)) {
      if (value.quote.length <= 4000) return add(value);
      const parts: Array<{ citationId: string }> = [];
      let text = "",
        from = value.from;
      const flush = () => {
        parts.push(
          add({ ...value, from, to: from + text.length, quote: text }),
        );
        from += text.length;
        text = "";
      };
      for (const { segment } of new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      }).segment(value.quote)) {
        if (Buffer.byteLength(segment) > 2000)
          throw new DocumentError(
            "REVISION_CAMPAIGN_BUDGET_LIMIT",
            "An evidence grapheme exceeds the citation catalog budget.",
            413,
          );
        if (Buffer.byteLength(text + segment) > 2000) flush();
        text += segment;
      }
      if (text) flush();
      return {
        sceneId: value.sceneId,
        sceneRevisionId: value.sceneRevisionId,
        blockId: value.blockId,
        from: value.from,
        to: value.to,
        ranges: parts,
      };
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item)]),
      );
    return value;
  };
  const compact = visit(context);
  return {
    entries,
    promptContext: {
      context: compact,
      citationCatalog: [...entries].map(([citationId, source]) => ({
        citationId,
        ...source,
      })),
    },
  };
}
export function campaignPrompt(task: string, context: unknown) {
  return interpolatePromptByKey("revision-campaign", {
    task,
    context: JSON.stringify(campaignCitationCatalog(context).promptContext),
  });
}
export function resolveCampaignCitations(
  raw: string,
  context: unknown,
): unknown {
  const { entries } = campaignCitationCatalog(context);
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      if (
        Object.keys(item).length === 1 &&
        typeof item.citationId === "string"
      ) {
        const proof = entries.get(item.citationId);
        if (!proof)
          throw new DocumentError(
            "REVISION_CAMPAIGN_CITATION_INVALID",
            "The model selected an undisclosed citation reference.",
            422,
          );
        return proof;
      }
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, visit(child)]),
      );
    }
    return value;
  };
  return visit(JSON.parse(raw));
}
