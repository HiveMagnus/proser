export const MOBILE_VIEW_COOKIE = 'proser-view';

export type MobileViewPreference = 'auto' | 'desktop';

export function isMobilePath(pathname: string): boolean {
  return pathname === '/m' || pathname.startsWith('/m/');
}

export function isPhoneUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const isTablet = /(ipad|tablet|playbook|silk)|(android(?!.*mobile))/i.test(ua);
  if (isTablet) return false;
  return /(iphone|ipod|android.*mobile|windows phone|blackberry|bb10|opera mini|mobile)/i.test(ua);
}

export function getMobileRoute(pathname: string): string {
  if (isMobilePath(pathname)) return pathname;
  if (pathname === '/') return '/m';
  if (pathname === '/manuscript') return '/m/studio';
  if (pathname === '/plot') return '/m/plot';
  if (pathname === '/editorial/campaigns') return '/m/editorial/campaigns';
  if (pathname === '/editorial') return '/m/editorial';
  if (pathname === '/publish') return '/m/read';
  return '/m/not-found';
}

export function shouldRedirectToMobile(params: {
  pathname: string;
  userAgent: string;
  preference?: string | null;
}): boolean {
  const { pathname, userAgent, preference } = params;
  if (isMobilePath(pathname)) return false;
  if (preference === 'desktop') return false;
  return isPhoneUserAgent(userAgent);
}
