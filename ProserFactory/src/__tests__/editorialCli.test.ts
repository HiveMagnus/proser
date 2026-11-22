import { readFileSync } from 'node:fs';

import { parseEditorialScope } from '@/cli/editorialScope';

describe('editorial CLI contract', () => {
  it.each([
    ['book', { type: 'book' }],
    ['act:2', { type: 'act', id: 2 }],
    ['chapter:17', { type: 'chapter', id: 17 }],
    ['scene:41', { type: 'scene', id: 41 }],
  ])('parses bounded scope %s', (value, expected) => {
    expect(parseEditorialScope(value)).toEqual(expected);
  });

  it.each(['chapter', 'scene:0', 'volume:2', 'act:nope'])('rejects invalid scope %s', (value) => {
    expect(() => parseEditorialScope(value)).toThrow();
  });

  it('registers the single editorial command family', () => {
    const source = readFileSync('src/cli/commands/editorial.ts', 'utf8');
    expect(source).toContain("command: 'editorial <action> [id]'");
    expect(source).toContain("'optimize'");
    expect(source).toContain("'benchmark-run'");
    expect(source).toContain("if (!argv.apply || !argv.id || !argv.candidate)");
  });
});
