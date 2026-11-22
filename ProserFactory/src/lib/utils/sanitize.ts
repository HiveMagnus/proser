// Utility to sanitize strings for display/storage
// - Strips surrounding emphasis/quote/bracket pairs like **name**, *name*, "name"
// - Trims stray leading/trailing punctuation and whitespace
export function stripSurroundingMarkup(input: string): string {
  if (typeof input !== 'string') return input as unknown as string;
  let s = input.trim();
  if (!s) return s;

  const pairs: Array<[string, string]> = [
    ['**', '**'], ['*', '*'], ['__', '__'], ['_', '_'],
    ['“', '”'], ['"', '"'], ['‘', '’'], ["'", "'"],
    ['《', '》'], ['〈', '〉'], ['«', '»'], ['‹', '›'],
    ['[', ']'], ['(', ')'], ['{', '}'], ['<', '>'], ['`', '`']
  ];

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10 && s.length > 1) {
    changed = false;
    for (const [open, close] of pairs) {
      if (s.startsWith(open) && s.endsWith(close) && s.length >= open.length + close.length + 1) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
      }
    }
  }
  // Remove stray leading/trailing punctuation and whitespace
  s = s.replace(/^[~!@#$%^&*_+=`\"“”'‘’\[\](){},.<>:;…·•\-\s]+/, '')
       .replace(/[~!@#$%^&*_+=`\"“”'‘’\[\](){},.<>:;…·•\-\s]+$/, '');
  return s;
}
