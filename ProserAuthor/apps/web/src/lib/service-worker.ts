/** Register the offline-shell worker (`public/sw.js`). Only production builds
 * on a secure origin register it, so development reloads are never served by a
 * stale worker. Automated browsers (`navigator.webdriver`) skip it: acceptance
 * harnesses guard requests at the browser's network layer, which requests from
 * a controlled page would bypass. The worker keeps no pages or API responses. */
export function registerServiceWorker(
  environment: string | undefined = process.env.NODE_ENV,
  scope: {
    isSecureContext?: boolean;
    navigator?: { serviceWorker?: Pick<ServiceWorkerContainer, 'register'>; webdriver?: boolean };
  } = typeof window === 'undefined' ? {} : window,
): Promise<unknown> | null {
  const container = scope.navigator?.serviceWorker;
  if (
    environment !== 'production' ||
    !scope.isSecureContext ||
    !container ||
    scope.navigator?.webdriver
  )
    return null;
  return container
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .catch(() => undefined);
}
