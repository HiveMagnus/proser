import { describe, expect, it } from 'vitest';

import { isGitHubAccountAllowed, parseGitHubAllowedIds } from '@/lib/github-allow-list';

describe('GitHub sign-in allow-list', () => {
  it('accepts only listed numeric account IDs', () => {
    const allowed = parseGitHubAllowedIds(' 1001, 2002 ,');
    expect(isGitHubAccountAllowed('1001', allowed)).toBe(true);
    expect(isGitHubAccountAllowed('2002', allowed)).toBe(true);
    expect(isGitHubAccountAllowed('3003', allowed)).toBe(false);
  });

  it('denies every account when the list is unset or empty', () => {
    for (const value of [undefined, '', ' , ']) {
      const allowed = parseGitHubAllowedIds(value);
      expect(allowed.size).toBe(0);
      expect(isGitHubAccountAllowed('1001', allowed)).toBe(false);
    }
  });

  it('ignores logins, wildcards and malformed entries', () => {
    const allowed = parseGitHubAllowedIds('octocat,*,-5,0,12ab,1001');
    expect([...allowed]).toEqual(['1001']);
    expect(isGitHubAccountAllowed('octocat', allowed)).toBe(false);
    expect(isGitHubAccountAllowed(undefined, allowed)).toBe(false);
    expect(isGitHubAccountAllowed(1001, allowed)).toBe(false);
  });
});
