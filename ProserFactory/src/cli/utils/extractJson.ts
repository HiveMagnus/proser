/**
 * Extract JSON from AI-generated text that may contain markdown fences or commentary.
 * @module cli/utils/extractJson
 */

/**
 * Extract and parse JSON from a string that may contain markdown code fences or surrounding prose.
 *
 * Tries (in order):
 * 1. Fenced ```json ... ``` blocks
 * 2. First balanced `{...}` or `[...]` block
 *
 * @returns Parsed JSON value, or null if extraction/parsing fails.
 */
export function extractJson<T = unknown>(text: string): T | null {
  const raw = extractJsonString(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Extract the raw JSON string without parsing. */
export function extractJsonString(text: string): string | null {
  // Try fenced JSON block first
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // Find first { or [ and match to closing bracket
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const bracket = text[start];
  const close = bracket === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === bracket) depth++;
    else if (text[i] === close) depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
