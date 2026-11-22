import { createHash } from 'node:crypto';

import { SceneProseService } from '@/services/sceneProseService';
import type { DocumentProposalProviderResult } from '@/documents/proposal-model';

import type { EditorialPassDefinition } from '../contracts';
import { placeholderFailures } from '../detectors/coreDetectors';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface GeneratedCandidate {
  text: string;
  model?: string;
  recipeVersion: string;
  samplingHash: string;
  ragHash: string;
  valid: boolean;
  validationFailures: string[];
  provenance?: DocumentProposalProviderResult['provenance'];
}

export class CandidateGenerator {
  private readonly prose = new SceneProseService();

  async generate(input: {
    original: string;
    surroundingContext: string;
    objective: string;
    pass: EditorialPassDefinition;
    protectedElements: string[];
    model?: string;
    maximumEditPercent: number;
    signal?: AbortSignal;
    variant?: number;
  }): Promise<GeneratedCandidate> {
    const instruction = [
      `Editorial pass: ${input.pass.displayName} ${input.pass.version}.`,
      `Objective: ${input.objective}`,
      `Revise only the supplied target passage. Preserve meaning and every protected fact.`,
      `May change: ${input.pass.mayChange.join(', ') || 'nothing beyond the exact objective'}.`,
      `Must preserve: ${[...input.pass.mustPreserve, ...input.protectedElements].join(', ')}.`,
      `Return replacement prose only. No commentary, markdown, continuation, or labels.`,
      `Context (do not rewrite): ${input.surroundingContext.slice(0, 1_500)}`,
      input.variant ? `Produce an independent alternative numbered ${input.variant}.` : '',
    ].filter(Boolean).join('\n');
    const result = await this.prose.reviewProse(input.original, {
      maxEditPct: input.maximumEditPercent,
      instruction,
    }, {
      selectedModel: input.model,
      retries: 1,
      noTransportReplay: true,
      timeoutMs: 180_000,
      signal: input.signal,
    });
    const failures = placeholderFailures(result.revised);
    return {
      text: result.revised,
      model: result.model,
      recipeVersion: input.pass.candidateRecipe ?? 'none',
      samplingHash: hash({ params: result.provenance?.params, profile: 'revision', variant: input.variant ?? 1 }),
      provenance: result.provenance,
      ragHash: hash({ context: input.surroundingContext.slice(0, 1_500) }),
      valid: Boolean(result.revised.trim()) && failures.length === 0,
      validationFailures: failures,
    };
  }
}
