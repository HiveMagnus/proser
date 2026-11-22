/**
 * Strip hidden reasoning / chain-of-thought sections from LLM outputs.
 * Targets common patterns used by models to wrap internal thoughts:
 * - <think>...</think>, <thinking>...</thinking>, <analysis>...</analysis>, etc.
 * - [think]...[/think] style BBCode blocks
 * - Fenced code blocks labelled with think/thoughts/analysis/reasoning/cot
 * - Single-line prefixes like "Thought:", "Thinking:", "Analysis:", etc.
 *
 * The function is conservative to avoid damaging normal content and is idempotent.
 */
export function stripThinkingBlocks(input: string): string {
  if (!input) return '';
  let out = input;

  // 1) Angle-bracket tag blocks (case-insensitive, allow variations)
  const tagPattern = /<\s*(think|thinking|analysis|reasoning|scratchpad|cot|chain[-_\s]*of[-_\s]*thought)\s*>[\s\S]*?<\s*\/\s*(?:think|thinking|analysis|reasoning|scratchpad|cot|chain[-_\s]*of[-_\s]*thought)\s*>/gi;
  out = out.replace(tagPattern, '');

  // 2) BBCode-like [think]...[/think]
  const bbcodePattern = /\[\s*(?:think|thinking|analysis|reasoning|scratchpad|cot)\s*\][\s\S]*?\[\s*\/\s*(?:think|thinking|analysis|reasoning|scratchpad|cot)\s*\]/gi;
  out = out.replace(bbcodePattern, '');

  // 3) Fenced code blocks labelled with reasoning/think variants
  const fencePattern = /```\s*(?:think|thinking|analysis|reasoning|thoughts?|cot)[^\n]*\n[\s\S]*?```/gi;
  out = out.replace(fencePattern, '');

  // 3b) Any fenced block that contains <think> ... as an extra safeguard
  const fenceWithThink = /```[^`]*<\s*(?:think|thinking|analysis|reasoning|cot)[\s\S]*?<\s*\/\s*(?:think|thinking|analysis|reasoning|cot)\s*>[\s\S]*?```/gi;
  out = out.replace(fenceWithThink, '');

  // 4) Single-line prefixes (remove only the labeled lines to be conservative)
  const linePrefix = /^[ \t]*(?:Thoughts?|Thinking|Reasoning|Analysis|Chain[-\s]*of[-\s]*thought|CoT)\s*:\s*.*$/gmi;
  out = out.replace(linePrefix, '');

  // Normalize consecutive blank lines to a single newline
  out = out.replace(/\n{2,}/g, '\n');
  return out.trim();
}

export default stripThinkingBlocks;
