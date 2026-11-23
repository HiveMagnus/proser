import { describe, expect, it } from 'vitest';

import { safeCallbackPath } from '@/lib/safe-callback-path';

describe('sign-in callback path', () => {
  it('keeps same-origin paths', () => {
    expect(safeCallbackPath('/manuscript?book=3#scene')).toBe('/manuscript?book=3#scene');
    expect(safeCallbackPath('/m/studio')).toBe('/m/studio');
  });

  it.each([
    undefined,
    '',
    'https://attacker.example',
    '//attacker.example',
    '/\\attacker.example',
    '/\t/attacker.example',
    '/\n/attacker.example',
    'javascript:alert(1)',
  ])('falls back to the home page for %j', (value) => {
    expect(safeCallbackPath(value)).toBe('/');
  });
});
