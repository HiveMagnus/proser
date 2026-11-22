import { DocumentError } from "./errors";
import {
  paragraphsOf,
  visibleParagraph,
  visibleRun,
  paragraphStyle,
  runStyle,
  type ProserDocument,
} from "./model";
import type { FrozenDocumentTarget } from "./proposal-model";
/** Shared scene/story policy: disclose complete blocks, reserve byte-fallback
 * tokenizer capacity and reject oversize targets rather than truncating them. */
export function proposalContextBudget(targets: FrozenDocumentTarget[]) {
  const capacity = Number(
    process.env.DOCUMENT_AI_CONTEXT_TOKENS ??
      process.env.MAX_CONTEXT_TOKENS ??
      32768,
  );
  if (!Number.isSafeInteger(capacity) || capacity < 8192 || capacity > 150000)
    throw new DocumentError(
      "DOCUMENT_CONTEXT_CONFIGURATION_INVALID",
      "Configure a supported document inference context limit.",
      503,
    );
  const maxOutputTokens = Math.min(
    16384,
    Math.max(
      2048,
      targets.reduce(
        (sum, target) => sum + Buffer.byteLength(target.sourceText) * 2,
        2048,
      ),
    ),
  );
  return {
    maxOutputTokens,
    maxPromptBytes: Math.min(100000, capacity - maxOutputTokens - 2048),
  };
}
export function proposalContextBlocks(
  document: ProserDocument,
  targets: FrozenDocumentTarget[],
) {
  const targetIds = new Set(targets.map((target) => target.blockId));
  const paragraphs = paragraphsOf(document).filter((paragraph) =>
    visibleParagraph(paragraph, document.changes, "final"),
  );
  return {
    blocks: paragraphs
      .filter((paragraph) => targetIds.has(paragraph.id))
      .map((paragraph) => ({
        ...paragraph,
        style: paragraphStyle(paragraph, document.changes, "final"),
        runs: paragraph.runs
          .filter((run) => visibleRun(run, document.changes, "final"))
          .map((run) => ({
            ...run,
            style: runStyle(run, document.changes, "final"),
          })),
      })),
    omittedBlockIds: paragraphs
      .filter((paragraph) => !targetIds.has(paragraph.id))
      .map((paragraph) => paragraph.id),
  };
}
