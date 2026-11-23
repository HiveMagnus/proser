/**
 * Numeric GitHub account IDs permitted to sign in. IDs are used instead of
 * logins because a login can be renamed and later claimed by another account.
 */
export function parseGitHubAllowedIds(value: string | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of String(value ?? '').split(',')) {
    const id = entry.trim();
    if (/^[1-9][0-9]{0,19}$/.test(id)) ids.add(id);
  }
  return ids;
}

export function isGitHubAccountAllowed(
  providerAccountId: unknown,
  allowed: ReadonlySet<string>,
): boolean {
  return typeof providerAccountId === 'string' && allowed.has(providerAccountId);
}
