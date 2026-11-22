export function normalizeCandidate(value: string): string {
  return value
    .normalize('NFC')
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^\s*(?:replacement|revised passage|answer)\s*:\s*/i, '')
    .trim();
}
