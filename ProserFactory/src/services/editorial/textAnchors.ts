import { createHash } from 'node:crypto';

export const textHash = (text: string) => createHash('sha256').update(text).digest('hex');

export interface TextToken {
  text: string;
  normalized: string;
  start: number;
  end: number;
}

export function tokenize(text: string): TextToken[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu)].map((match) => ({
    text: match[0],
    normalized: match[0].normalize('NFKC').toLocaleLowerCase('en-US').replace(/[’']/g, "'"),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

const abbreviations = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'vs.', 'etc.', 'e.g.', 'i.e.']);

export function sentences(text: string): Array<{ text: string; start: number; end: number }> {
  const results: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[.!?…]/.test(text[index])) continue;
    const prefix = text.slice(Math.max(start, index - 8), index + 1).trim().toLocaleLowerCase('en-US');
    if ([...abbreviations].some((item) => prefix.endsWith(item))) continue;
    let end = index + 1;
    while (end < text.length && /[.!?…”’"')\]]/.test(text[end])) end += 1;
    if (end < text.length && !/\s/.test(text[end])) continue;
    const value = text.slice(start, end).trim();
    const leading = text.slice(start, end).search(/\S/);
    if (value) {
      const actualStart = start + Math.max(0, leading);
      results.push({ text: value, start: actualStart, end: actualStart + value.length });
    }
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) {
    const leading = text.slice(start).search(/\S/);
    const actualStart = start + Math.max(0, leading);
    results.push({ text: tail, start: actualStart, end: actualStart + tail.length });
  }
  return results;
}

export function paragraphs(text: string): Array<{ text: string; start: number; end: number }> {
  const output: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  for (const separator of text.matchAll(/\n[^\S\n]*\n/g)) {
    const raw = text.slice(cursor, separator.index);
    const value = raw.trim();
    if (value) {
      const start = cursor + raw.search(/\S/);
      output.push({ text: value, start, end: start + value.length });
    }
    cursor = (separator.index ?? 0) + separator[0].length;
  }
  const raw = text.slice(cursor);
  const value = raw.trim();
  if (value) {
    const start = cursor + raw.search(/\S/);
    output.push({ text: value, start, end: start + value.length });
  }
  return output;
}

export function anchors(text: string, start: number, end: number, size = 80) {
  if (start < 0 || end < start || end > text.length) throw new Error('Invalid editorial text offsets');
  return {
    sourceHash: textHash(text.slice(start, end)),
    beforeAnchor: text.slice(Math.max(0, start - size), start),
    afterAnchor: text.slice(end, Math.min(text.length, end + size)),
  };
}

export function resolveAnchor(text: string, input: {
  originalText: string;
  sourceHash: string;
  startOffset: number;
  endOffset: number;
  beforeAnchor?: string | null;
  afterAnchor?: string | null;
}): { start: number; end: number } | null {
  const exact = text.slice(input.startOffset, input.endOffset);
  if (exact === input.originalText && textHash(exact) === input.sourceHash) return { start: input.startOffset, end: input.endOffset };
  const matches: number[] = [];
  let cursor = text.indexOf(input.originalText);
  while (cursor >= 0 && matches.length < 3) {
    const before = input.beforeAnchor ? text.slice(Math.max(0, cursor - input.beforeAnchor.length), cursor) === input.beforeAnchor : true;
    const afterStart = cursor + input.originalText.length;
    const after = input.afterAnchor ? text.slice(afterStart, afterStart + input.afterAnchor.length) === input.afterAnchor : true;
    if (before && after) matches.push(cursor);
    cursor = text.indexOf(input.originalText, cursor + 1);
  }
  return matches.length === 1 ? { start: matches[0], end: matches[0] + input.originalText.length } : null;
}
