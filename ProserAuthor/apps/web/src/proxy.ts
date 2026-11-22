import { auth } from './auth';
import { NextResponse } from 'next/server';
import { getMobileRoute, MOBILE_VIEW_COOKIE, shouldRedirectToMobile } from './lib/mobile-routing';

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Allow public paths (auth pages, static assets, NextAuth API, backend API proxy)
  if (
    pathname.startsWith('/auth') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
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

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
