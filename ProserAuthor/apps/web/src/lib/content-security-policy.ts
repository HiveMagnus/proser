/**
 * The page Content Security Policy. Scripts run only from this origin and
 * with the per-request nonce that Next.js adds to its own inline scripts, so
 * markup that reaches the page from imported documents or generated text
 * cannot run script. Pages talk only to this origin; the stylesheet and font
 * hosts are the ones the root layout links.
 */
export function contentSecurityPolicy(nonce: string, development = false): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    'style-src': [
      "'self'",
      "'unsafe-inline'",
      'https://fonts.googleapis.com',
      'https://api.fontshare.com',
    ],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.fontshare.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https://avatars.githubusercontent.com'],
    'connect-src': ["'self'", ...(development ? ['ws:', 'wss:'] : [])],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
