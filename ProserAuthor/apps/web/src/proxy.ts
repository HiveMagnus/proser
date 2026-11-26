import { auth } from './auth';
import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, createNonce } from './lib/content-security-policy';
import { getMobileRoute, MOBILE_VIEW_COOKIE, shouldRedirectToMobile } from './lib/mobile-routing';

/**
 * Continue to the page with a fresh script nonce. Next.js reads the nonce from
 * the request's Content-Security-Policy header and adds it to the scripts it
 * renders; the same policy goes on the response.
 */
function nextWithContentSecurityPolicy(req: NextRequest): NextResponse {
  const nonce = createNonce();
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Allow public paths (auth pages, static assets, NextAuth API, backend API proxy)
  if (
    pathname.startsWith('/auth') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    // Browsers fetch the install manifest and its icons without the session cookie.
    pathname === '/manifest.webmanifest' ||
    pathname === '/icon.svg' ||
    pathname === '/apple-icon'
  ) {
    return pathname.startsWith('/auth') ? nextWithContentSecurityPolicy(req) : NextResponse.next();
  }

  // If not authenticated, redirect to sign-in
  if (!req.auth) {
    const signInUrl = new URL('/auth/signin', req.url);
    signInUrl.searchParams.set('callbackUrl', `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(signInUrl);
  }

  const mobilePreference = req.cookies.get(MOBILE_VIEW_COOKIE)?.value ?? null;
  const userAgent = req.headers.get('user-agent') ?? '';
  if (shouldRedirectToMobile({ pathname, userAgent, preference: mobilePreference })) {
    const mobileUrl = req.nextUrl.clone();
    mobileUrl.pathname = getMobileRoute(pathname);
    return NextResponse.redirect(mobileUrl);
  }

  return nextWithContentSecurityPolicy(req);
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
