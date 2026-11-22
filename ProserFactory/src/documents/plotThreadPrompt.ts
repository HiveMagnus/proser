import { interpolatePromptByKey } from '@/prompts/service';
import { proposalContextBudget } from './proposalContext';
import { DocumentError } from './errors';
import type { PlotThreadReviewSnapshot } from './plot-thread-model';
export function plotThreadReviewPrompt(snapshot: PlotThreadReviewSnapshot) {
  const context = { question: snapshot.question, description: snapshot.description, notes: snapshot.notes, checks: snapshot.checks,
    evidence: snapshot.evidence.map(item => ({ evidenceId: item.id, stage: item.stage, label: item.source.label, text: item.source.text })) };
  const prompt = interpolatePromptByKey('plot-thread-review', { context: JSON.stringify(context) });
  const budget = proposalContextBudget([]);
  // Reserve the actual 4096-token review output and the existing safety margin.
  const maxPromptBytes = Math.min(64000, budget.maxPromptBytes - (4096 - budget.maxOutputTokens));
  if (Buffer.byteLength(prompt) > maxPromptBytes) throw new DocumentError('DOCUMENT_CONTEXT_TOO_LARGE', 'Complete thread review exceeds the model context budget. Shorten notes or link smaller excerpts.', 413);
  return prompt;
}
