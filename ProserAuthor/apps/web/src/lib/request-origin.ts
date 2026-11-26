const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',', 1)[0]?.trim().toLowerCase();
  return first || null;
}

/**
 * Whether a state-changing request came from a Proser page.
 *
 * The session cookie is `SameSite=Lax`, so a page on a sibling host under the
 * same parent domain can still submit a form that carries it. Unsafe methods
 * must therefore name a Proser origin: the configured `AUTH_URL` or
 * `NEXTAUTH_URL`, or the host the request was addressed to. Browsers send
 * `Origin` on every cross-origin and same-origin POST, PUT, PATCH and DELETE;
 * when it is absent, `Sec-Fetch-Site` must not report another site. Requests
 * with neither header come from clients that cannot hold a browser's cookies.
 */
export function unsafeRequestFromAllowedOrigin(
  method: string,
  headers: Headers,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const origin = headers.get('origin');
  if (origin !== null) {
    const parsed = originOf(origin);
    if (!parsed) return false;
    const configured = [originOf(environment.AUTH_URL), originOf(environment.NEXTAUTH_URL)];
    if (configured.includes(parsed)) return true;
    const requestHosts = [
      firstHeaderValue(headers.get('x-forwarded-host')),
      firstHeaderValue(headers.get('host')),
    ].filter(Boolean);
    return requestHosts.includes(new URL(parsed).host.toLowerCase());
  }
  const fetchSite = headers.get('sec-fetch-site')?.toLowerCase();
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';
}
