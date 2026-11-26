/* global self, caches, Request, Response, URL, fetch */
/* Proser offline shell.
 *
 * This worker keeps only public, user-independent files: the offline page and
 * the app icons. It never stores pages, API responses or anything sent with
 * the session cookie. Pages always come from the network; when the network is
 * unreachable, a page request gets the offline page instead. Drafts stay in
 * the browser's own IndexedDB journal, which this worker does not touch.
 */
const SHELL_CACHE = 'proser-shell-v1';
const OFFLINE_URL = '/offline.html';
const SHELL_FILES = [OFFLINE_URL, '/icon.svg', '/apple-icon', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        cache.addAll(
          SHELL_FILES.map(
            (url) => new Request(url, { credentials: 'omit', cache: 'reload', redirect: 'error' }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('proser-') && key !== SHELL_CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
    // No clients.claim(): pages that are already open stay uncontrolled until
    // their next navigation, so a running session never changes under them.
  );
});

/** Requests this worker answers: same-origin GETs for a page or a shell file.
 * Everything else, including every /api/ and /auth request, goes straight to
 * the network without the worker. */
function handledRequest(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/auth')
  )
    return null;
  if (request.mode === 'navigate') return 'page';
  if (SHELL_FILES.includes(url.pathname) && !url.search) return 'shell';
  return null;
}

self.addEventListener('fetch', (event) => {
  const kind = handledRequest(event.request);
  if (kind === 'page') {
    // Never cached: a page carries the session and a per-request script nonce.
    event.respondWith(
      fetch(event.request).catch(() =>
        caches
          .match(OFFLINE_URL, { cacheName: SHELL_CACHE })
          .then((offline) => offline || Response.error()),
      ),
    );
  } else if (kind === 'shell') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches
          .match(event.request, { cacheName: SHELL_CACHE, ignoreSearch: false })
          .then((cached) => cached || Response.error()),
      ),
    );
  }
});
