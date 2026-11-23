/**
 * Accept only a same-origin absolute path as a post-sign-in destination.
 * Browsers treat a backslash like a slash and ignore tab and newline
 * characters in URLs, so "/\\host" and "/\t/host" would leave the site.
 */
export function safeCallbackPath(value: string | undefined | null): string {
  const path = String(value ?? '');
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (character === '\\' || code < 0x20 || code === 0x7f) return '/';
  }
  return path;
}
