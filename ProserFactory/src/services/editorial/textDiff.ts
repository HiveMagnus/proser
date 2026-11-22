import { tokenize } from './textAnchors';

export function changedWordCount(before: string, after: string): number {
  const left = tokenize(before).map((item) => item.normalized);
  const right = tokenize(after).map((item) => item.normalized);
  const previous = new Uint32Array(right.length + 1);
  const current = new Uint32Array(right.length + 1);
  for (const token of left) {
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = token === right[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    previous.set(current);
    current.fill(0);
  }
  return Math.max(left.length, right.length) - previous[right.length];
}

export function changedPercent(before: string, after: string): number {
  const base = Math.max(1, tokenize(before).length);
  return Math.round(changedWordCount(before, after) / base * 10_000) / 100;
}

export function applyPatch(text: string, start: number, end: number, replacement: string): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}
